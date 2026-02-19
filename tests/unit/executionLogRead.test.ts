import { describe, expect, test } from "vitest";
import { readOutputFromExecutionLog, resolveExecutionLogPath } from "../../src/logging/readExecutionLog";

describe("execution log read helpers", () => {
  test("resolves execution log path from id", () => {
    const resolved = resolveExecutionLogPath("exec_123");
    expect(resolved.endsWith("/.spell/logs/exec_123.json")).toBe(true);
  });

  test("rejects invalid execution id", () => {
    expect(() => resolveExecutionLogPath("../escape")).toThrow("invalid execution id");
  });

  test("reads nested output references from log payload", () => {
    const value = readOutputFromExecutionLog(
      {
        outputs: {
          "step.send.json": {
            data: {
              id: "abc123"
            }
          }
        }
      },
      "step.send.json.data.id"
    );

    expect(value).toBe("abc123");
  });

  test("fails when output path cannot be resolved", () => {
    expect(() =>
      readOutputFromExecutionLog(
        {
          outputs: {
            "step.send.json": {
              data: {
                id: "abc123"
              }
            }
          }
        },
        "step.send.json.data.missing"
      )
    ).toThrow("output value not found");
  });
});
