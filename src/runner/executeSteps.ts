import path from "node:path";
import { SpellBundleManifest, SpellStep, StepResult } from "../types";
import { runHttpStep, HttpStepExecution } from "../steps/httpStep";
import { runShellStep, ShellStepExecution } from "../steps/shellStep";
import { SpellError } from "../util/errors";
import { getByDotPath } from "../util/object";
import { resolveOutputReference } from "../util/outputs";
import { formatExecutionTimeoutMessage } from "./runtimeLimits";

type ShellRunner = (
  step: SpellStep,
  runPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: { maxDurationMs?: number; executionTimeoutMs?: number }
) => Promise<ShellStepExecution>;

type HttpRunner = (
  step: SpellStep,
  runPath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
) => Promise<HttpStepExecution>;

export interface ExecuteStepsOptions {
  executionTimeoutMs?: number;
  shellRunner?: ShellRunner;
  httpRunner?: HttpRunner;
}

interface StepExecutionOutcome {
  stepName: string;
  stepResult: StepResult;
  outputKey?: string;
  outputValue?: unknown;
}

export async function executeSteps(
  manifest: SpellBundleManifest,
  bundlePath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  options: ExecuteStepsOptions = {}
): Promise<{ outputs: Record<string, unknown>; stepResults: StepResult[] }> {
  const outputs: Record<string, unknown> = {};
  const stepResults: StepResult[] = [];
  const pending = new Map(manifest.steps.map((step) => [step.name, step]));
  const completed = new Set<string>();
  const indexByName = new Map(manifest.steps.map((step, idx) => [step.name, idx]));
  const executionDeadlineMs = options.executionTimeoutMs !== undefined ? Date.now() + options.executionTimeoutMs : undefined;
  const maxParallel = manifest.runtime.max_parallel_steps ?? 1;

  const shellRunner = options.shellRunner ?? runShellStep;
  const httpRunner = options.httpRunner ?? runHttpStep;

  while (pending.size > 0) {
    const ready = manifest.steps
      .filter((step) => pending.has(step.name))
      .filter((step) => (step.depends_on ?? []).every((dependency) => completed.has(dependency)));

    if (ready.length === 0) {
      const unresolved = Array.from(pending.keys()).join(",");
      throw new SpellError(`step dependency deadlock: ${unresolved}`);
    }

    ready.sort((a, b) => (indexByName.get(a.name) ?? 0) - (indexByName.get(b.name) ?? 0));

    for (let cursor = 0; cursor < ready.length; cursor += maxParallel) {
      const batch = ready.slice(cursor, cursor + maxParallel);
      const settled = await Promise.allSettled(
        batch.map(async (step) =>
          runStepWithCondition(step, bundlePath, input, env, outputs, executionDeadlineMs, options.executionTimeoutMs, shellRunner, httpRunner)
        )
      );

      const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (rejected) {
        throw rejected.reason;
      }

      for (const entry of settled) {
        const outcome = (entry as PromiseFulfilledResult<StepExecutionOutcome>).value;
        stepResults.push(outcome.stepResult);
        if (outcome.outputKey !== undefined) {
          outputs[outcome.outputKey] = outcome.outputValue;
        }
        pending.delete(outcome.stepName);
        completed.add(outcome.stepName);
      }
    }
  }

  return { outputs, stepResults };
}

async function runStepWithCondition(
  step: SpellStep,
  bundlePath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  outputs: Record<string, unknown>,
  executionDeadlineMs: number | undefined,
  executionTimeoutMs: number | undefined,
  shellRunner: ShellRunner,
  httpRunner: HttpRunner
): Promise<StepExecutionOutcome> {
  const now = new Date().toISOString();
  const shouldRun = shouldRunStep(step, input, outputs);
  if (!shouldRun) {
    return {
      stepName: step.name,
      stepResult: {
        stepName: step.name,
        uses: step.uses,
        started_at: now,
        finished_at: now,
        success: true,
        message: "skipped by condition"
      }
    };
  }

  const runPath = path.resolve(bundlePath, step.run);
  const remainingExecutionMs = executionDeadlineMs !== undefined ? executionDeadlineMs - Date.now() : undefined;

  if (remainingExecutionMs !== undefined && remainingExecutionMs <= 0) {
    throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name));
  }

  if (step.uses === "shell") {
    const result = await shellRunner(step, runPath, bundlePath, env, {
      maxDurationMs: remainingExecutionMs,
      executionTimeoutMs
    });
    return {
      stepName: step.name,
      stepResult: result.stepResult,
      outputKey: `step.${step.name}.stdout`,
      outputValue: result.stdout
    };
  }

  if (step.uses === "http") {
    const result = await runHttpStepWithExecutionTimeout(step, runPath, input, env, remainingExecutionMs, executionTimeoutMs, httpRunner);
    return {
      stepName: step.name,
      stepResult: result.stepResult,
      outputKey: `step.${step.name}.json`,
      outputValue: result.responseBody
    };
  }

  throw new SpellError(`unsupported step type: ${step.uses}`);
}

export function shouldRunStep(
  step: SpellStep,
  input: Record<string, unknown>,
  outputs: Record<string, unknown>
): boolean {
  const condition = step.when;
  if (!condition) {
    return true;
  }

  let actual: unknown;
  if (condition.input_path) {
    actual = getByDotPath(input, condition.input_path);
  } else if (condition.output_path) {
    try {
      actual = resolveOutputReference(outputs, condition.output_path);
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("output reference not found:")) {
        return false;
      }
      throw error;
    }
  } else {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(condition, "equals") && actual !== condition.equals) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(condition, "not_equals") && actual === condition.not_equals) {
    return false;
  }

  return true;
}

async function runHttpStepWithExecutionTimeout(
  step: SpellStep,
  runPath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  remainingExecutionMs: number | undefined,
  executionTimeoutMs: number | undefined,
  httpRunner: HttpRunner
): Promise<HttpStepExecution> {
  if (remainingExecutionMs === undefined) {
    return httpRunner(step, runPath, input, env);
  }

  if (remainingExecutionMs <= 0) {
    throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name)));
  }, remainingExecutionMs);

  try {
    return await httpRunner(step, runPath, input, env, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
