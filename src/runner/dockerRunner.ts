import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { SpellBundleManifest, CheckResult, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { formatExecutionTimeoutMessage } from "./runtimeLimits";

type DockerNetworkMode = "none" | "bridge" | "host";

interface DockerRunConfig {
  network: DockerNetworkMode;
  user?: string;
  readOnly: boolean;
  pidsLimit?: number;
  memory?: string;
  cpus?: string;
}

const DEFAULT_DOCKER_NETWORK: DockerNetworkMode = "none";
const DEFAULT_DOCKER_USER = "65532:65532";
const DEFAULT_DOCKER_PIDS_LIMIT = 256;

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

export function buildDockerArgs(
  dockerImage: string,
  bundlePath: string,
  tempDir: string,
  manifest: SpellBundleManifest,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const inputInContainer = "/tmp/spell-input/input.json";
  const runnerWorkRoot = "/spell-work";
  const envVars = collectEnvVarsToPass(manifest, env);
  const dockerRunConfig = readDockerRunConfig(env);

  const args: string[] = [
    "run",
    "--rm",
    "-i",
    "--network",
    dockerRunConfig.network,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs",
    `${runnerWorkRoot}:rw,nosuid,size=64m`,
    "--workdir",
    "/spell",
    "-v",
    `${path.resolve(bundlePath)}:/spell:ro`,
    "-v",
    `${path.resolve(tempDir)}:/tmp/spell-input:ro`,
    "-e",
    `INPUT_JSON=${inputInContainer}`,
    "-e",
    `SPELL_RUNNER_WORK_ROOT=${runnerWorkRoot}`
  ];

  if (dockerRunConfig.readOnly) {
    args.push("--read-only");
  }

  if (dockerRunConfig.user !== undefined) {
    args.push("--user", dockerRunConfig.user);
  }

  if (dockerRunConfig.pidsLimit !== undefined) {
    args.push("--pids-limit", String(dockerRunConfig.pidsLimit));
  }

  if (dockerRunConfig.memory !== undefined) {
    args.push("--memory", dockerRunConfig.memory);
  }

  if (dockerRunConfig.cpus !== undefined) {
    args.push("--cpus", dockerRunConfig.cpus);
  }

  for (const [key, value] of envVars) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(dockerImage, "spell-runner", "/spell/spell.yaml", inputInContainer);
  return args;
}

function collectEnvVarsToPass(manifest: SpellBundleManifest, env: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  // pass connector tokens (and fail earlier if missing)
  for (const permission of manifest.permissions) {
    const tokenKey = `CONNECTOR_${permission.connector.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
    const value = env[tokenKey];
    if (typeof value === "string" && value.trim() !== "") {
      out.push([tokenKey, value]);
    }
  }

  const stepTimeout = env.SPELL_RUNTIME_STEP_TIMEOUT_MS;
  if (typeof stepTimeout === "string" && stepTimeout.trim() !== "") {
    out.push(["SPELL_RUNTIME_STEP_TIMEOUT_MS", stepTimeout.trim()]);
  }

  return out;
}

function readDockerRunConfig(env: NodeJS.ProcessEnv): DockerRunConfig {
  return {
    network: readDockerNetwork(env),
    user: readDockerUser(env),
    readOnly: readDockerReadOnly(env),
    pidsLimit: readDockerPidsLimit(env),
    memory: readDockerMemory(env),
    cpus: readDockerCpus(env)
  };
}

function readDockerNetwork(env: NodeJS.ProcessEnv): DockerNetworkMode {
  const raw = env.SPELL_DOCKER_NETWORK;
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_DOCKER_NETWORK : raw.trim();
  if (value === "none" || value === "bridge" || value === "host") {
    return value;
  }

  throw new SpellError("SPELL_DOCKER_NETWORK must be one of: none, bridge, host");
}

function readDockerUser(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SPELL_DOCKER_USER;
  if (raw === undefined) {
    return DEFAULT_DOCKER_USER;
  }

  const value = raw.trim();
  if (value === "") {
    return undefined;
  }

  if (/\s/.test(value)) {
    throw new SpellError("SPELL_DOCKER_USER must not contain whitespace");
  }

  return value;
}

function readDockerReadOnly(env: NodeJS.ProcessEnv): boolean {
  const raw = env.SPELL_DOCKER_READ_ONLY;
  if (raw === undefined || raw.trim() === "") {
    return true;
  }

  const value = raw.trim();
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }

  throw new SpellError("SPELL_DOCKER_READ_ONLY must be '1' or '0'");
}

function readDockerPidsLimit(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SPELL_DOCKER_PIDS_LIMIT;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DOCKER_PIDS_LIMIT;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new SpellError("SPELL_DOCKER_PIDS_LIMIT must be an integer >= 0");
  }

  if (value === 0) {
    return undefined;
  }

  return value;
}

function readDockerMemory(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SPELL_DOCKER_MEMORY;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const value = raw.trim();
  if (!/^\d+[bkmg]?$/i.test(value)) {
    throw new SpellError("SPELL_DOCKER_MEMORY must be a positive integer optionally suffixed with b, k, m, or g");
  }

  return value;
}

function readDockerCpus(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SPELL_DOCKER_CPUS;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const value = raw.trim();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SpellError("SPELL_DOCKER_CPUS must be a number > 0");
  }

  return value;
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
