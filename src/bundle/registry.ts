import { mkdir, readFile, writeFile } from "node:fs/promises";
import Ajv2020, { type AnySchema } from "ajv/dist/2020";
import { SpellError } from "../util/errors";
import { fetchHttp } from "../util/http";
import { registryConfigPath, spellHome } from "../util/paths";

export interface RegistryIndexRef {
  name: string;
  url: string;
}

export interface RegistryConfigV1 {
  version: "v1";
  indexes: RegistryIndexRef[];
}

export interface RegistrySpellEntry {
  id: string;
  version: string;
  source: string;
  commit?: string;
}

export interface RegistryIndexV1 {
  version: "v1";
  spells: RegistrySpellEntry[];
}

export interface RegistryInstallRef {
  id: string;
  version: string;
}

export interface RegistryInstallSource {
  source: string;
  expectedCommit?: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

const registryConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "indexes"],
  properties: {
    version: { const: "v1" },
    indexes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "url"],
        properties: {
          name: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

const registryIndexSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "spells"],
  properties: {
    version: { const: "v1" },
    spells: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "version", "source"],
        properties: {
          id: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          source: { type: "string", minLength: 1 },
          commit: { type: "string", pattern: "^[0-9a-fA-F]{40}$" }
        }
      }
    }
  }
} as const;

const validateRegistryConfig = ajv.compile(registryConfigSchema as AnySchema);
const validateRegistryIndex = ajv.compile(registryIndexSchema as AnySchema);
const PINNED_GIT_SOURCE_PATTERN = /^(?:https:\/\/.+|ssh:\/\/.+|git@[^:]+:.+)#.+$/i;

export async function setDefaultRegistryIndex(rawUrl: string): Promise<RegistryConfigV1> {
  const url = normalizeHttpUrl(rawUrl, "registry URL");
  const config: RegistryConfigV1 = {
    version: "v1",
    indexes: [{ name: "default", url }]
  };

  await mkdir(spellHome(), { recursive: true });
  await writeFile(registryConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function readRegistryConfig(): Promise<RegistryConfigV1> {
  let raw: string;
  try {
    raw = await readFile(registryConfigPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpellError(
        `registry config not found: ${registryConfigPath()} (run 'spell registry set <url>' first)`
      );
    }

    throw new SpellError(`failed to read registry config '${registryConfigPath()}': ${(error as Error).message}`);
  }

  return parseRegistryConfigJson(raw, registryConfigPath());
}

export async function readRegistryConfigIfExists(): Promise<RegistryConfigV1 | null> {
  try {
    const raw = await readFile(registryConfigPath(), "utf8");
    return parseRegistryConfigJson(raw, registryConfigPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw new SpellError(
      `failed to read registry config '${registryConfigPath()}': ${(error as Error).message}`
    );
  }
}

export function parseRegistryConfigJson(raw: string, source: string): RegistryConfigV1 {
  const parsed = parseJson(raw, "registry config", source);
  const ok = validateRegistryConfig(parsed);
  if (!ok) {
    throw new SpellError(`registry config validation failed: ${formatAjvErrors(validateRegistryConfig.errors ?? [])}`);
  }

  const config = parsed as RegistryConfigV1;
  for (const index of config.indexes) {
    normalizeHttpUrl(index.url, `registry index URL (${index.name})`);
  }

  return config;
}

export function parseRegistryIndexJson(raw: string, source: string): RegistryIndexV1 {
  const parsed = parseJson(raw, "registry index", source);
  const ok = validateRegistryIndex(parsed);
  if (!ok) {
    throw new SpellError(`registry index validation failed: ${formatAjvErrors(validateRegistryIndex.errors ?? [])}`);
  }

  return parsed as RegistryIndexV1;
}

export function parseRegistryInstallRef(value: string): RegistryInstallRef {
  if (!value.startsWith("registry:")) {
    throw new SpellError(`invalid registry source: ${value} (expected registry:<id>@<version>)`);
  }

  const body = value.slice("registry:".length);
  const atIndex = body.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === body.length - 1) {
    throw new SpellError(`invalid registry source: ${value} (expected registry:<id>@<version>)`);
  }

  const id = body.slice(0, atIndex).trim();
  const version = body.slice(atIndex + 1).trim();
  if (!id || !version) {
    throw new SpellError(`invalid registry source: ${value} (expected registry:<id>@<version>)`);
  }

  return { id, version };
}

export function resolveRegistryEntry(index: RegistryIndexV1, id: string, version: string): RegistrySpellEntry {
  const found = index.spells.find((spell) => spell.id === id && spell.version === version);
  if (!found) {
    throw new SpellError(`registry entry not found: ${id}@${version}`);
  }
  return found;
}

export async function resolveRegistryInstallSource(sourceInput: string): Promise<RegistryInstallSource> {
  const parsed = parseRegistryInstallRef(sourceInput);
  const config = await readRegistryConfig();
  const defaultIndex = config.indexes.find((index) => index.name === "default");
  if (!defaultIndex) {
    throw new SpellError(`registry config missing default index (run 'spell registry set <url>' first)`);
  }

  const index = await fetchRegistryIndex(defaultIndex.url);
  const entry = resolveRegistryEntry(index, parsed.id, parsed.version);
  const source = entry.source.trim();
  if (!PINNED_GIT_SOURCE_PATTERN.test(source)) {
    throw new SpellError(
      `invalid registry source for ${parsed.id}@${parsed.version}: expected '<git-url>#<ref>', got '${entry.source}'`
    );
  }

  return {
    source,
    expectedCommit: entry.commit
  };
}

async function fetchRegistryIndex(url: string): Promise<RegistryIndexV1> {
  let response: Awaited<ReturnType<typeof fetchHttp>>;
  try {
    response = await fetchHttp(url);
  } catch (error) {
    throw new SpellError(`failed to fetch registry index '${url}': ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new SpellError(`failed to fetch registry index '${url}': HTTP ${response.status}`);
  }

  const raw = await response.text();
  return parseRegistryIndexJson(raw, url);
}

function parseJson(raw: string, kind: string, source: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`failed to parse ${kind} JSON (${source}): ${(error as Error).message}`);
  }
}

function formatAjvErrors(errors: Array<{ instancePath?: string; message?: string }>): string {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`.trim()).join("; ");
}

function normalizeHttpUrl(rawValue: string, label: string): string {
  const value = rawValue.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SpellError(`invalid ${label}: ${rawValue}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SpellError(`invalid ${label}: ${rawValue}`);
  }

  return parsed.toString();
}
