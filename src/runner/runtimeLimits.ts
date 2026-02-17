import { SpellError } from "../util/errors";

export const DEFAULT_RUNTIME_INPUT_MAX_BYTES = 64 * 1024;
export const DEFAULT_RUNTIME_STEP_TIMEOUT_MS = 60_000;

export function readRuntimeInputMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv("SPELL_RUNTIME_INPUT_MAX_BYTES", DEFAULT_RUNTIME_INPUT_MAX_BYTES, env);
}

export function readRuntimeStepTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv("SPELL_RUNTIME_STEP_TIMEOUT_MS", DEFAULT_RUNTIME_STEP_TIMEOUT_MS, env);
}

export function readRuntimeExecutionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SPELL_RUNTIME_EXECUTION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new SpellError("SPELL_RUNTIME_EXECUTION_TIMEOUT_MS must be an integer >= 0");
  }

  if (value === 0) {
    return undefined;
  }

  return value;
}

export function formatExecutionTimeoutMessage(timeoutMs: number, stepName?: string): string {
  if (stepName) {
    return `cast execution timed out after ${timeoutMs}ms while running step '${stepName}'`;
  }

  return `cast execution timed out after ${timeoutMs}ms`;
}

function readPositiveIntegerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new SpellError(`${name} must be an integer >= 1`);
  }

  return value;
}
