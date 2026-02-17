import { spawn } from "node:child_process";
import { SpellStep, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { formatExecutionTimeoutMessage, readRuntimeStepTimeoutMs } from "../runner/runtimeLimits";

export interface ShellStepExecution {
  stepResult: StepResult;
  stdout: string;
  stderr: string;
}

export interface ShellStepRunOptions {
  maxDurationMs?: number;
  executionTimeoutMs?: number;
}

export async function runShellStep(
  step: SpellStep,
  runPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: ShellStepRunOptions = {}
): Promise<ShellStepExecution> {
  const started = new Date().toISOString();
  const configuredStepTimeoutMs = readRuntimeStepTimeoutMs(env);
  const cappedByExecution =
    options.maxDurationMs !== undefined &&
    Number.isFinite(options.maxDurationMs) &&
    options.maxDurationMs > 0 &&
    options.maxDurationMs < configuredStepTimeoutMs;
  const timeoutMs = cappedByExecution
    ? Math.max(1, Math.ceil(options.maxDurationMs as number))
    : configuredStepTimeoutMs;

  const child = spawn(runPath, [], {
    shell: false,
    cwd,
    env
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).catch((error) => {
      throw new SpellError(`failed to execute shell step '${step.name}': ${(error as Error).message}`);
    });
  } finally {
    clearTimeout(timer);
  }

  if (timeoutHit) {
    if (cappedByExecution && options.executionTimeoutMs !== undefined) {
      throw new SpellError(formatExecutionTimeoutMessage(options.executionTimeoutMs, step.name));
    }
    throw new SpellError(`shell step '${step.name}' timed out after ${timeoutMs}ms`);
  }

  const finished = new Date().toISOString();

  const stepResult: StepResult = {
    stepName: step.name,
    uses: step.uses,
    started_at: started,
    finished_at: finished,
    success: exitCode === 0,
    exitCode,
    stdout_head: stdout.slice(0, 200),
    stderr_head: stderr.slice(0, 200),
    message: exitCode === 0 ? "ok" : `non-zero exit code: ${exitCode}`
  };

  if (exitCode !== 0) {
    throw new SpellError(`step failed: ${step.name} (exit code ${exitCode})`);
  }

  return {
    stepResult,
    stdout,
    stderr
  };
}
