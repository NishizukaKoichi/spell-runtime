import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { toIdKey } from "../util/idKey";
import { ensureSpellDirs, spellsRoot } from "../util/paths";
import { SpellError } from "../util/errors";
import { loadManifestFromDir } from "./manifest";

export interface InstallResult {
  id: string;
  version: string;
  idKey: string;
  destination: string;
}

export async function installBundle(localPath: string): Promise<InstallResult> {
  const sourcePath = path.resolve(localPath);
  const sourceRoot = await realpath(sourcePath);

  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new SpellError(`bundle path must be a directory: ${localPath}`);
  }

  const { manifest, schemaPath } = await loadManifestFromDir(sourceRoot);
  const idKey = toIdKey(manifest.id);

  await ensureSpellDirs();

  const targetRoot = path.join(spellsRoot(), idKey);
  const targetVersionPath = path.join(targetRoot, manifest.version);
  await mkdir(targetRoot, { recursive: true });

  const idFilePath = path.join(targetRoot, "spell.id.txt");
  const idFileExists = await exists(idFilePath);
  if (idFileExists) {
    const existingId = (await readFile(idFilePath, "utf8")).trim();
    if (existingId !== manifest.id) {
      throw new SpellError(
        `spell.id.txt mismatch for ${idKey}: expected '${existingId}', got '${manifest.id}'`
      );
    }
  } else {
    await writeFile(idFilePath, `${manifest.id}\n`, "utf8");
  }

  if (await exists(targetVersionPath)) {
    throw new SpellError(`already installed: ${manifest.id}@${manifest.version}`);
  }

  await mkdir(targetVersionPath, { recursive: false });

  const srcManifestPath = path.join(sourceRoot, "spell.yaml");
  const srcSchemaPath = schemaPath;
  const srcStepsPath = path.join(sourceRoot, "steps");

  await assertPathWithinSource(sourceRoot, srcManifestPath);
  await assertPathWithinSource(sourceRoot, srcSchemaPath);
  await assertPathWithinSource(sourceRoot, srcStepsPath);

  await copyFile(srcManifestPath, path.join(targetVersionPath, "spell.yaml"));
  await copyFile(srcSchemaPath, path.join(targetVersionPath, "schema.json"));

  const targetStepsPath = path.join(targetVersionPath, "steps");
  await copyDirectorySafe(srcStepsPath, targetStepsPath, sourceRoot);

  await access(path.join(targetVersionPath, "spell.yaml"));
  await access(path.join(targetVersionPath, "schema.json"));
  await access(path.join(targetVersionPath, "steps"));

  return {
    id: manifest.id,
    version: manifest.version,
    idKey,
    destination: targetVersionPath
  };
}

async function copyDirectorySafe(sourceDir: string, targetDir: string, sourceRoot: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(sourceDir, entry.name);
    const dstPath = path.join(targetDir, entry.name);

    await assertPathWithinSource(sourceRoot, srcPath);

    const info = await lstat(srcPath);
    if (info.isSymbolicLink()) {
      throw new SpellError(`symlink is not allowed in steps/: ${srcPath}`);
    }

    if (info.isDirectory()) {
      await copyDirectorySafe(srcPath, dstPath, sourceRoot);
      continue;
    }

    if (info.isFile()) {
      await copyFile(srcPath, dstPath);
      continue;
    }

    throw new SpellError(`unsupported file type in steps/: ${srcPath}`);
  }
}

async function assertPathWithinSource(sourceRoot: string, candidatePath: string): Promise<void> {
  const candidateReal = await realpath(candidatePath);
  const rel = path.relative(sourceRoot, candidateReal);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SpellError(`path escapes bundle root: ${candidatePath}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
