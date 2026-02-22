import path from "node:path";
import { CheckResult, RollbackSummary, SpellBundleManifest, SpellStep, StepResult } from "../types";
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
  executed: boolean;
  outputKey?: string;
  outputValue?: unknown;
}

export class StepExecutionError extends SpellError {
  readonly outputs: Record<string, unknown>;
  readonly stepResults: StepResult[];
  readonly checks: CheckResult[];
  readonly rollback?: RollbackSummary;

  constructor(
    message: string,
    outputs: Record<string, unknown>,
    stepResults: StepResult[],
    checks: CheckResult[] = [],
    rollback?: RollbackSummary
  ) {
    super(message);
    this.outputs = outputs;
    this.stepResults = stepResults;
    this.checks = checks;
    this.rollback = rollback;
  }
}

export async function executeSteps(
  manifest: SpellBundleManifest,
  bundlePath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  options: ExecuteStepsOptions = {}
): Promise<{ outputs: Record<string, unknown>; stepResults: StepResult[]; executedStepNames: string[] }> {
  const outputs: Record<string, unknown> = {};
  const stepResults: StepResult[] = [];
  const executedStepNames: string[] = [];
  const pending = new Map(manifest.steps.map((step) => [step.name, step]));
  const completed = new Set<string>();
  const indexByName = new Map(manifest.steps.map((step, idx) => [step.name, idx]));
  const executionDeadlineMs = options.executionTimeoutMs !== undefined ? Date.now() + options.executionTimeoutMs : undefined;
  const maxParallel = manifest.runtime.max_parallel_steps ?? 1;

  const shellRunner = options.shellRunner ?? runShellStep;
  const httpRunner = options.httpRunner ?? runHttpStep;

  try {
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

        let rejectedReason: unknown;
        for (const entry of settled) {
          if (entry.status === "rejected") {
            if (rejectedReason === undefined) {
              rejectedReason = entry.reason;
            }
            continue;
          }

          const outcome = entry.value;
          stepResults.push(outcome.stepResult);
          if (outcome.outputKey !== undefined) {
            outputs[outcome.outputKey] = outcome.outputValue;
          }
          if (outcome.executed) {
            executedStepNames.push(outcome.stepName);
          }
          pending.delete(outcome.stepName);
          completed.add(outcome.stepName);
        }

        if (rejectedReason !== undefined) {
          throw rejectedReason;
        }
      }
    }
  } catch (error) {
    const rollbackRun = await runConfiguredRollbacks(
      manifest,
      bundlePath,
      env,
      executedStepNames,
      executionDeadlineMs,
      options.executionTimeoutMs,
      shellRunner
    );
    stepResults.push(...rollbackRun.stepResults);
    const message = error instanceof Error ? error.message : String(error);
    throw new StepExecutionError(message, { ...outputs }, [...stepResults], [], rollbackRun.summary);
  }

  return { outputs, stepResults, executedStepNames };
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
      },
      executed: false
    };
  }

  const runPath = path.resolve(bundlePath, step.run);
  const retry = normalizeStepRetry(step);

  if (step.uses === "shell") {
    const result = await runShellStepWithRetry(
      step,
      runPath,
      bundlePath,
      env,
      executionDeadlineMs,
      executionTimeoutMs,
      retry,
      shellRunner
    );
    return {
      stepName: step.name,
      stepResult: result.stepResult,
      executed: true,
      outputKey: `step.${step.name}.stdout`,
      outputValue: result.stdout
    };
  }

  if (step.uses === "http") {
    const result = await runHttpStepWithRetry(
      step,
      runPath,
      input,
      env,
      executionDeadlineMs,
      executionTimeoutMs,
      retry,
      httpRunner
    );
    return {
      stepName: step.name,
      stepResult: result.stepResult,
      executed: true,
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

interface NormalizedStepRetry {
  maxAttempts: number;
  backoffMs: number;
}

function normalizeStepRetry(step: SpellStep): NormalizedStepRetry {
  return {
    maxAttempts: step.retry?.max_attempts ?? 1,
    backoffMs: step.retry?.backoff_ms ?? 0
  };
}

async function runShellStepWithRetry(
  step: SpellStep,
  runPath: string,
  bundlePath: string,
  env: NodeJS.ProcessEnv,
  executionDeadlineMs: number | undefined,
  executionTimeoutMs: number | undefined,
  retry: NormalizedStepRetry,
  shellRunner: ShellRunner
): Promise<ShellStepExecution> {
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    const remainingExecutionMs = executionDeadlineMs !== undefined ? executionDeadlineMs - Date.now() : undefined;
    if (remainingExecutionMs !== undefined && remainingExecutionMs <= 0) {
      throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name));
    }

    try {
      const result = await shellRunner(step, runPath, bundlePath, env, {
        maxDurationMs: remainingExecutionMs,
        executionTimeoutMs
      });
      return {
        ...result,
        stepResult: annotateSuccessfulAttempt(result.stepResult, attempt, retry.maxAttempts)
      };
    } catch (error) {
      if (attempt >= retry.maxAttempts) {
        throw toRetryError(error, attempt, retry.maxAttempts);
      }
      await waitForRetryBackoff(step.name, retry.backoffMs, executionDeadlineMs, executionTimeoutMs);
    }
  }

  throw new SpellError(`step failed: ${step.name}`);
}

