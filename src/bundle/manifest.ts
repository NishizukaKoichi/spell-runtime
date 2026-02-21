import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import { SpellBundleManifest, SpellCheck, SpellStep, SpellStepCondition } from "../types";
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

  const maxParallelStepsRaw = runtimeRaw["max_parallel_steps"];
  const maxParallelSteps = parseOptionalMaxParallelSteps(maxParallelStepsRaw);

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
      docker_image: dockerImage,
      max_parallel_steps: maxParallelSteps
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
  const steps = rawSteps.map((entry, idx) => {
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
    const dependsOn = parseOptionalStringArray(obj["depends_on"], `steps[${idx}].depends_on`);
    const when = parseOptionalStepCondition(obj["when"], `steps[${idx}].when`);

    return {
      uses: uses as SpellStep["uses"],
      name,
      run,
      depends_on: dependsOn,
      when
    };
  });

  validateStepDependencies(steps);
  return steps;
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

function parseOptionalMaxParallelSteps(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 32) {
    throw new SpellError("runtime.max_parallel_steps must be an integer between 1 and 32");
  }

  return raw;
}

function parseOptionalStringArray(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!Array.isArray(raw)) {
    throw new SpellError(`${label} must be an array of strings`);
  }

  const out = raw.map((value, idx) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new SpellError(`${label}[${idx}] must be a non-empty string`);
    }
    return value.trim();
  });

  return out.length > 0 ? out : undefined;
}

function parseOptionalStepCondition(raw: unknown, label: string): SpellStepCondition | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SpellError(`${label} must be an object`);
  }

  const condition = raw as Record<string, unknown>;
  const allowedKeys = new Set(["input_path", "output_path", "equals", "not_equals"]);
  for (const key of Object.keys(condition)) {
    if (!allowedKeys.has(key)) {
      throw new SpellError(`${label}.${key} is not supported`);
    }
  }

  const inputPath = condition["input_path"];
  const outputPath = condition["output_path"];
  const hasInputPath = inputPath !== undefined;
  const hasOutputPath = outputPath !== undefined;
  if (hasInputPath === hasOutputPath) {
    throw new SpellError(`${label} must define exactly one of input_path or output_path`);
  }

  if (hasInputPath && (typeof inputPath !== "string" || !inputPath.trim())) {
    throw new SpellError(`${label}.input_path must be a non-empty string`);
  }
  if (hasOutputPath && (typeof outputPath !== "string" || !outputPath.trim())) {
    throw new SpellError(`${label}.output_path must be a non-empty string`);
  }

  const hasEquals = Object.prototype.hasOwnProperty.call(condition, "equals");
  const hasNotEquals = Object.prototype.hasOwnProperty.call(condition, "not_equals");
  if (!hasEquals && !hasNotEquals) {
    throw new SpellError(`${label} must define equals or not_equals`);
  }

  return {
    input_path: hasInputPath ? (inputPath as string).trim() : undefined,
    output_path: hasOutputPath ? (outputPath as string).trim() : undefined,
    equals: hasEquals ? condition["equals"] : undefined,
    not_equals: hasNotEquals ? condition["not_equals"] : undefined
  };
}

function validateStepDependencies(steps: SpellStep[]): void {
  const nameSet = new Set(steps.map((step) => step.name));
  const indexByName = new Map(steps.map((step, idx) => [step.name, idx]));
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const step of steps) {
    const deps = step.depends_on ?? [];
    const seenDeps = new Set<string>();
    for (const dep of deps) {
      if (!nameSet.has(dep)) {
        throw new SpellError(`step '${step.name}' depends_on unknown step '${dep}'`);
      }
      if (dep === step.name) {
        throw new SpellError(`step '${step.name}' depends_on must not include itself`);
      }
      if (seenDeps.has(dep)) {
        throw new SpellError(`step '${step.name}' has duplicate depends_on '${dep}'`);
      }
      seenDeps.add(dep);
      const list = dependents.get(dep) ?? [];
      list.push(step.name);
      dependents.set(dep, list);
    }

    if (step.when?.output_path) {
      const match = /^step\.([^.]+)\.(stdout|json)(?:\..+)?$/.exec(step.when.output_path);
      if (!match) {
        throw new SpellError(`step '${step.name}' when.output_path is invalid: ${step.when.output_path}`);
      }
      const sourceStep = match[1];
      if (!nameSet.has(sourceStep)) {
        throw new SpellError(`step '${step.name}' when.output_path references unknown step '${sourceStep}'`);
      }
      if (!seenDeps.has(sourceStep)) {
        throw new SpellError(`step '${step.name}' when.output_path requires depends_on '${sourceStep}'`);
      }
    }

    inDegree.set(step.name, deps.length);
  }

  const queue = steps.filter((step) => (inDegree.get(step.name) ?? 0) === 0).map((step) => step.name);
  let visited = 0;

  while (queue.length > 0) {
    queue.sort((a, b) => (indexByName.get(a) ?? 0) - (indexByName.get(b) ?? 0));
    const current = queue.shift() as string;
    visited += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (visited !== steps.length) {
    throw new SpellError("steps contains cyclic depends_on references");
  }
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
