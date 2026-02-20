#!/usr/bin/env node
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadManifestFromDir } from "../bundle/manifest";
import { readSchemaFromManifest } from "../bundle/store";
import { evaluateChecks } from "../checks/evaluate";
import { runHttpStep } from "../steps/httpStep";
import { runShellStep } from "../steps/shellStep";
import { CheckResult, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { detectHostPlatform, platformMatches } from "../util/platform";
import { validateInputAgainstSchema } from "./input";

interface RunnerResult {
  success: boolean;
  error?: string;
  stepResults: StepResult[];
  outputs: Record<string, unknown>;
  checks: CheckResult[];
}

async function main(): Promise<void> {
  const [manifestPath, inputPath] = process.argv.slice(2);
  if (!manifestPath || !inputPath) {
    process.stderr.write("usage: spell-runner <spell.yaml> <input.json>\n");
    process.exitCode = 1;
    return;
  }

  const result = await runSpellRunner(manifestPath, inputPath).catch((error) => ({
    success: false,
    error: (error as Error).message,
    stepResults: [],
    outputs: {},
    checks: []
  }));

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

export async function runSpellRunner(manifestPath: string, inputPath: string): Promise<RunnerResult> {
  const sourceDir = path.dirname(path.resolve(manifestPath));
  const workDir = await mkdtemp(path.join(tmpdir(), "spell-runner-"));

  const stepResults: StepResult[] = [];
  const outputs: Record<string, unknown> = {};
  let checks: CheckResult[] = [];

  try {
    await copyBundleForExecution(sourceDir, workDir);

    const { manifest } = await loadManifestFromDir(workDir);

    const input = await readInputJson(inputPath);

    const schema = await readSchemaFromManifest(manifest, workDir);
    validateInputAgainstSchema(schema, input);

    const hostPlatform = detectHostPlatform();
    if (!platformMatches(manifest.runtime.platforms, hostPlatform)) {
      throw new SpellError(
        `platform mismatch: host=${hostPlatform}, spell supports=${manifest.runtime.platforms.join(",")}`
      );
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INPUT_JSON: inputPath
    };

    for (const step of manifest.steps) {
      const runPath = path.resolve(workDir, step.run);

      if (step.uses === "shell") {
        const result = await runShellStep(step, runPath, workDir, env);
        stepResults.push(result.stepResult);
        outputs[`step.${step.name}.stdout`] = result.stdout;
        continue;
      }

      if (step.uses === "http") {
        const result = await runHttpStep(step, runPath, input, env);
        stepResults.push(result.stepResult);
        outputs[`step.${step.name}.json`] = result.responseBody;
        continue;
      }

      throw new SpellError(`unsupported step type: ${step.uses}`);
    }

    checks = await evaluateChecks(manifest.checks, workDir, outputs, true);
    const failed = checks.filter((entry) => !entry.success);
    if (failed.length > 0) {
      throw new SpellError(`check failed: ${failed[0].message}`);
    }

    return {
      success: true,
      stepResults,
      outputs,
      checks
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
      stepResults,
      outputs,
      checks
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readInputJson(inputPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("input.json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function copyBundleForExecution(sourceDir: string, targetDir: string): Promise<void> {
  const srcManifestPath = path.join(sourceDir, "spell.yaml");
  const srcSchemaPath = path.join(sourceDir, "schema.json");
  const srcStepsPath = path.join(sourceDir, "steps");

  await access(srcManifestPath);
  await access(srcSchemaPath);
  await access(srcStepsPath);

  await copyFile(srcManifestPath, path.join(targetDir, "spell.yaml"));
  await copyFile(srcSchemaPath, path.join(targetDir, "schema.json"));

  const targetStepsPath = path.join(targetDir, "steps");
  await copyDirectoryNoSymlinks(srcStepsPath, targetStepsPath);
}

async function copyDirectoryNoSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(sourceDir, entry.name);
    const dstPath = path.join(targetDir, entry.name);

    const info = await lstat(srcPath);
    if (info.isSymbolicLink()) {
      throw new SpellError(`symlink is not allowed in steps/: ${srcPath}`);
    }

    if (info.isDirectory()) {
      await copyDirectoryNoSymlinks(srcPath, dstPath);
      continue;
    }

    if (info.isFile()) {
      await copyFile(srcPath, dstPath);
      await chmod(dstPath, info.mode & 0o777);
      continue;
    }

    throw new SpellError(`unsupported file type in steps/: ${srcPath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
