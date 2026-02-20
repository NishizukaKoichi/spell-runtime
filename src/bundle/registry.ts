import { mkdir, readFile, writeFile } from "node:fs/promises";
import Ajv2020, { type AnySchema } from "ajv/dist/2020";
import { SpellError } from "../util/errors";
import { fetchHttp } from "../util/http";
import { registryConfigPath, spellHome } from "../util/paths";
import { selectLatestVersion } from "../util/version";

export interface RegistryIndexRef {
  name: string;
  url: string;
}

export interface RegistryConfigV1 {
  version: "v1";
  indexes: RegistryIndexRef[];
}

export interface RegistryValidationResult {
  name: string;
  url: string;
  spellCount: number;
}

export interface RegistrySpellEntry {
  id: string;
  version: string;
  source: string;
  commit?: string;
  digest?: string;
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
  id: string;
  version: string;
  registryName: string;
  registryUrl: string;
  source: string;
  expectedCommit?: string;
  expectedDigest?: string;
}

export type RegistryRequiredPinsPolicy = "none" | "commit" | "digest" | "both";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const REGISTRY_REQUIRED_PINS_ENV = "SPELL_REGISTRY_REQUIRED_PINS";
export const DEFAULT_REGISTRY_REQUIRED_PINS: RegistryRequiredPinsPolicy = "both";

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
          commit: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
          digest: { type: "string", pattern: "^sha256:[0-9a-fA-F]{64}$" }
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

  await writeRegistryConfig(config);
  return config;
}

export async function addRegistryIndex(rawName: string, rawUrl: string): Promise<RegistryConfigV1> {
  const name = normalizeRegistryIndexName(rawName, "registry index name");
  const url = normalizeHttpUrl(rawUrl, "registry URL");
  const config = await readRegistryConfig();
  if (config.indexes.some((index) => index.name === name)) {
    throw new SpellError(`registry index already exists: ${name}`);
  }

  const nextConfig: RegistryConfigV1 = {
    version: "v1",
    indexes: [...config.indexes, { name, url }]
  };
  await writeRegistryConfig(nextConfig);
  return nextConfig;
}

export async function removeRegistryIndex(rawName: string): Promise<RegistryConfigV1> {
  const name = normalizeRegistryIndexName(rawName, "registry index name");
  if (name === "default") {
    throw new SpellError("cannot remove registry index 'default'");
  }

  const config = await readRegistryConfig();
  if (!config.indexes.some((index) => index.name === name)) {
    throw new SpellError(`registry index not found: ${name}`);
  }

  const nextIndexes = config.indexes.filter((index) => index.name !== name);
  if (nextIndexes.length === 0) {
    throw new SpellError(`cannot remove registry index '${name}': at least one index is required`);
  }

  const nextConfig: RegistryConfigV1 = {
    version: "v1",
    indexes: nextIndexes
  };
  await writeRegistryConfig(nextConfig);
  return nextConfig;
}

export async function validateRegistryIndexes(rawName?: string): Promise<RegistryValidationResult[]> {
  const config = await readRegistryConfig();
  const indexes = selectRegistryIndexes(config, rawName);
  const results: RegistryValidationResult[] = [];

  for (const index of indexes) {
    try {
      const loadedIndex = await fetchRegistryIndex(index.url);
      results.push({
        name: index.name,
        url: index.url,
        spellCount: loadedIndex.spells.length
      });
    } catch (error) {
      throw new SpellError(`registry validation failed for '${index.name}': ${(error as Error).message}`);
    }
  }

  return results;
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
  const seenNames = new Set<string>();
  for (const index of config.indexes) {
    const normalizedName = normalizeRegistryIndexName(index.name, "registry index name");
    if (seenNames.has(normalizedName)) {
      throw new SpellError(`registry config validation failed: duplicate registry index name: ${normalizedName}`);
    }
    seenNames.add(normalizedName);
    index.name = normalizedName;
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
    throw new SpellError(`invalid registry source: ${value} (expected registry:<id> or registry:<id>@<version>)`);
  }

  const body = value.slice("registry:".length);
  const atIndex = body.lastIndexOf("@");
  if (atIndex < 0) {
    const id = body.trim();
    if (!id) {
      throw new SpellError(`invalid registry source: ${value} (expected registry:<id> or registry:<id>@<version>)`);
    }
    return { id, version: "latest" };
  }

  if (atIndex <= 0 || atIndex === body.length - 1) {
    throw new SpellError(`invalid registry source: ${value} (expected registry:<id> or registry:<id>@<version>)`);
  }

  const id = body.slice(0, atIndex).trim();
  const version = body.slice(atIndex + 1).trim();
  if (!id || !version) {
    throw new SpellError(`invalid registry source: ${value} (expected registry:<id> or registry:<id>@<version>)`);
  }

  return { id, version };
}