async function runHttpStepWithRetry(
  step: SpellStep,
  runPath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  executionDeadlineMs: number | undefined,
  executionTimeoutMs: number | undefined,
  retry: NormalizedStepRetry,
  httpRunner: HttpRunner
): Promise<HttpStepExecution> {
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    const remainingExecutionMs = executionDeadlineMs !== undefined ? executionDeadlineMs - Date.now() : undefined;
    if (remainingExecutionMs !== undefined && remainingExecutionMs <= 0) {
      throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, step.name));
    }

    try {
      const result = await runHttpStepWithExecutionTimeout(
        step,
        runPath,
        input,
        env,
        remainingExecutionMs,
        executionTimeoutMs,
        httpRunner
      );
      return {
        ...result,
        stepResult: annotateSuccessfulAttempt(result.stepResult, attempt, retry.maxAttempts)
      };
    } catch (error) {
      if (attempt >= retry.maxAttempts) {
        throw toRetryError(error, attempt, retry.maxAttempts);
      }
      await waitForRetryBackoff(step.name, retry.backoffMs, executionDeadlineMs, executionTimeoutMs);
    }
  }

  throw new SpellError(`step failed: ${step.name}`);
}

function annotateSuccessfulAttempt(stepResult: StepResult, attempt: number, maxAttempts: number): StepResult {
  if (maxAttempts <= 1) {
    return stepResult;
  }

  const baseMessage = stepResult.message ?? "ok";
  return {
    ...stepResult,
    message: `${baseMessage} (attempt ${attempt}/${maxAttempts})`
  };
}

function toRetryError(error: unknown, attempt: number, maxAttempts: number): SpellError {
  if (error instanceof SpellError && maxAttempts <= 1) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (maxAttempts <= 1 || message.includes(`attempt ${attempt}/${maxAttempts}`)) {
    return new SpellError(message);
  }

  return new SpellError(`${message} (attempt ${attempt}/${maxAttempts})`);
}

async function waitForRetryBackoff(
  stepName: string,
  backoffMs: number,
  executionDeadlineMs: number | undefined,
  executionTimeoutMs: number | undefined
): Promise<void> {
  if (backoffMs <= 0) {
    return;
  }

  if (executionDeadlineMs !== undefined) {
    const remaining = executionDeadlineMs - Date.now();
    if (remaining <= 0 || remaining < backoffMs) {
      throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs as number, stepName));
    }
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, backoffMs);
  });
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

