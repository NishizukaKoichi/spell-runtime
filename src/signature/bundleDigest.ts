import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SpellError } from "../util/errors";

export interface BundleDigest {
  algorithm: "sha256";
  valueHex: string;
  value: Buffer;
}

// Computes a deterministic digest over:
// - spell.yaml (bytes)
// - schema.json (bytes)
// - steps/** (file paths + bytes)
//
// spell.sig.json is intentionally excluded.
export async function computeBundleDigest(bundlePath: string): Promise<BundleDigest> {
  const root = path.resolve(bundlePath);

  const manifestPath = path.join(root, "spell.yaml");
  const schemaPath = path.join(root, "schema.json");
  const stepsRoot = path.join(root, "steps");

  await assertRegularFile(manifestPath, "spell.yaml");
  await assertRegularFile(schemaPath, "schema.json");

  const stepsStat = await stat(stepsRoot).catch(() => null);
  if (!stepsStat || !stepsStat.isDirectory()) {
    throw new SpellError("steps/ must be a directory");
  }

  const entries: Array<{ rel: string; abs: string }> = [
    { rel: "spell.yaml", abs: manifestPath },
    { rel: "schema.json", abs: schemaPath }
  ];

  const stepFiles = await collectFilesNoSymlinks(stepsRoot);
  for (const absPath of stepFiles) {
    const relFromSteps = path.relative(stepsRoot, absPath);
    const rel = normalizeRelPath(path.posix.join("steps", relFromSteps));
    entries.push({ rel, abs: absPath });
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash("sha256");
  hash.update("spell-bundle-v1\0"); // domain separation

  for (const entry of entries) {
    const bytes = await readFile(entry.abs);
    hash.update("file\0");
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }

  const value = hash.digest();
  return {
    algorithm: "sha256",
    valueHex: value.toString("hex"),
    value
  };
}

function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, "/");
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new SpellError(`${label} not found`);
  }
}

async function collectFilesNoSymlinks(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const info = await lstat(absPath);
      if (info.isSymbolicLink()) {
        throw new SpellError(`symlink is not allowed in steps/: ${absPath}`);
      }

      if (info.isDirectory()) {
        await walk(absPath);
        continue;
      }

      if (info.isFile()) {
        out.push(absPath);
        continue;
      }

      throw new SpellError(`unsupported file type in steps/: ${absPath}`);
    }
  }

  await walk(rootDir);
  return out.sort((a, b) => a.localeCompare(b));
}

