import { describe, expect, test } from "vitest";
import {
  DEFAULT_RUNTIME_INPUT_MAX_BYTES,
  DEFAULT_RUNTIME_STEP_TIMEOUT_MS,
  readRuntimeExecutionTimeoutMs,
  readRuntimeInputMaxBytes,
  readRuntimeStepTimeoutMs
} from "../../src/runner/runtimeLimits";

describe("runtime limit env parsing", () => {
  test("uses defaults when env vars are not set", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(readRuntimeInputMaxBytes(env)).toBe(DEFAULT_RUNTIME_INPUT_MAX_BYTES);
    expect(readRuntimeStepTimeoutMs(env)).toBe(DEFAULT_RUNTIME_STEP_TIMEOUT_MS);
    expect(readRuntimeExecutionTimeoutMs(env)).toBeUndefined();
  });

  test("reads configured values", () => {
    const env: NodeJS.ProcessEnv = {
      SPELL_RUNTIME_INPUT_MAX_BYTES: "1024",
      SPELL_RUNTIME_STEP_TIMEOUT_MS: "2500",
      SPELL_RUNTIME_EXECUTION_TIMEOUT_MS: "9000"
    };
    expect(readRuntimeInputMaxBytes(env)).toBe(1024);
    expect(readRuntimeStepTimeoutMs(env)).toBe(2500);
    expect(readRuntimeExecutionTimeoutMs(env)).toBe(9000);
  });

  test("treats execution timeout 0 as disabled", () => {
    const env: NodeJS.ProcessEnv = {
      SPELL_RUNTIME_EXECUTION_TIMEOUT_MS: "0"
    };
    expect(readRuntimeExecutionTimeoutMs(env)).toBeUndefined();
  });

  test("rejects invalid values", () => {
    expect(() => readRuntimeInputMaxBytes({ SPELL_RUNTIME_INPUT_MAX_BYTES: "0" })).toThrow(
      /SPELL_RUNTIME_INPUT_MAX_BYTES must be an integer >= 1/
    );
    expect(() => readRuntimeStepTimeoutMs({ SPELL_RUNTIME_STEP_TIMEOUT_MS: "-5" })).toThrow(
      /SPELL_RUNTIME_STEP_TIMEOUT_MS must be an integer >= 1/
    );
    expect(() => readRuntimeExecutionTimeoutMs({ SPELL_RUNTIME_EXECUTION_TIMEOUT_MS: "-1" })).toThrow(
      /SPELL_RUNTIME_EXECUTION_TIMEOUT_MS must be an integer >= 0/
    );
  });
});