export async function runConfiguredRollbacks(
  manifest: SpellBundleManifest,
  bundlePath: string,
  env: NodeJS.ProcessEnv,
  executedStepNames: string[],
  executionDeadlineMs: number | undefined,
  executionTimeoutMs: number | undefined,
  shellRunner: ShellRunner = runShellStep
): Promise<{ stepResults: StepResult[]; summary: RollbackSummary }> {
  const rollbackResults: StepResult[] = [];
  const stepMap = new Map(manifest.steps.map((step) => [step.name, step]));
  const failedRollbackSteps: string[] = [];
  let rollbackPlannedSteps = 0;
  let rollbackAttemptedSteps = 0;
  let rollbackSucceededSteps = 0;
  let rollbackFailedSteps = 0;

  for (let i = executedStepNames.length - 1; i >= 0; i -= 1) {
    const stepName = executedStepNames[i];
    const sourceStep = stepMap.get(stepName);
    if (!sourceStep || !sourceStep.rollback) {
      continue;
    }
    rollbackPlannedSteps += 1;

    const rollbackStep: SpellStep = {
      uses: "shell",
      name: `rollback.${sourceStep.name}`,
      run: sourceStep.rollback
    };
    const rollbackPath = path.resolve(bundlePath, rollbackStep.run);
    const remainingExecutionMs = executionDeadlineMs !== undefined ? executionDeadlineMs - Date.now() : undefined;
    const startedAt = new Date().toISOString();
    rollbackAttemptedSteps += 1;

    if (remainingExecutionMs !== undefined && remainingExecutionMs <= 0) {
      rollbackFailedSteps += 1;
      failedRollbackSteps.push(rollbackStep.name);
      rollbackResults.push({
        stepName: rollbackStep.name,
        uses: rollbackStep.uses,
        started_at: startedAt,
        finished_at: startedAt,
        success: false,
        message: formatExecutionTimeoutMessage(executionTimeoutMs as number, rollbackStep.name)
      });
      break;
    }

    try {
      const result = await shellRunner(rollbackStep, rollbackPath, bundlePath, env, {
        maxDurationMs: remainingExecutionMs,
        executionTimeoutMs
      });
      rollbackSucceededSteps += 1;
      rollbackResults.push({
        ...result.stepResult,
        stepName: rollbackStep.name
      });
    } catch (error) {
      rollbackFailedSteps += 1;
      failedRollbackSteps.push(rollbackStep.name);
      const finishedAt = new Date().toISOString();
      rollbackResults.push({
        stepName: rollbackStep.name,
        uses: rollbackStep.uses,
        started_at: startedAt,
        finished_at: finishedAt,
        success: false,
        message: `rollback failed: ${(error as Error).message}`
      });
    }
  }

  const totalExecutedSteps = executedStepNames.length;
  const rollbackSkippedWithoutHandlerSteps = Math.max(0, totalExecutedSteps - rollbackPlannedSteps);
  const summary = buildRollbackSummary({
    totalExecutedSteps,
    rollbackPlannedSteps,
    rollbackAttemptedSteps,
    rollbackSucceededSteps,
    rollbackFailedSteps,
    rollbackSkippedWithoutHandlerSteps,
    failedRollbackSteps
  });

  return {
    stepResults: rollbackResults,
    summary
  };
}

function buildRollbackSummary(params: {
  totalExecutedSteps: number;
  rollbackPlannedSteps: number;
  rollbackAttemptedSteps: number;
  rollbackSucceededSteps: number;
  rollbackFailedSteps: number;
  rollbackSkippedWithoutHandlerSteps: number;
  failedRollbackSteps: string[];
}): RollbackSummary {
  const {
    totalExecutedSteps,
    rollbackPlannedSteps,
    rollbackAttemptedSteps,
    rollbackSucceededSteps,
    rollbackFailedSteps,
    rollbackSkippedWithoutHandlerSteps,
    failedRollbackSteps
  } = params;

  let state: RollbackSummary["state"] = "not_needed";
  if (totalExecutedSteps > 0) {
    const fullyCompensated =
      rollbackPlannedSteps > 0 &&
      rollbackAttemptedSteps === rollbackPlannedSteps &&
      rollbackFailedSteps === 0 &&
      rollbackSkippedWithoutHandlerSteps === 0;

    if (fullyCompensated) {
      state = "fully_compensated";
    } else if (rollbackSucceededSteps > 0) {
      state = "partially_compensated";
    } else {
      state = "not_compensated";
    }
  }

  return {
    total_executed_steps: totalExecutedSteps,
    rollback_planned_steps: rollbackPlannedSteps,
    rollback_attempted_steps: rollbackAttemptedSteps,
    rollback_succeeded_steps: rollbackSucceededSteps,
    rollback_failed_steps: rollbackFailedSteps,
    rollback_skipped_without_handler_steps: rollbackSkippedWithoutHandlerSteps,
    failed_step_names: failedRollbackSteps,
    state
  };
}
