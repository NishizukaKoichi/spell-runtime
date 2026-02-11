import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpellBundleManifest, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { runHttpStep } from "../steps/httpStep";
import { runShellStep } from "../steps/shellStep";

export async function runHost(
  manifest: SpellBundleManifest,
  bundlePath: string,
  input: Record<string, unknown>
): Promise<{ outputs: Record<string, unknown>; stepResults: StepResult[] }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-input-"));
  const inputPath = path.join(tempDir, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  const env = {
    ...process.env,
    INPUT_JSON: inputPath
  };

  const outputs: Record<string, unknown> = {};
  const stepResults: StepResult[] = [];

  for (const step of manifest.steps) {
    const runPath = path.resolve(bundlePath, step.run);

    if (step.uses === "shell") {
      const result = await runShellStep(step, runPath, bundlePath, env);
      stepResults.push(result.stepResult);
      outputs[`step.${step.name}.stdout`] = result.stdout;
      continue;
    }

    if (step.uses === "http") {
      const result = await runHttpStep(step, runPath, input, env);
      stepResults.push(result.stepResult);
      outputs[`step.${step.name}.json`] = result.responseBody;
      continue;
    }

    throw new SpellError(`unsupported step type: ${step.uses}`);
  }

  return { outputs, stepResults };
}
