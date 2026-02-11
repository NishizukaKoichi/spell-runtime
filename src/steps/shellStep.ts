import { spawn } from "node:child_process";
import { SpellStep, StepResult } from "../types";
import { SpellError } from "../util/errors";

export interface ShellStepExecution {
  stepResult: StepResult;
  stdout: string;
  stderr: string;
}

export async function runShellStep(
  step: SpellStep,
  runPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<ShellStepExecution> {
  const started = new Date().toISOString();

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

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).catch((error) => {
    throw new SpellError(`failed to execute shell step '${step.name}': ${(error as Error).message}`);
  });

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
