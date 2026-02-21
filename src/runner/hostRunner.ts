import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpellBundleManifest, StepResult } from "../types";
import { executeSteps } from "./executeSteps";

export async function runHost(
  manifest: SpellBundleManifest,
  bundlePath: string,
  input: Record<string, unknown>,
  executionTimeoutMs?: number
): Promise<{ outputs: Record<string, unknown>; stepResults: StepResult[] }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-input-"));
  const inputPath = path.join(tempDir, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  const env = {
    ...process.env,
    INPUT_JSON: inputPath
  };

  return executeSteps(manifest, bundlePath, input, env, {
    executionTimeoutMs
  });
}
