import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { loadButtonRegistryFromFile, resolveButtonEntry, type ButtonRegistryV1 } from "../contract/buttonRegistry";
import { ensureSpellDirs, logsRoot } from "../util/paths";
import { renderReceiptsClientJs, renderReceiptsHtml } from "./ui";

export interface ExecutionApiServerOptions {
  port?: number;
  registryPath?: string;
  requestBodyLimitBytes?: number;
  executionTimeoutMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  maxConcurrentExecutions?: number;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timeout";

interface ExecutionJob {
  execution_id: string;
  button_id: string;
  spell_id: string;
  version: string;
  status: JobStatus;
  actor_role: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error_code?: string;
  message?: string;
  runtime_execution_id?: string;
  runtime_log_path?: string;
  receipt?: Record<string, unknown>;
}

interface CreateExecutionRequest {
  button_id: string;
  dry_run?: boolean;
  input?: Record<string, unknown>;
  confirmation?: {
    risk_acknowledged?: boolean;
    billing_acknowledged?: boolean;
  };
  actor_role?: string;
}

interface StartExecutionApiServerResult {
  port: number;
  close: () => Promise<void>;
}

interface ListExecutionsQuery {
  statuses: Set<JobStatus> | null;
  buttonId: string | null;
  limit: number;
}

interface PersistedExecutionIndexV1 {
  version: "v1";
  updated_at: string;
  executions: ExecutionJob[];
}

const DEFAULT_BODY_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX = 20;
const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 4;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export async function startExecutionApiServer(
  options: ExecutionApiServerOptions = {}
): Promise<StartExecutionApiServerResult> {
  const registryPath = options.registryPath ?? path.join(process.cwd(), "examples", "button-registry.v1.json");
  const registry = await loadButtonRegistryFromFile(registryPath);
  await ensureSpellDirs();

  const executionIndexPath = path.join(logsRoot(), "index.json");
  const jobs = await loadExecutionJobsIndex(executionIndexPath);
  const recovered = recoverInterruptedJobs(jobs);
  const postHistoryByIp = new Map<string, number[]>();
  const runningJobPromises = new Set<Promise<void>>();
  let persistQueue = Promise.resolve();

  const persistJobs = async (): Promise<void> => {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(async () => {
        await writeExecutionJobsIndex(executionIndexPath, jobs);
      });
    await persistQueue;
  };

  if (recovered > 0) {
    await persistJobs();
  }

  const bodyLimit = options.requestBodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const rateMaxRequests = options.rateLimitMaxRequests ?? DEFAULT_RATE_MAX;
  const maxConcurrentExecutions = options.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS;

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (method === "GET" && (pathname === "/" || pathname === "/ui")) {
        return sendText(res, 200, renderReceiptsHtml(), "text/html; charset=utf-8");
      }

      if (method === "GET" && pathname === "/ui/app.js") {
        return sendText(res, 200, renderReceiptsClientJs(), "text/javascript; charset=utf-8");
      }

      const route = normalizeRoute(url.pathname);

      if (method === "GET" && route === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && route === "/spell-executions") {
        if (countInFlightJobs(jobs) >= maxConcurrentExecutions) {
          return sendJson(res, 429, {
            ok: false,
            error_code: "CONCURRENCY_LIMITED",
            message: `too many in-flight executions: max ${maxConcurrentExecutions}`
          });
        }

        const ip = req.socket.remoteAddress ?? "unknown";
        if (!allowRate(ip, postHistoryByIp, rateWindowMs, rateMaxRequests)) {
          return sendJson(res, 429, {
            ok: false,
            error_code: "RATE_LIMITED",
            message: "too many requests"
          });
        }

        let parsed: CreateExecutionRequest;
        let entry: ReturnType<typeof resolveButtonEntry>;
        try {
          const payload = (await readJsonBody(req, bodyLimit)) as unknown;
          parsed = parseCreateExecutionRequest(payload);
          entry = resolveButtonEntry(registry, parsed.button_id);
        } catch (error) {
          const message = (error as Error).message;
          if (message.includes("request body too large")) {
            return sendJson(res, 413, {
              ok: false,
              error_code: "INPUT_TOO_LARGE",
              message: `input payload too large: max ${bodyLimit} bytes`
            });
          }
          if (message.startsWith("unknown button_id:")) {
            return sendJson(res, 404, {
              ok: false,
              error_code: "BUTTON_NOT_FOUND",
              message
            });
          }
          return sendJson(res, 400, {
            ok: false,
            error_code: "BAD_REQUEST",
            message
          });
        }

        const actorRole = parsed.actor_role ?? req.headers["x-role"]?.toString() ?? "anonymous";
        if (!entry.allowed_roles.includes(actorRole)) {
          return sendJson(res, 403, {
            ok: false,
            error_code: "ROLE_NOT_ALLOWED",
            message: `actor role not allowed: ${actorRole}`
          });
        }

        if (entry.required_confirmations.risk && !parsed.confirmation?.risk_acknowledged) {
          return sendJson(res, 400, {
            ok: false,
            error_code: "RISK_CONFIRMATION_REQUIRED",
            message: "risk confirmation is required"
          });
        }

        if (entry.required_confirmations.billing && !parsed.confirmation?.billing_acknowledged) {
          return sendJson(res, 400, {
            ok: false,
            error_code: "BILLING_CONFIRMATION_REQUIRED",
            message: "billing confirmation is required"
          });
        }

        const input = deepMerge(entry.defaults, parsed.input ?? {});
        const inputSizeBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
        if (inputSizeBytes > bodyLimit) {
          return sendJson(res, 413, {
            ok: false,
            error_code: "INPUT_TOO_LARGE",
            message: `input payload too large: max ${bodyLimit} bytes`
          });
        }

        const executionId = `exec_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();

        const job: ExecutionJob = {
          execution_id: executionId,
          button_id: entry.button_id,
          spell_id: entry.spell_id,
          version: entry.version,
          status: "queued",
          actor_role: actorRole,
          created_at: now
        };

        jobs.set(executionId, job);
        await persistJobs();
        let runningJob: Promise<void>;
        runningJob = runJob(
          job,
          input,
          parsed.dry_run ?? false,
          entry.required_confirmations,
          executionTimeoutMs,
          jobs,
          persistJobs
        )
          .catch(() => undefined)
          .finally(() => {
            runningJobPromises.delete(runningJob);
          });
        runningJobPromises.add(runningJob);

        return sendJson(res, 202, {
          ok: true,
          execution_id: executionId,
          status: job.status
        });
      }

      if (method === "GET" && route === "/buttons") {
        return sendJson(res, 200, {
          ok: true,
          version: registry.version,
          buttons: registry.buttons.map((button) => ({
            button_id: button.button_id,
            label: button.label ?? button.button_id,
            description: button.description ?? "",
            spell_id: button.spell_id,
            version: button.version,
            defaults: button.defaults,
            required_confirmations: button.required_confirmations,
            allowed_roles: button.allowed_roles
          }))
        });
      }

      if (method === "GET" && route === "/spell-executions") {
        let query: ListExecutionsQuery;
        try {
          query = parseListExecutionsQuery(url.searchParams);
        } catch (error) {
          return sendJson(res, 400, {
            ok: false,
            error_code: "INVALID_QUERY",
            message: (error as Error).message
          });
        }

        const executions = Array.from(jobs.values())
          .filter((job) => matchJobByQuery(job, query))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, query.limit)
          .map((job) => summarizeJob(job));

        return sendJson(res, 200, {
          ok: true,
          filters: {
            status: query.statuses ? Array.from(query.statuses) : [],
            button_id: query.buttonId ?? null,
            limit: query.limit
          },
          executions
        });
      }

      if (method === "GET" && route.startsWith("/spell-executions/")) {
        const executionId = route.slice("/spell-executions/".length);
        if (!executionId || !/^[a-zA-Z0-9_.-]+$/.test(executionId)) {
          return sendJson(res, 400, { ok: false, error_code: "INVALID_EXECUTION_ID", message: "invalid execution id" });
        }

        const job = jobs.get(executionId);
        if (!job) {
          return sendJson(res, 404, { ok: false, error_code: "EXECUTION_NOT_FOUND", message: "execution not found" });
        }

        return sendJson(res, 200, {
          ok: true,
          execution: summarizeJob(job),
          receipt: job.receipt ?? null
        });
      }

      return sendJson(res, 404, { ok: false, error_code: "NOT_FOUND", message: "route not found" });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error_code: "INTERNAL_ERROR",
        message: (error as Error).message
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to acquire server port");
  }

  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await Promise.allSettled(Array.from(runningJobPromises));
    }
  };
}

async function runJob(
  job: ExecutionJob,
  input: Record<string, unknown>,
  dryRun: boolean,
  confirmations: { risk: boolean; billing: boolean },
  executionTimeoutMs: number,
  jobs: Map<string, ExecutionJob>,
  persistJobs: () => Promise<void>
): Promise<void> {
  const cliPath = path.resolve(process.cwd(), "dist", "cli", "index.js");
  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-exec-api-"));
  const inputPath = path.join(tempDir, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  const args = [cliPath, "cast", job.spell_id, "--version", job.version, "--input", inputPath];
  if (dryRun) args.push("--dry-run");
  if (confirmations.risk) args.push("--yes");
  if (confirmations.billing) args.push("--allow-billing");

  const running: ExecutionJob = {
    ...job,
    status: "running",
    started_at: new Date().toISOString()
  };
  jobs.set(job.execution_id, running);
  await persistJobs();

  const child = spawn(process.execPath, args, {
    shell: false,
    cwd: process.cwd(),
    env: process.env
  });

  let stdout = "";
  let stderr = "";
  let timeoutHit = false;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    timeoutHit = true;
    child.kill("SIGTERM");
  }, executionTimeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).catch(() => -1);

  clearTimeout(timer);

  const runtimeExecutionId = findLineValue(stdout, "execution_id:");
  const runtimeLogPath = findLineValue(stdout, "log:");

  let receipt: Record<string, unknown> | undefined;
  if (runtimeLogPath) {
    receipt = await loadSanitizedReceipt(runtimeLogPath).catch(() => undefined);
  }

  const finishedBase: ExecutionJob = {
    ...running,
    finished_at: new Date().toISOString(),
    runtime_execution_id: runtimeExecutionId,
    runtime_log_path: runtimeLogPath,
    receipt
  };

  if (timeoutHit) {
    jobs.set(job.execution_id, {
      ...finishedBase,
      status: "timeout",
      error_code: "EXECUTION_TIMEOUT",
      message: `execution exceeded timeout ${executionTimeoutMs}ms`
    });
    await persistJobs();
    await rm(tempDir, { recursive: true, force: true });
    return;
  }

  if (exitCode === 0) {
    jobs.set(job.execution_id, {
      ...finishedBase,
      status: "succeeded",
      message: "completed"
    });
    await persistJobs();
    await rm(tempDir, { recursive: true, force: true });
    return;
  }

  const mapped = mapRuntimeError(stderr || stdout);
  jobs.set(job.execution_id, {
    ...finishedBase,
    status: "failed",
    error_code: mapped.code,
    message: mapped.message
  });
  await persistJobs();

  await rm(tempDir, { recursive: true, force: true });
}

function summarizeJob(job: ExecutionJob): Record<string, unknown> {
  return {
    execution_id: job.execution_id,
    button_id: job.button_id,
    spell_id: job.spell_id,
    version: job.version,
    status: job.status,
    actor_role: job.actor_role,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error_code: job.error_code,
    message: job.message,
    runtime_execution_id: job.runtime_execution_id
  };
}

async function loadSanitizedReceipt(runtimeLogPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(runtimeLogPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((step) => {
        const s = step as Record<string, unknown>;
        return {
          stepName: s.stepName,
          uses: s.uses,
          started_at: s.started_at,
          finished_at: s.finished_at,
          success: s.success,
          exitCode: s.exitCode,
          message: s.message
        };
      })
    : [];

  return {
    execution_id: parsed.execution_id,
    id: parsed.id,
    version: parsed.version,
    started_at: parsed.started_at,
    finished_at: parsed.finished_at,
    summary: parsed.summary,
    checks: parsed.checks,
    steps,
    success: parsed.success,
    error: parsed.error
  };
}

function mapRuntimeError(raw: string): { code: string; message: string } {
  if (/risk .* requires --yes/.test(raw)) {
    return { code: "RISK_CONFIRMATION_REQUIRED", message: "risk confirmation required" };
  }
  if (/billing enabled requires --allow-billing/.test(raw)) {
    return { code: "BILLING_CONFIRMATION_REQUIRED", message: "billing confirmation required" };
  }
  if (/missing connector token/.test(raw)) {
    return { code: "CONNECTOR_TOKEN_MISSING", message: "connector token missing" };
  }
  if (/platform mismatch:/.test(raw)) {
    return { code: "PLATFORM_UNSUPPORTED", message: "platform unsupported" };
  }
  if (/input does not match schema/.test(raw)) {
    return { code: "INPUT_SCHEMA_INVALID", message: "input schema invalid" };
  }

  return { code: "EXECUTION_FAILED", message: "execution failed" };
}

function findLineValue(stdout: string, prefix: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return undefined;
}

function parseCreateExecutionRequest(payload: unknown): CreateExecutionRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("request body must be an object");
  }

  const obj = payload as Record<string, unknown>;
  const allowedKeys = new Set(["button_id", "dry_run", "input", "confirmation", "actor_role"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`unsupported field in request body: ${key}`);
    }
  }

  const buttonId = obj.button_id;
  if (typeof buttonId !== "string" || !buttonId.trim()) {
    throw new Error("button_id is required");
  }

  const dryRun = obj.dry_run;
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    throw new Error("dry_run must be boolean");
  }

  const input = obj.input;
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new Error("input must be an object");
  }

  const confirmation = obj.confirmation;
  if (confirmation !== undefined && (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation))) {
    throw new Error("confirmation must be an object");
  }

  const actorRole = obj.actor_role;
  if (actorRole !== undefined && (typeof actorRole !== "string" || !actorRole.trim())) {
    throw new Error("actor_role must be a non-empty string");
  }

  return {
    button_id: buttonId,
    dry_run: dryRun as boolean | undefined,
    input: (input as Record<string, unknown> | undefined) ?? {},
    confirmation: confirmation as CreateExecutionRequest["confirmation"] | undefined,
    actor_role: actorRole as string | undefined
  };
}

function normalizeRoute(pathname: string): string {
  if (pathname.startsWith("/api/")) {
    return pathname.slice(4) || "/";
  }
  return pathname;
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error(`request body too large: max ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function allowRate(
  ip: string,
  history: Map<string, number[]>,
  windowMs: number,
  maxRequests: number
): boolean {
  const now = Date.now();
  const list = history.get(ip) ?? [];
  const filtered = list.filter((time) => now - time <= windowMs);

  if (filtered.length >= maxRequests) {
    history.set(ip, filtered);
    return false;
  }

  filtered.push(now);
  history.set(ip, filtered);
  return true;
}

function countInFlightJobs(jobs: Map<string, ExecutionJob>): number {
  let total = 0;
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") {
      total += 1;
    }
  }
  return total;
}

function parseListExecutionsQuery(params: URLSearchParams): ListExecutionsQuery {
  const statusParam = params.get("status");
  const buttonIdParam = params.get("button_id");
  const limitParam = params.get("limit");

  let statuses: Set<JobStatus> | null = null;
  if (statusParam && statusParam.trim() !== "") {
    statuses = new Set<JobStatus>();
    for (const raw of statusParam.split(",")) {
      const value = raw.trim();
      if (!value) continue;
      if (!isJobStatus(value)) {
        throw new Error(`invalid status filter: ${value}`);
      }
      statuses.add(value);
    }
    if (statuses.size === 0) {
      statuses = null;
    }
  }

  let limit = DEFAULT_LIST_LIMIT;
  if (limitParam && limitParam.trim() !== "") {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
      throw new Error(`invalid limit: must be integer in range 1-${MAX_LIST_LIMIT}`);
    }
    limit = parsed;
  }

