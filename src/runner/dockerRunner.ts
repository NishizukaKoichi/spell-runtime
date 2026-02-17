import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { SpellBundleManifest, CheckResult, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { formatExecutionTimeoutMessage } from "./runtimeLimits";

export interface DockerRunnerResult {
  success: boolean;
  error?: string;
  stepResults: StepResult[];
  outputs: Record<string, unknown>;
  checks: CheckResult[];
}

export async function runDocker(
  manifest: SpellBundleManifest,
  bundlePath: string,
  input: Record<string, unknown>,
  executionTimeoutMs?: number
): Promise<DockerRunnerResult> {
  const dockerImage = manifest.runtime.docker_image;
  if (!dockerImage) {
    throw new SpellError("runtime.docker_image is required when runtime.execution=docker");
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-docker-"));
  const inputPath = path.join(tempDir, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  try {
    const args = buildDockerArgs(dockerImage, bundlePath, tempDir, manifest);
    const { code, stdout, stderr, timedOut } = await runProcess("docker", args, process.cwd(), executionTimeoutMs);

    if (timedOut && executionTimeoutMs !== undefined) {
      throw new SpellError(formatExecutionTimeoutMessage(executionTimeoutMs));
    }

    if (code !== 0) {
      throw new SpellError(stderr.trim() || `docker exited with code ${code}`);
    }

    const parsed = parseRunnerJson(stdout);
    if (!parsed.success) {
      throw new SpellError(parsed.error ?? "docker spell failed");
    }

    return parsed;
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("ENOENT") || message.includes("spawn docker")) {
      throw new SpellError("docker not found: install docker and ensure it is on PATH");
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildDockerArgs(dockerImage: string, bundlePath: string, tempDir: string, manifest: SpellBundleManifest): string[] {
  const inputInContainer = "/tmp/spell-input/input.json";
  const envVars = collectEnvVarsToPass(manifest);

  const args: string[] = [
    "run",
    "--rm",
    "-i",
    "--workdir",
    "/spell",
    "-v",
    `${path.resolve(bundlePath)}:/spell:ro`,
    "-v",
    `${path.resolve(tempDir)}:/tmp/spell-input:ro`,
    "-e",
    `INPUT_JSON=${inputInContainer}`
  ];

  for (const [key, value] of envVars) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(dockerImage, "spell-runner", "/spell/spell.yaml", inputInContainer);
  return args;
}

function collectEnvVarsToPass(manifest: SpellBundleManifest): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  // pass connector tokens (and fail earlier if missing)
  for (const permission of manifest.permissions) {
    const tokenKey = `CONNECTOR_${permission.connector.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
    const value = process.env[tokenKey];
    if (typeof value === "string" && value.trim() !== "") {
      out.push([tokenKey, value]);
    }
  }

  const stepTimeout = process.env.SPELL_RUNTIME_STEP_TIMEOUT_MS;
  if (typeof stepTimeout === "string" && stepTimeout.trim() !== "") {
    out.push(["SPELL_RUNTIME_STEP_TIMEOUT_MS", stepTimeout.trim()]);
  }

  return out;
}

function parseRunnerJson(stdout: string): DockerRunnerResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new SpellError("docker runner produced no output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new SpellError("failed to parse docker runner output JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("docker runner output must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  return {
    success: Boolean(obj.success),
    error: typeof obj.error === "string" ? obj.error : undefined,
    stepResults: Array.isArray(obj.stepResults) ? (obj.stepResults as StepResult[]) : [],
    outputs: obj.outputs && typeof obj.outputs === "object" && !Array.isArray(obj.outputs) ? (obj.outputs as Record<string, unknown>) : {},
    checks: Array.isArray(obj.checks) ? (obj.checks as CheckResult[]) : []
  };
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const child = spawn(command, args, {
    shell: false,
    cwd,
    env: process.env
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  }

  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  return { code, stdout, stderr, timedOut };
}