export function resolveRegistryEntry(index: RegistryIndexV1, id: string, version: string): RegistrySpellEntry {
  if (version === "latest") {
    const candidates = index.spells.filter((spell) => spell.id === id);
    if (candidates.length === 0) {
      throw new SpellError(`registry entry not found: ${id}@latest`);
    }

    const versions = Array.from(new Set(candidates.map((spell) => spell.version)));
    const selectedVersion = selectLatestVersion(versions);
    const selected = candidates.find((spell) => spell.version === selectedVersion);
    if (!selected) {
      throw new SpellError(`registry entry not found: ${id}@latest`);
    }
    return selected;
  }

  const found = index.spells.find((spell) => spell.id === id && spell.version === version);
  if (!found) {
    throw new SpellError(`registry entry not found: ${id}@${version}`);
  }
  return found;
}

export function readRegistryRequiredPinsPolicy(
  env: NodeJS.ProcessEnv = process.env
): RegistryRequiredPinsPolicy {
  const raw = env[REGISTRY_REQUIRED_PINS_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_REGISTRY_REQUIRED_PINS;
  }

  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "none":
    case "commit":
    case "digest":
    case "both":
      return normalized;
    default:
      throw new SpellError(`${REGISTRY_REQUIRED_PINS_ENV} must be one of: none, commit, digest, both`);
  }
}

export function enforceRegistryRequiredPins(
  entry: RegistrySpellEntry,
  installRef: RegistryInstallRef,
  policy: RegistryRequiredPinsPolicy
): void {
  if ((policy === "commit" || policy === "both") && !entry.commit) {
    throw new SpellError(
      `registry entry missing required commit pin for ${installRef.id}@${installRef.version}`
    );
  }

  if ((policy === "digest" || policy === "both") && !entry.digest) {
    throw new SpellError(
      `registry entry missing required digest pin for ${installRef.id}@${installRef.version}`
    );
  }
}

export async function resolveRegistryInstallSource(
  sourceInput: string,
  preferredRegistryName?: string
): Promise<RegistryInstallSource> {
  const parsed = parseRegistryInstallRef(sourceInput);
  const config = await readRegistryConfig();
  const selectedIndex = selectRegistryInstallIndex(config, preferredRegistryName);

  const index = await fetchRegistryIndex(selectedIndex.url);
  const entry = resolveRegistryEntry(index, parsed.id, parsed.version);
  const resolvedRef: RegistryInstallRef = {
    id: parsed.id,
    version: entry.version
  };
  const source = entry.source.trim();
  if (!PINNED_GIT_SOURCE_PATTERN.test(source)) {
    throw new SpellError(
      `invalid registry source for ${resolvedRef.id}@${resolvedRef.version}: expected '<git-url>#<ref>', got '${entry.source}'`
    );
  }

  const requiredPinsPolicy = readRegistryRequiredPinsPolicy();
  enforceRegistryRequiredPins(entry, resolvedRef, requiredPinsPolicy);

  return {
    id: resolvedRef.id,
    version: resolvedRef.version,
    registryName: selectedIndex.name,
    registryUrl: selectedIndex.url,
    source,
    expectedCommit: entry.commit,
    expectedDigest: entry.digest
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

function selectRegistryIndexes(config: RegistryConfigV1, rawName?: string): RegistryIndexRef[] {
  if (rawName === undefined) {
    return config.indexes;
  }

  const name = normalizeRegistryIndexName(rawName, "registry index name");
  const found = config.indexes.find((index) => index.name === name);
  if (!found) {
    throw new SpellError(`registry index not found: ${name}`);
  }
  return [found];
}

function selectRegistryInstallIndex(config: RegistryConfigV1, rawName?: string): RegistryIndexRef {
  if (rawName !== undefined && rawName.trim() !== "") {
    const name = normalizeRegistryIndexName(rawName, "registry index name");
    const found = config.indexes.find((index) => index.name === name);
    if (!found) {
      throw new SpellError(`registry index not found: ${name}`);
    }
    return found;
  }

  const defaultIndex = config.indexes.find((index) => index.name === "default");
  if (!defaultIndex) {
    throw new SpellError(`registry config missing default index (run 'spell registry set <url>' first)`);
  }
  return defaultIndex;
}

async function writeRegistryConfig(config: RegistryConfigV1): Promise<void> {
  await mkdir(spellHome(), { recursive: true });
  await writeFile(registryConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

function normalizeRegistryIndexName(rawValue: string, label: string): string {
  const value = rawValue.trim();
  if (!value) {
    throw new SpellError(`invalid ${label}: ${rawValue}`);
  }

  return value;
}
