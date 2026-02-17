import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpellBundleManifest, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { runHttpStep } from "../steps/httpStep";
import { runShellStep } from "../steps/shellStep";
import { formatExecutionTimeoutMessage } from "./runtimeLimits";

export async function runHost(
  manifest: SpellBundleManifest,
  bundlePath: string,
  input: Record<string, unknown>,
  executionTimeoutMs?: number
): Promise<{ outputs: Record<string, unknown>; stepResults: StepResult[] }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-input-"));
  const inputPath = path.join(tempDir, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");
  const executionDeadlineMs = executionTimeoutMs !== undefined ? Date.now() + executionTimeoutMs : undefined;

  const env = {
    ...process.env,
    INPUT_JSON: inputPath
  };

  const outputs: Record<string, unknown> = {};
  const stepResults: StepResult[] = [];

  for (const step of manifest.steps) {
    const runPath = path.resolve(bundlePath, step.run);
    const remainingExecutionMs = executionDeadlineMs !== undefined ? executionDeadlineMs - Date.now() : undefined;

    if (remainingExecutionMs !== undefined && remainingExecutionMs <= 0) {
      throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name));
    }

    if (step.uses === "shell") {
      const result = await runShellStep(step, runPath, bundlePath, env, {
        maxDurationMs: remainingExecutionMs,
        executionTimeoutMs
      });
      stepResults.push(result.stepResult);
      outputs[`step.${step.name}.stdout`] = result.stdout;
      continue;
    }

    if (step.uses === "http") {
      const result = await runHttpStepWithExecutionTimeout(
        step,
        runPath,
        input,
        env,
        remainingExecutionMs,
        executionTimeoutMs
      );
      stepResults.push(result.stepResult);
      outputs[`step.${step.name}.json`] = result.responseBody;
      continue;
    }

    throw new SpellError(`unsupported step type: ${step.uses}`);
  }

  return { outputs, stepResults };
}

async function runHttpStepWithExecutionTimeout(
  step: SpellBundleManifest["steps"][number],
  runPath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  remainingExecutionMs: number | undefined,
  executionTimeoutMs: number | undefined
) {
  if (remainingExecutionMs === undefined) {
    return runHttpStep(step, runPath, input, env);
  }

  if (remainingExecutionMs <= 0) {
    throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name)));
  }, remainingExecutionMs);

  try {
    return await runHttpStep(step, runPath, input, env, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
