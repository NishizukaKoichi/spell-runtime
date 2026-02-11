import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import { SpellBundleManifest, SpellCheck, SpellStep } from "../types";
import { SpellError } from "../util/errors";

const RISK_VALUES = new Set(["low", "medium", "high", "critical"]);
const EXECUTION_VALUES = new Set(["host", "docker"]);
const STEP_VALUES = new Set(["shell", "http"]);
const CHECK_VALUES = new Set(["exit_code", "file_exists", "http_status", "jsonpath_equals"]);
const BILLING_MODES = new Set(["none", "upfront", "on_success", "subscription"]);

export async function loadManifestFromDir(bundlePath: string): Promise<{ manifest: SpellBundleManifest; schemaPath: string }> {
  const manifestPath = path.join(bundlePath, "spell.yaml");

  let rawYaml: string;
  try {
    rawYaml = await readFile(manifestPath, "utf8");
  } catch {
    throw new SpellError(`spell.yaml not found: ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = load(rawYaml);
  } catch (error) {
    throw new SpellError(`failed to parse spell.yaml: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("spell.yaml must be a mapping object");
  }

  const manifest = parsed as Record<string, unknown>;

  const id = readRequiredString(manifest, "id");
  const version = readRequiredString(manifest, "version");
  const name = readRequiredString(manifest, "name");
  const summary = readRequiredString(manifest, "summary");
  const inputsSchema = readRequiredString(manifest, "inputs_schema");

  validateId(id);
  validateVersion(version);

  const risk = readRequiredString(manifest, "risk");
  if (!RISK_VALUES.has(risk)) {
    throw new SpellError(`invalid risk: ${risk}`);
  }

  const permissionsRaw = readRequiredArray(manifest, "permissions");
  const permissions = permissionsRaw.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SpellError(`permissions[${idx}] must be an object`);
    }

    const obj = entry as Record<string, unknown>;
    const connector = readRequiredString(obj, "connector");
    const scopes = readRequiredArray(obj, "scopes").map((scope, scopeIdx) => {
      if (typeof scope !== "string" || !scope.trim()) {
        throw new SpellError(`permissions[${idx}].scopes[${scopeIdx}] must be a non-empty string`);
      }
      return scope;
    });

    if (scopes.length === 0) {
      throw new SpellError(`permissions[${idx}].scopes must not be empty`);
    }

    return { connector, scopes };
  });

  const effectsRaw = readRequiredArray(manifest, "effects");
  const effects = effectsRaw.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SpellError(`effects[${idx}] must be an object`);
    }

    const obj = entry as Record<string, unknown>;
    const type = readRequiredString(obj, "type");
    const target = readRequiredString(obj, "target");
    const mutates = readRequiredBoolean(obj, "mutates");

    return { type, target, mutates };
  });

  const billingRaw = readRequiredObject(manifest, "billing");
  const billingEnabled = readRequiredBoolean(billingRaw, "enabled");
  const billingMode = readRequiredString(billingRaw, "mode");
  const currency = readRequiredString(billingRaw, "currency");
  const maxAmount = readRequiredNumber(billingRaw, "max_amount");

  if (!BILLING_MODES.has(billingMode)) {
    throw new SpellError(`invalid billing.mode: ${billingMode}`);
  }

  const runtimeRaw = readRequiredObject(manifest, "runtime");
  const execution = readRequiredString(runtimeRaw, "execution");
  if (!EXECUTION_VALUES.has(execution)) {
    throw new SpellError(`invalid runtime.execution: ${execution}`);
  }

  const platforms = readRequiredArray(runtimeRaw, "platforms").map((platformValue, idx) => {
    if (typeof platformValue !== "string" || !platformValue.trim()) {
      throw new SpellError(`runtime.platforms[${idx}] must be a non-empty string`);
    }
    return platformValue;
  });

  const dockerImageRaw = runtimeRaw["docker_image"];
  const dockerImage = typeof dockerImageRaw === "string" && dockerImageRaw.trim() ? dockerImageRaw : undefined;
  if (execution === "docker" && !dockerImage) {
    throw new SpellError("runtime.docker_image is required when runtime.execution=docker");
  }

  const steps = parseSteps(readRequiredArray(manifest, "steps"));
  const checks = parseChecks(readRequiredArray(manifest, "checks"));

  const schemaPath = resolveInputsSchema(bundlePath, inputsSchema);
  await access(schemaPath);

  await access(path.join(bundlePath, "schema.json"));

  const stepsDirPath = path.join(bundlePath, "steps");
  const stepsDirStat = await stat(stepsDirPath);
  if (!stepsDirStat.isDirectory()) {
    throw new SpellError("steps/ must be a directory");
  }

  for (const step of steps) {
    const runPath = path.resolve(bundlePath, step.run);
    ensurePathWithin(bundlePath, runPath, `step '${step.name}' run path`);
    await access(runPath);
  }

  const typedManifest: SpellBundleManifest = {
    id,
    version,
    name,
    summary,
    inputs_schema: inputsSchema,
    risk: risk as SpellBundleManifest["risk"],
    permissions,
    effects,
    billing: {
      enabled: billingEnabled,
      mode: billingMode as SpellBundleManifest["billing"]["mode"],
      currency,
      max_amount: maxAmount
    },
    runtime: {
      execution: execution as SpellBundleManifest["runtime"]["execution"],
      platforms,
      docker_image: dockerImage
    },
    steps,
    checks
  };

  return { manifest: typedManifest, schemaPath };
}

