import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { toIdKey } from "../util/idKey";
import { ensureSpellDirs, spellsRoot } from "../util/paths";
import { SpellError } from "../util/errors";
import { loadManifestFromDir } from "./manifest";
import { resolveRegistryInstallSource } from "./registry";

export interface InstallResult {
  id: string;
  version: string;
  idKey: string;
  destination: string;
}

export async function installBundle(sourceInput: string): Promise<InstallResult> {
  const resolvedInput = isRegistrySource(sourceInput) ? await resolveRegistryInstallSource(sourceInput) : sourceInput;
  const source = await resolveInstallSource(resolvedInput);
  try {
    return await installBundleFromSource(source.sourceRoot, source.provenance);
  } finally {
    await source.cleanup();
  }
}

type InstallProvenance = LocalInstallProvenance | GitInstallProvenance;

interface LocalInstallProvenance {
  type: "local";
  source: string;
}

interface GitInstallProvenance {
  type: "git";
  source: string;
  ref: string;
  commit: string;
}

async function installBundleFromSource(sourceRoot: string, provenance: InstallProvenance): Promise<InstallResult> {
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
  const srcSigPath = path.join(sourceRoot, "spell.sig.json");

  await assertPathWithinSource(sourceRoot, srcManifestPath);
  await assertPathWithinSource(sourceRoot, srcSchemaPath);
  await assertPathWithinSource(sourceRoot, srcStepsPath);

  await copyFile(srcManifestPath, path.join(targetVersionPath, "spell.yaml"));
  await copyFile(srcSchemaPath, path.join(targetVersionPath, "schema.json"));

  if (await exists(srcSigPath)) {
    const info = await lstat(srcSigPath);
    if (info.isSymbolicLink()) {
      throw new SpellError(`symlink is not allowed: ${srcSigPath}`);
    }

    await assertPathWithinSource(sourceRoot, srcSigPath);
    await copyFile(srcSigPath, path.join(targetVersionPath, "spell.sig.json"));
  }

  const targetStepsPath = path.join(targetVersionPath, "steps");
  await copyDirectorySafe(srcStepsPath, targetStepsPath, sourceRoot);

  await access(path.join(targetVersionPath, "spell.yaml"));
  await access(path.join(targetVersionPath, "schema.json"));
  await access(path.join(targetVersionPath, "steps"));
  await writeSourceMetadata(targetVersionPath, provenance);

  return {
    id: manifest.id,
    version: manifest.version,
    idKey,
    destination: targetVersionPath
  };
}

interface InstallSource {
  sourceRoot: string;
  provenance: InstallProvenance;
  cleanup: () => Promise<void>;
}

function isRegistrySource(value: string): boolean {
  return value.startsWith("registry:");
}

async function resolveInstallSource(input: string): Promise<InstallSource> {
  if (isGitSource(input)) {
    return cloneGitSource(input);
  }

  const sourcePath = path.resolve(input);
  const sourceRoot = await realpath(sourcePath);

  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new SpellError(`bundle path must be a directory: ${input}`);
  }

  return {
    sourceRoot,
    provenance: {
      type: "local",
      source: input
    },
    cleanup: async () => {}
  };
}

function isGitSource(value: string): boolean {
  return /^https:\/\//i.test(value) || /^ssh:\/\//i.test(value) || /^git@[^:]+:.+/.test(value);
}

async function cloneGitSource(source: string): Promise<InstallSource> {
  const { gitUrl, ref } = parsePinnedGitSource(source);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "spell-install-"));
  const cloneRoot = path.join(tempRoot, "bundle");

  try {
    await runGitClone(gitUrl, cloneRoot, ref, source);
    const commit = await runGitRevParseHead(cloneRoot, source);

    const sourceRoot = await realpath(cloneRoot);

    return {
      sourceRoot,
      provenance: {
        type: "git",
        source,
        ref,
        commit
      },
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function parsePinnedGitSource(source: string): { gitUrl: string; ref: string } {
  const hashIndex = source.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex === source.length - 1) {
    throw new SpellError("git source requires explicit ref (#<ref>)");
  }

  return {
    gitUrl: source.slice(0, hashIndex),
    ref: source.slice(hashIndex + 1)
  };
}

async function runGitClone(gitUrl: string, targetDir: string, ref: string, source: string): Promise<void> {
  await runGitCommand(
    ["clone", "--depth", "1", "--branch", ref, gitUrl, targetDir],
    source,
    `failed to clone git source '${source}'`
  );
}

async function runGitRevParseHead(targetDir: string, source: string): Promise<string> {
  const stdout = await runGitCommand(
    ["-C", targetDir, "rev-parse", "HEAD"],
    source,
    `failed to resolve git commit for '${source}'`
  );
  const commit = stdout.trim();
  if (!commit) {
    throw new SpellError(`failed to resolve git commit for '${source}': empty HEAD`);
  }
  return commit;
}

async function runGitCommand(args: string[], source: string, failureMessage: string): Promise<string> {
  const child = spawn("git", args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new SpellError("git executable not found: install git and ensure it is on PATH"));
        return;
      }

      reject(new SpellError(`failed to run git command for '${source}': ${error.message}`));
    });

    child.once("close", (exitCode) => {
      if ((exitCode ?? 1) !== 0) {
        const detail = (stderr.trim() || stdout.trim() || `git exited with code ${exitCode ?? 1}`).replace(/\s+/g, " ");
        reject(new SpellError(`${failureMessage}: ${detail}`));
        return;
      }

      resolve();
    });
  });

  return stdout;
}

async function writeSourceMetadata(targetVersionPath: string, provenance: InstallProvenance): Promise<void> {
  const payload = {
    ...provenance,
    installed_at: new Date().toISOString()
  };

  await writeFile(path.join(targetVersionPath, "source.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
