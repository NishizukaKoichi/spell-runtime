import { describe, expect, test } from "vitest";
import { executeSteps } from "../../src/runner/executeSteps";
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