function parseSteps(rawSteps: unknown[]): SpellStep[] {
  if (rawSteps.length === 0) {
    throw new SpellError("steps must not be empty");
  }

  const seenNames = new Set<string>();

  return rawSteps.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SpellError(`steps[${idx}] must be an object`);
    }

    const obj = entry as Record<string, unknown>;
    const uses = readRequiredString(obj, "uses");
    if (!STEP_VALUES.has(uses)) {
      throw new SpellError(`invalid steps[${idx}].uses: ${uses}`);
    }

    const name = readRequiredString(obj, "name");
    if (seenNames.has(name)) {
      throw new SpellError(`duplicate step name: ${name}`);
    }
    seenNames.add(name);

    const run = readRequiredString(obj, "run");

    return {
      uses: uses as SpellStep["uses"],
      name,
      run
    };
  });
}

function parseChecks(rawChecks: unknown[]): SpellCheck[] {
  if (rawChecks.length === 0) {
    throw new SpellError("checks must not be empty");
  }

  return rawChecks.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SpellError(`checks[${idx}] must be an object`);
    }

    const obj = entry as Record<string, unknown>;
    const type = readRequiredString(obj, "type");
    if (!CHECK_VALUES.has(type)) {
      throw new SpellError(`invalid checks[${idx}].type: ${type}`);
    }

    const paramsRaw = obj["params"];
    const params = paramsRaw && typeof paramsRaw === "object" && !Array.isArray(paramsRaw)
      ? (paramsRaw as Record<string, unknown>)
      : {};

    return {
      type: type as SpellCheck["type"],
      params
    };
  });
}

function resolveInputsSchema(bundlePath: string, inputSchemaPath: string): string {
  if (!inputSchemaPath.trim()) {
    throw new SpellError("inputs_schema must not be empty");
  }

  const resolved = path.resolve(bundlePath, inputSchemaPath);
  ensurePathWithin(bundlePath, resolved, "inputs_schema");

  if (path.basename(resolved) !== "schema.json") {
    throw new SpellError("inputs_schema must point to schema.json in v1");
  }

  return resolved;
}

function ensurePathWithin(root: string, target: string, label: string): void {
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SpellError(`${label} escapes bundle root`);
  }
}

function validateId(id: string): void {
  if (!id.trim()) {
    throw new SpellError("id must not be empty");
  }

  if (id.length > 200) {
    throw new SpellError("id must be <= 200 characters");
  }

  if (/[\x00-\x1F\x7F]/.test(id)) {
    throw new SpellError("id must not contain control characters");
  }
}

function validateVersion(version: string): void {
  if (!version.trim()) {
    throw new SpellError("version must not be empty");
  }

  if (version.length > 50) {
    throw new SpellError("version must be <= 50 characters");
  }

  if (/[\x00-\x1F\x7F]/.test(version)) {
    throw new SpellError("version must not contain control characters");
  }
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new SpellError(`missing or invalid string field: ${key}`);
  }
  if (!value.trim()) {
    throw new SpellError(`field must not be empty: ${key}`);
  }
  return value;
}

function readRequiredNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SpellError(`missing or invalid number field: ${key}`);
  }
  return value;
}

function readRequiredBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new SpellError(`missing or invalid boolean field: ${key}`);
  }
  return value;
}

function readRequiredArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new SpellError(`missing or invalid array field: ${key}`);
  }
  return value;
}

function readRequiredObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpellError(`missing or invalid object field: ${key}`);
  }
  return value as Record<string, unknown>;
}