  const buttonId = buttonIdParam && buttonIdParam.trim() !== "" ? buttonIdParam.trim() : null;

  return {
    statuses,
    buttonId,
    limit
  };
}

function matchJobByQuery(job: ExecutionJob, query: ListExecutionsQuery): boolean {
  if (query.statuses && !query.statuses.has(job.status)) {
    return false;
  }
  if (query.buttonId && job.button_id !== query.buttonId) {
    return false;
  }
  return true;
}

function isJobStatus(value: string): value is JobStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "timeout";
}

function recoverInterruptedJobs(jobs: Map<string, ExecutionJob>): number {
  let recovered = 0;
  const now = new Date().toISOString();

  for (const [executionId, job] of jobs.entries()) {
    if (job.status !== "queued" && job.status !== "running") {
      continue;
    }

    jobs.set(executionId, {
      ...job,
      status: "failed",
      finished_at: now,
      error_code: "SERVER_RESTARTED",
      message: "execution interrupted by server restart"
    });
    recovered += 1;
  }

  return recovered;
}

async function loadExecutionJobsIndex(filePath: string): Promise<Map<string, ExecutionJob>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return new Map<string, ExecutionJob>();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return new Map<string, ExecutionJob>();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map<string, ExecutionJob>();
  }

  const index = parsed as Partial<PersistedExecutionIndexV1>;
  if (index.version !== "v1" || !Array.isArray(index.executions)) {
    return new Map<string, ExecutionJob>();
  }

  const jobs = new Map<string, ExecutionJob>();
  for (const item of index.executions) {
    if (!isExecutionJob(item)) {
      continue;
    }
    jobs.set(item.execution_id, item);
  }

  return jobs;
}

async function writeExecutionJobsIndex(filePath: string, jobs: Map<string, ExecutionJob>): Promise<void> {
  const payload: PersistedExecutionIndexV1 = {
    version: "v1",
    updated_at: new Date().toISOString(),
    executions: Array.from(jobs.values())
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isExecutionJob(value: unknown): value is ExecutionJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.execution_id === "string" &&
    typeof obj.button_id === "string" &&
    typeof obj.spell_id === "string" &&
    typeof obj.version === "string" &&
    typeof obj.actor_role === "string" &&
    typeof obj.created_at === "string" &&
    typeof obj.status === "string" &&
    isJobStatus(obj.status)
  );
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];

    if (isPlainObject(baseValue) && isPlainObject(value)) {
      out[key] = deepMerge(baseValue, value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
