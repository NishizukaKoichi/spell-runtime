import { describe, expect, test } from "vitest";
import { executeSteps, StepExecutionError } from "../../src/runner/executeSteps";
import { SpellBundleManifest, SpellStep, StepResult } from "../../src/types";

describe("executeSteps", () => {
  test("respects depends_on and condition skip", async () => {
    const called: string[] = [];
    const manifest = makeManifest([
      { uses: "shell", name: "a", run: "steps/a.js" },
      {
        uses: "shell",
        name: "b",
        run: "steps/b.js",
        depends_on: ["a"],
        when: {
          input_path: "flags.runB",
          equals: true
        }
      },
      {
        uses: "shell",
        name: "c",
        run: "steps/c.js",
        depends_on: ["a"],
        when: {
          output_path: "step.a.stdout",
          equals: "A"
        }
      }
    ]);

    const result = await executeSteps(manifest, "/tmp", { flags: { runB: false } }, {}, {
      shellRunner: async (step) => {
        called.push(step.name);
        return {
          stepResult: okStepResult(step),
          stdout: step.name.toUpperCase(),
          stderr: ""
        };
      }
    });

    expect(called).toEqual(["a", "c"]);
    expect(result.outputs["step.a.stdout"]).toBe("A");
    expect(result.outputs["step.c.stdout"]).toBe("C");
    expect(result.outputs["step.b.stdout"]).toBeUndefined();

    const stepB = result.stepResults.find((entry) => entry.stepName === "b");
    expect(stepB?.success).toBe(true);
    expect(stepB?.message).toBe("skipped by condition");
  });

  test("runs independent steps in parallel batches", async () => {
    let running = 0;
    let maxRunning = 0;

    const manifest = makeManifest(
      [
        { uses: "shell", name: "a", run: "steps/a.js" },
        { uses: "shell", name: "b", run: "steps/b.js" },
        { uses: "shell", name: "c", run: "steps/c.js" }
      ],
      2
    );

    await executeSteps(manifest, "/tmp", {}, {}, {
      shellRunner: async (step) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 40));
        running -= 1;
        return {
          stepResult: okStepResult(step),
          stdout: step.name,
          stderr: ""
        };
      }
    });

    expect(maxRunning).toBe(2);
  });

  test("runs rollback steps in reverse order after failure", async () => {
    const called: string[] = [];
    const manifest = makeManifest([
      { uses: "shell", name: "prepare", run: "steps/prepare.js", rollback: "steps/rollback-prepare.js" },
      { uses: "shell", name: "deploy", run: "steps/deploy.js", depends_on: ["prepare"] }
    ]);

    let caught: unknown;
    try {
      await executeSteps(manifest, "/tmp", {}, {}, {
        shellRunner: async (step) => {
          called.push(step.name);
          if (step.name === "deploy") {
            throw new Error("deploy failed");
          }
          return {
            stepResult: okStepResult(step),
            stdout: step.name.toUpperCase(),
            stderr: ""
          };
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StepExecutionError);
    const executionError = caught as StepExecutionError;
    expect(called).toEqual(["prepare", "deploy", "rollback.prepare"]);
    expect(executionError.outputs["step.prepare.stdout"]).toBe("PREPARE");
    expect(executionError.stepResults.map((entry) => entry.stepName)).toEqual(["prepare", "rollback.prepare"]);
  });

  test("records rollback failures and keeps running remaining rollbacks", async () => {
    const called: string[] = [];
    const manifest = makeManifest([
      { uses: "shell", name: "a", run: "steps/a.js", rollback: "steps/rollback-a.js" },
      { uses: "shell", name: "b", run: "steps/b.js", depends_on: ["a"], rollback: "steps/rollback-b.js" },
      { uses: "shell", name: "c", run: "steps/c.js", depends_on: ["b"] }
    ]);

    let caught: unknown;
    try {
      await executeSteps(manifest, "/tmp", {}, {}, {
        shellRunner: async (step) => {
          called.push(step.name);
          if (step.name === "c") {
            throw new Error("c failed");
          }
          if (step.name === "rollback.b") {
            throw new Error("rollback b failed");
          }
          return {
            stepResult: okStepResult(step),
            stdout: step.name,
            stderr: ""
          };
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StepExecutionError);
    const executionError = caught as StepExecutionError;
    expect(called).toEqual(["a", "b", "c", "rollback.b", "rollback.a"]);
    expect(executionError.stepResults.map((entry) => entry.stepName)).toEqual(["a", "b", "rollback.b", "rollback.a"]);
    const rollbackB = executionError.stepResults.find((entry) => entry.stepName === "rollback.b");
    expect(rollbackB?.success).toBe(false);
    expect(rollbackB?.message).toContain("rollback failed");
    const rollbackA = executionError.stepResults.find((entry) => entry.stepName === "rollback.a");
    expect(rollbackA?.success).toBe(true);
  });
});

function makeManifest(steps: SpellStep[], maxParallelSteps = 1): SpellBundleManifest {
  return {
    id: "tests/execute-steps",
    version: "1.0.0",
    name: "Execute Steps Test",
    summary: "test manifest",
    inputs_schema: "./schema.json",
    risk: "low",
    permissions: [],
    effects: [{ type: "notify", target: "stdout", mutates: false }],
    billing: {
      enabled: false,
      mode: "none",
      currency: "USD",
      max_amount: 0
    },
    runtime: {
      execution: "host",
      platforms: ["darwin/arm64"],
      max_parallel_steps: maxParallelSteps
    },
    steps,
    checks: [{ type: "exit_code", params: {} }]
  };
}

function okStepResult(step: SpellStep): StepResult {
  const now = new Date().toISOString();
  return {
    stepName: step.name,
    uses: step.uses,
    started_at: now,
    finished_at: now,
    success: true,
    exitCode: 0,
    message: "ok"
  };
}
