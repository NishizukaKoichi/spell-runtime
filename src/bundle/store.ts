import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LoadedBundle, SpellBundleManifest } from "../types";
import { SpellError } from "../util/errors";
import { toIdKey } from "../util/idKey";
import { spellsRoot } from "../util/paths";
import { selectLatestVersion } from "../util/version";
import { loadManifestFromDir } from "./manifest";

export interface InstalledSpellInfo {
  id: string;
  version: string;
  name: string;
  risk: string;
  billingEnabled: boolean;
  runtimeExecution: string;
}

export async function resolveInstalledBundle(id: string, version?: string): Promise<LoadedBundle> {
  const idKey = toIdKey(id);
  const idRoot = path.join(spellsRoot(), idKey);

  await access(idRoot).catch(() => {
    throw new SpellError(`spell not installed: ${id}`);
  });

  const idFile = path.join(idRoot, "spell.id.txt");
  await access(idFile).catch(() => {
    throw new SpellError(`missing spell.id.txt for ${id}`);
  });

  const persistedId = (await readFile(idFile, "utf8")).trim();
  if (persistedId !== id) {
    throw new SpellError(`id mismatch in spell.id.txt: expected '${id}', found '${persistedId}'`);
  }

  const versions = await listVersionDirs(idRoot);
  if (versions.length === 0) {
    throw new SpellError(`no versions installed for: ${id}`);
  }

  const chosenVersion = version ?? selectLatestVersion(versions);
  if (!versions.includes(chosenVersion)) {
    throw new SpellError(`version not installed for ${id}: ${chosenVersion}`);
  }

  const bundlePath = path.join(idRoot, chosenVersion);
  const loaded = await loadManifestFromDir(bundlePath);

  if (loaded.manifest.id !== id) {
    throw new SpellError(`manifest id mismatch: expected '${id}', found '${loaded.manifest.id}'`);
  }

  return {
    manifest: loaded.manifest,
    schemaPath: loaded.schemaPath,
    bundlePath,
    idKey
  };
}

export async function listInstalledSpells(): Promise<InstalledSpellInfo[]> {
  const root = spellsRoot();
  await access(root).catch(() => {
    return;
  });

  let idKeys: string[];
  try {
    idKeys = await readdir(root);
  } catch {
    return [];
  }

  const entries: InstalledSpellInfo[] = [];

  for (const idKey of idKeys) {
    const idRoot = path.join(root, idKey);
    const idFile = path.join(idRoot, "spell.id.txt");
    const id = (await readFile(idFile, "utf8")).trim();

    const versions = await listVersionDirs(idRoot);

    for (const version of versions) {
      const bundlePath = path.join(idRoot, version);
      const { manifest } = await loadManifestFromDir(bundlePath);

      if (manifest.id !== id) {
        throw new SpellError(
          `id mismatch under ${idRoot}: spell.id.txt='${id}', spell.yaml.id='${manifest.id}'`
        );
      }

      entries.push({
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        risk: manifest.risk,
        billingEnabled: manifest.billing.enabled,
        runtimeExecution: manifest.runtime.execution
      });
    }
  }

  return entries.sort((a, b) => {
    if (a.id === b.id) {
      return b.version.localeCompare(a.version);
    }
    return a.id.localeCompare(b.id);
  });
}

export function summarizeSchema(schema: unknown): { required: string[]; keyTypes: string[] } {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { required: [], keyTypes: [] };
  }

  const obj = schema as Record<string, unknown>;
  const required = Array.isArray(obj.required) ? obj.required.filter((x): x is string => typeof x === "string") : [];

  const keyTypes: string[] = [];
  const properties = obj.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [k, v] of Object.entries(properties as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        keyTypes.push(`${k}: unknown`);
        continue;
      }

      const typeVal = (v as Record<string, unknown>).type;
      const typeString = Array.isArray(typeVal)
        ? typeVal.filter((x): x is string => typeof x === "string").join("|")
        : typeof typeVal === "string"
          ? typeVal
          : "unknown";
      keyTypes.push(`${k}: ${typeString}`);
    }
  }

  return { required, keyTypes };
}

async function listVersionDirs(idRoot: string): Promise<string[]> {
  const entries = await readdir(idRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "." && name !== "..");
}

export async function readSchemaFromManifest(manifest: SpellBundleManifest, bundlePath: string): Promise<unknown> {
  const schemaPath = path.resolve(bundlePath, manifest.inputs_schema);
  const raw = await readFile(schemaPath, "utf8");
  return JSON.parse(raw) as unknown;
}
