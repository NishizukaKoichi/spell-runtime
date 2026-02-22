import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { loadButtonRegistryFromFile, resolveButtonEntry, type ButtonRegistryV1 } from "../contract/buttonRegistry";
import { ensureSpellDirs, logsRoot } from "../util/paths";
import { resolveOutputReference } from "../util/outputs";
import { renderReceiptsClientJs, renderReceiptsHtml } from "./ui";

export interface ExecutionApiServerOptions {
  port?: number;
  registryPath?: string;
  requestBodyLimitBytes?: number;
  executionTimeoutMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  tenantRateLimitWindowMs?: number;
  tenantRateLimitMaxRequests?: number;
  maxConcurrentExecutions?: number;
  tenantMaxConcurrentExecutions?: number;
  authTokens?: string[];
  authKeys?: string[];
  logRetentionDays?: number;
  logMaxFiles?: number;
  forceRequireSignature?: boolean;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timeout" | "canceled";

interface ApiAuthKey {
  tenantId: string;
  role: string;
  token: string;
}

type ApiAuthContext = { ok: true; tenantId: string; role?: string } | { ok: false; errorCode: string; message: string };

interface ExecutionJob {
  execution_id: string;
  button_id: string;
  spell_id: string;
  version: string;
  require_signature: boolean;
  status: JobStatus;
  tenant_id: string;
  actor_role: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error_code?: string;
  message?: string;
  runtime_execution_id?: string;
  runtime_log_path?: string;
  receipt?: Record<string, unknown>;
  idempotency_key?: string;
  idempotency_fingerprint?: string;
  request?: ExecutionRequestSnapshot;
  retry_of?: string;
  retried_by?: string;
}

interface ExecutionRequestSnapshot {
  input: Record<string, unknown>;
  dry_run: boolean;
  confirmation: {
    risk_acknowledged: boolean;
    billing_acknowledged: boolean;
  };
}

interface ExecutionRuntimeState {
  cancelRequested: boolean;
  child: ChildProcessWithoutNullStreams | null;
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
  spellId: string | null;
  tenantId: string | null;
  limit: number;
  fromAtMs: number | null;
  toAtMs: number | null;
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
const DEFAULT_TENANT_RATE_WINDOW_MS = 60_000;
const DEFAULT_TENANT_RATE_MAX = 20;
const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 4;
const DEFAULT_TENANT_MAX_CONCURRENT_EXECUTIONS = 2;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LOG_RETENTION_DAYS = 14;
const DEFAULT_LOG_MAX_FILES = 500;
const STREAM_POLL_INTERVAL_MS = 150;
const STREAM_HEARTBEAT_MS = 15_000;
const DEFAULT_TENANT_ID = "default";
const AUTH_KEY_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

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
  const postHistoryByTenant = new Map<string, number[]>();
  const runningJobPromises = new Set<Promise<void>>();
  const tenantAuditPath = path.join(logsRoot(), "tenant-audit.jsonl");
  const runtimeStateByExecutionId = new Map<string, ExecutionRuntimeState>();
  let tenantAuditQueue = Promise.resolve();
  let persistQueue = Promise.resolve();

  const persistJobs = async (): Promise<void> => {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(async () => {
        await writeExecutionJobsIndex(executionIndexPath, jobs);
      });
    await persistQueue;
  };
  const appendTenantAudit = async (job: ExecutionJob): Promise<void> => {
    const event = makeTenantAuditEvent(job);
    const line = `${JSON.stringify(event)}\n`;
    tenantAuditQueue = tenantAuditQueue
      .catch(() => undefined)
      .then(async () => {
        await appendFile(tenantAuditPath, line, "utf8");
      });
    await tenantAuditQueue;
  };

  const bodyLimit = options.requestBodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const rateMaxRequests = options.rateLimitMaxRequests ?? DEFAULT_RATE_MAX;
  const tenantRateWindowMs = options.tenantRateLimitWindowMs ?? DEFAULT_TENANT_RATE_WINDOW_MS;
  const tenantRateMaxRequests = options.tenantRateLimitMaxRequests ?? DEFAULT_TENANT_RATE_MAX;
  const maxConcurrentExecutions = options.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  const tenantMaxConcurrentExecutions =
    options.tenantMaxConcurrentExecutions ?? DEFAULT_TENANT_MAX_CONCURRENT_EXECUTIONS;
  const authTokens = new Set(
    (options.authTokens ?? []).map((token) => token.trim()).filter((token) => token.length > 0)
  );
  const authKeys = parseAuthKeys(options.authKeys ?? []);
  const forceRequireSignature = options.forceRequireSignature ?? false;
  if (authTokens.size > 0 && authKeys.length > 0) {
    throw new Error("API auth config error: use either authTokens or authKeys (role-based), not both");
  }
  const logRetentionDays = options.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  const logMaxFiles = options.logMaxFiles ?? DEFAULT_LOG_MAX_FILES;
  const logsDirectory = logsRoot();

  const prunedOnBoot = await applyLogRetentionPolicy(logsDirectory, jobs, logRetentionDays, logMaxFiles);

  if (recovered > 0 || prunedOnBoot) {
    await persistJobs();
  }

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

      const authContext: ApiAuthContext = requiresApiAuth(route)
        ? authorizeRequest(req, authTokens, authKeys)
        : ({ ok: true, tenantId: DEFAULT_TENANT_ID } as const);

      if (requiresApiAuth(route)) {
        if (!authContext.ok) {
          return sendJson(res, 401, {
            ok: false,
            error_code: authContext.errorCode,
            message: authContext.message
          });
        }
      }

      const checkSubmissionLimits = (tenantId: string): { statusCode: number; payload: Record<string, unknown> } | null => {
        if (countInFlightJobs(jobs) >= maxConcurrentExecutions) {
          return {
            statusCode: 429,
            payload: {
              ok: false,
              error_code: "CONCURRENCY_LIMITED",
              message: `too many in-flight executions: max ${maxConcurrentExecutions}`
            }
          };
        }

        if (countInFlightJobsForTenant(jobs, tenantId) >= tenantMaxConcurrentExecutions) {
          return {
            statusCode: 429,
            payload: {
              ok: false,
              error_code: "TENANT_CONCURRENCY_LIMITED",
              message: `too many in-flight executions for tenant ${tenantId}: max ${tenantMaxConcurrentExecutions}`
            }
          };
        }

        const ip = req.socket.remoteAddress ?? "unknown";
        if (!allowRate(ip, postHistoryByIp, rateWindowMs, rateMaxRequests)) {
          return {
            statusCode: 429,
            payload: {
              ok: false,
              error_code: "RATE_LIMITED",
              message: "too many requests"
            }
          };
        }

        if (!allowRate(tenantId, postHistoryByTenant, tenantRateWindowMs, tenantRateMaxRequests)) {
          return {
            statusCode: 429,
            payload: {
              ok: false,
              error_code: "TENANT_RATE_LIMITED",
              message: `too many requests for tenant ${tenantId}`
            }
          };
        }

        return null;
      };

      const startJobRunner = (job: ExecutionJob): void => {
        if (!job.request) {
          throw new Error(`execution request snapshot missing: ${job.execution_id}`);
        }

        let runningJob: Promise<void>;
        runningJob = runJob(
          job,
          cloneExecutionInput(job.request.input),
          job.request.dry_run,
          {
            risk: job.request.confirmation.risk_acknowledged,
            billing: job.request.confirmation.billing_acknowledged
          },
          job.require_signature,
          executionTimeoutMs,
          jobs,
          runtimeStateByExecutionId,
          persistJobs,
          appendTenantAudit,
          {
            logsDirectory,
            logRetentionDays,
            logMaxFiles
          }
        )
          .catch(() => undefined)
          .finally(() => {
            runningJobPromises.delete(runningJob);
          });
        runningJobPromises.add(runningJob);
      };

      const queueExecutionJob = async (job: ExecutionJob): Promise<void> => {
        jobs.set(job.execution_id, job);
        await persistJobs();
        await appendTenantAudit(job).catch(() => undefined);
        startJobRunner(job);
      };

      if (method === "POST" && route === "/spell-executions") {
        const tenantId = authContext.ok ? authContext.tenantId : DEFAULT_TENANT_ID;
        const parsedIdempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"]);
        if (!parsedIdempotencyKey.ok) {
          return sendJson(res, 400, {
            ok: false,
            error_code: "BAD_REQUEST",
            message: parsedIdempotencyKey.message
          });
        }
        const idempotencyKey = parsedIdempotencyKey.key;

        if (!idempotencyKey) {
          const limitError = checkSubmissionLimits(tenantId);
          if (limitError) {
            return sendJson(res, limitError.statusCode, limitError.payload);
          }
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

        const actorRole =
          ("role" in authContext ? authContext.role : undefined) ??
          parsed.actor_role ??
          req.headers["x-role"]?.toString() ??
          "anonymous";
        if (Array.isArray(entry.allowed_tenants) && entry.allowed_tenants.length > 0) {
          if (!entry.allowed_tenants.includes(tenantId)) {
            return sendJson(res, 403, {
              ok: false,
              error_code: "TENANT_NOT_ALLOWED",
              message: `tenant ${tenantId} is not allowed for button ${entry.button_id}`
            });
          }
        }

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

        const dryRun = parsed.dry_run ?? false;
        const confirmationFlags = normalizeConfirmationFlags(parsed.confirmation);
        const executionConfirmations = {
          risk_acknowledged: entry.required_confirmations.risk && confirmationFlags.risk_acknowledged,
          billing_acknowledged: entry.required_confirmations.billing && confirmationFlags.billing_acknowledged
        };
        let idempotencyFingerprint: string | undefined;
        if (idempotencyKey) {
          idempotencyFingerprint = computeExecutionRequestFingerprint({
            tenant_id: tenantId,
            button_id: entry.button_id,
            input,
            dry_run: dryRun,
            confirmation: confirmationFlags,
            actor_role: actorRole
          });
          const existing = findExistingJobByIdempotencyKey(jobs, tenantId, idempotencyKey);
          if (existing) {
            if (existing.idempotency_fingerprint === idempotencyFingerprint) {
              return sendJson(res, 202, {
                ok: true,
                execution_id: existing.execution_id,
                tenant_id: existing.tenant_id,
                status: existing.status,
                idempotent_replay: true
              });
            }

            return sendJson(res, 409, {
              ok: false,
              error_code: "IDEMPOTENCY_CONFLICT",
              message: "idempotency key already used with a different request"
            });
          }

          const limitError = checkSubmissionLimits(tenantId);
          if (limitError) {
            return sendJson(res, limitError.statusCode, limitError.payload);
          }
        }

        const executionId = `exec_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const requireSignature = forceRequireSignature || entry.require_signature === true;

        const job: ExecutionJob = {
          execution_id: executionId,
          button_id: entry.button_id,
          spell_id: entry.spell_id,
          version: entry.version,
          require_signature: requireSignature,
          status: "queued",
          tenant_id: tenantId,
          actor_role: actorRole,
          created_at: now,
          idempotency_key: idempotencyKey ?? undefined,
          idempotency_fingerprint: idempotencyFingerprint,
          request: {
            input: cloneExecutionInput(input),
            dry_run: dryRun,
            confirmation: {
              risk_acknowledged: executionConfirmations.risk_acknowledged,
              billing_acknowledged: executionConfirmations.billing_acknowledged
            }
          }
        };

        await queueExecutionJob(job);

        return sendJson(res, 202, {
          ok: true,
          execution_id: executionId,
          tenant_id: job.tenant_id,
          status: job.status
        });
      }

      if (method === "POST" && route.startsWith("/spell-executions/") && route.endsWith("/cancel")) {
        const matched = /^\/spell-executions\/([^/]+)\/cancel$/.exec(route);
        const executionId = matched && matched[1] ? matched[1].trim() : "";
        if (!executionId || !/^[a-zA-Z0-9_.-]+$/.test(executionId)) {
          return sendJson(res, 400, { ok: false, error_code: "INVALID_EXECUTION_ID", message: "invalid execution id" });
        }

        const existing = jobs.get(executionId);
        if (!existing) {
          return sendJson(res, 404, { ok: false, error_code: "EXECUTION_NOT_FOUND", message: "execution not found" });
        }

        if (authKeys.length > 0 && authContext.ok && authContext.role !== "admin" && authContext.tenantId !== existing.tenant_id) {
          return sendJson(res, 403, {
            ok: false,
            error_code: "TENANT_FORBIDDEN",
            message: `tenant cancel denied: ${existing.tenant_id}`
          });
        }

        if (isTerminalJobStatus(existing.status)) {
          return sendJson(res, 409, {
            ok: false,
            error_code: "ALREADY_TERMINAL",
            message: `execution already terminal: ${existing.status}`
          });
        }

        const runtimeState = runtimeStateByExecutionId.get(executionId) ?? {
          cancelRequested: false,
          child: null
        };
        runtimeState.cancelRequested = true;
        runtimeStateByExecutionId.set(executionId, runtimeState);
        if (existing.status === "running" && runtimeState.child) {
          runtimeState.child.kill("SIGTERM");
        }

        const canceled: ExecutionJob = {
          ...existing,
          status: "canceled",
          finished_at: new Date().toISOString(),
          error_code: "EXECUTION_CANCELED",
          message: "execution canceled by request"
        };
        jobs.set(executionId, canceled);
        await persistJobs();
        await appendTenantAudit(canceled).catch(() => undefined);

        return sendJson(res, 200, {
          ok: true,
          execution_id: canceled.execution_id,
          tenant_id: canceled.tenant_id,
          status: canceled.status
        });
      }

      if (method === "POST" && route.startsWith("/spell-executions/") && route.endsWith("/retry")) {
        const matched = /^\/spell-executions\/([^/]+)\/retry$/.exec(route);
        const executionId = matched && matched[1] ? matched[1].trim() : "";
        if (!executionId || !/^[a-zA-Z0-9_.-]+$/.test(executionId)) {
          return sendJson(res, 400, { ok: false, error_code: "INVALID_EXECUTION_ID", message: "invalid execution id" });
        }

        const existing = jobs.get(executionId);
        if (!existing) {
          return sendJson(res, 404, { ok: false, error_code: "EXECUTION_NOT_FOUND", message: "execution not found" });
        }

        if (authKeys.length > 0 && authContext.ok && authContext.role !== "admin" && authContext.tenantId !== existing.tenant_id) {
          return sendJson(res, 403, {
            ok: false,
            error_code: "TENANT_FORBIDDEN",
            message: `tenant retry denied: ${existing.tenant_id}`
          });
        }

        if (!isRetryableJobStatus(existing.status)) {
          return sendJson(res, 409, {
            ok: false,
            error_code: "NOT_RETRYABLE",
            message: `execution is not retryable: ${existing.status}`
          });
        }

        if (!existing.request) {
          return sendJson(res, 409, {
            ok: false,
            error_code: "NOT_RETRYABLE",
            message: "execution request snapshot is unavailable for retry"
          });
        }

        const limitError = checkSubmissionLimits(existing.tenant_id);
        if (limitError) {
          return sendJson(res, limitError.statusCode, limitError.payload);
        }

        const retryExecutionId = `exec_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const queuedAt = new Date().toISOString();
        const retriedSource: ExecutionJob = {
          ...existing,
          retried_by: retryExecutionId
        };
        const retryJob: ExecutionJob = {
          execution_id: retryExecutionId,
          button_id: existing.button_id,
          spell_id: existing.spell_id,
          version: existing.version,
          require_signature: existing.require_signature,
          status: "queued",
          tenant_id: existing.tenant_id,
          actor_role: existing.actor_role,
          created_at: queuedAt,
          request: cloneExecutionRequestSnapshot(existing.request),
          retry_of: existing.execution_id
        };

        jobs.set(existing.execution_id, retriedSource);
        await queueExecutionJob(retryJob);

        return sendJson(res, 202, {
          ok: true,
          execution_id: retryJob.execution_id,
          tenant_id: retryJob.tenant_id,
          status: retryJob.status,
          retry_of: retryJob.retry_of
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
            require_signature: forceRequireSignature || button.require_signature === true,
            allowed_roles: button.allowed_roles,
            allowed_tenants: button.allowed_tenants ?? null
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

        const scoped = scopeListExecutionsQuery(query, authContext, authKeys.length > 0);
        if (!scoped.ok) {
          return sendJson(res, 403, {
            ok: false,
            error_code: scoped.errorCode,
            message: scoped.message
          });
        }

        const effectiveQuery = scoped.query;
        const executions = Array.from(jobs.values())
          .filter((job) => matchJobByQuery(job, effectiveQuery))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, effectiveQuery.limit)
          .map((job) => summarizeJob(job));

        return sendJson(res, 200, {
          ok: true,
          filters: {
            status: effectiveQuery.statuses ? Array.from(effectiveQuery.statuses) : [],
            button_id: effectiveQuery.buttonId ?? null,
            spell_id: effectiveQuery.spellId ?? null,
            tenant_id: effectiveQuery.tenantId ?? null,
            limit: effectiveQuery.limit,
            from: effectiveQuery.fromAtMs !== null ? new Date(effectiveQuery.fromAtMs).toISOString() : null,
            to: effectiveQuery.toAtMs !== null ? new Date(effectiveQuery.toAtMs).toISOString() : null
          },
          executions
        });
      }

      if (method === "GET" && route.startsWith("/tenants/") && route.endsWith("/usage")) {
        const matched = /^\/tenants\/([^/]+)\/usage$/.exec(route);
        const tenantId = matched && matched[1] ? matched[1].trim() : "";
        if (!tenantId || !AUTH_KEY_SEGMENT_PATTERN.test(tenantId)) {
          return sendJson(res, 400, {
            ok: false,
            error_code: "INVALID_TENANT_ID",
            message: "invalid tenant id"
          });
        }

        if (authKeys.length > 0 && (!authContext.ok || authContext.role !== "admin")) {
          return sendJson(res, 403, {
            ok: false,
            error_code: "ADMIN_ROLE_REQUIRED",
            message: "admin role required for tenant usage"
          });
        }

        return sendJson(res, 200, {
          ok: true,
          tenant_id: tenantId,
          usage: summarizeTenantUsage(jobs, tenantId)
        });
      }

      if (method === "GET" && route.startsWith("/spell-executions/") && route.endsWith("/output")) {
        const matched = /^\/spell-executions\/([^/]+)\/output$/.exec(route);
        const executionId = matched && matched[1] ? matched[1].trim() : "";
        if (!executionId || !/^[a-zA-Z0-9_.-]+$/.test(executionId)) {
          return sendJson(res, 400, { ok: false, error_code: "INVALID_EXECUTION_ID", message: "invalid execution id" });
        }

        const outputPath = String(url.searchParams.get("path") ?? "").trim();
        if (!outputPath) {
          return sendJson(res, 400, {
            ok: false,
            error_code: "INVALID_QUERY",
            message: "path query is required"
          });
        }

        const job = jobs.get(executionId);
        if (!job) {
          return sendJson(res, 404, { ok: false, error_code: "EXECUTION_NOT_FOUND", message: "execution not found" });
        }

        if (authKeys.length > 0 && authContext.ok && authContext.role !== "admin" && authContext.tenantId !== job.tenant_id) {
          return sendJson(res, 403, {
            ok: false,
            error_code: "TENANT_FORBIDDEN",
            message: `tenant output denied: ${job.tenant_id}`
          });
        }

        if (!job.runtime_log_path) {
          return sendJson(res, 409, {
            ok: false,
            error_code: "EXECUTION_NOT_READY",
            message: "execution log is not available yet"
          });
        }

        try {
          const value = await readOutputValueFromRuntimeLog(job.runtime_log_path, outputPath);
          return sendJson(res, 200, {
            ok: true,
            execution_id: job.execution_id,
            path: outputPath,
            value
          });
        } catch (error) {
          const message = (error as Error).message;
          if (message.startsWith("invalid output reference:") || message.startsWith("stdout reference does not support")) {
            return sendJson(res, 400, {
              ok: false,
              error_code: "INVALID_OUTPUT_PATH",
              message
            });
          }
          if (
            message.startsWith("output reference not found:") ||
            message.startsWith("output value not found:") ||
            message === "execution log has no outputs"
          ) {
            return sendJson(res, 404, {
              ok: false,
              error_code: "OUTPUT_NOT_FOUND",
              message
            });
          }
          if (message === "execution log not found") {
            return sendJson(res, 404, {
              ok: false,
              error_code: "EXECUTION_LOG_NOT_FOUND",
              message
            });
          }
          throw error;
        }
      }

      if (method === "GET" && route.startsWith("/spell-executions/") && route.endsWith("/events")) {
        const matched = /^\/spell-executions\/([^/]+)\/events$/.exec(route);
        const executionId = matched && matched[1] ? matched[1].trim() : "";
        if (!executionId || !/^[a-zA-Z0-9_.-]+$/.test(executionId)) {
          return sendJson(res, 400, { ok: false, error_code: "INVALID_EXECUTION_ID", message: "invalid execution id" });
        }

        const existing = jobs.get(executionId);
        if (!existing) {
          return sendJson(res, 404, { ok: false, error_code: "EXECUTION_NOT_FOUND", message: "execution not found" });
        }

        if (authKeys.length > 0 && authContext.ok && authContext.role !== "admin" && authContext.tenantId !== existing.tenant_id) {
          return sendJson(res, 403, {
            ok: false,
            error_code: "TENANT_FORBIDDEN",
            message: `tenant stream denied: ${existing.tenant_id}`
          });
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders?.();

        let closed = false;
        let lastSnapshot = "";
        let pollTimer: NodeJS.Timeout | undefined;
        let heartbeatTimer: NodeJS.Timeout | undefined;

        const closeStream = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          if (!res.writableEnded) {
            res.end();
          }
        };

        const writeEvent = (eventName: string, payload: Record<string, unknown>): void => {
          if (closed || res.writableEnded) {
            return;
          }
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const readSnapshot = (job: ExecutionJob): { execution: Record<string, unknown>; receipt: Record<string, unknown> | null } => {
          return {
            execution: summarizeJob(job),
            receipt: job.receipt ?? null
          };
        };

        const emitIfChanged = (eventName: string, job: ExecutionJob): boolean => {
          const snapshot = readSnapshot(job);
          const serialized = JSON.stringify(snapshot);
          if (serialized === lastSnapshot) {
            return false;
          }
          writeEvent(eventName, snapshot);
          lastSnapshot = serialized;
          return true;
        };

        const emitTerminalAndClose = (job: ExecutionJob): void => {
          const snapshot = readSnapshot(job);
          writeEvent("terminal", snapshot);
          closeStream();
        };

        req.once("close", closeStream);
        req.once("aborted", closeStream);

        const current = jobs.get(executionId);
        if (!current) {
          writeEvent("terminal", {
            execution_id: executionId,
            error_code: "EXECUTION_NOT_FOUND",
            message: "execution not found"
          });
          return closeStream();
        }

        writeEvent("snapshot", readSnapshot(current));
        lastSnapshot = JSON.stringify(readSnapshot(current));
        if (isTerminalJobStatus(current.status)) {
          emitTerminalAndClose(current);
          return;
        }

        pollTimer = setInterval(() => {
          if (closed) {
            return;
          }
          const latest = jobs.get(executionId);
          if (!latest) {
            writeEvent("terminal", {
              execution_id: executionId,
              error_code: "EXECUTION_NOT_FOUND",
              message: "execution not found"
            });
            closeStream();
            return;
          }
          emitIfChanged("execution", latest);
          if (isTerminalJobStatus(latest.status)) {
            emitTerminalAndClose(latest);
          }
        }, STREAM_POLL_INTERVAL_MS);

        heartbeatTimer = setInterval(() => {
          if (closed || res.writableEnded) {
            return;
          }
          res.write(": ping\n\n");
        }, STREAM_HEARTBEAT_MS);

        return;
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
  requireSignature: boolean,
  executionTimeoutMs: number,
  jobs: Map<string, ExecutionJob>,
  runtimeStateByExecutionId: Map<string, ExecutionRuntimeState>,
  persistJobs: () => Promise<void>,
  appendTenantAudit: (job: ExecutionJob) => Promise<void>,
  retention: {
    logsDirectory: string;
    logRetentionDays: number;
    logMaxFiles: number;
  }
): Promise<void> {
  const cliPath = path.resolve(process.cwd(), "dist", "cli", "index.js");
  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-exec-api-"));
  const inputPath = path.join(tempDir, "input.json");
  const runtimeState = runtimeStateByExecutionId.get(job.execution_id) ?? {
    cancelRequested: false,
    child: null
  };
  runtimeStateByExecutionId.set(job.execution_id, runtimeState);

  try {
    await writeFile(inputPath, JSON.stringify(input), "utf8");

    const args = [cliPath, "cast", job.spell_id, "--version", job.version, "--input", inputPath];
    if (dryRun) args.push("--dry-run");
    if (confirmations.risk) args.push("--yes");
    if (confirmations.billing) args.push("--allow-billing");
    if (requireSignature) {
      args.push("--require-signature");
    } else {
      args.push("--allow-unsigned");
    }

    if (isCancellationRequested(jobs, runtimeStateByExecutionId, job.execution_id)) {
      return;
    }

    const running: ExecutionJob = {
      ...job,
      status: "running",
      started_at: new Date().toISOString()
    };
    jobs.set(job.execution_id, running);
    await persistJobs();
    await appendTenantAudit(running).catch(() => undefined);

    if (isCancellationRequested(jobs, runtimeStateByExecutionId, job.execution_id)) {
      return;
    }

    const child = spawn(process.execPath, args, {
      shell: false,
      cwd: process.cwd(),
      env: process.env
    });
    runtimeState.child = child;
    if (runtimeState.cancelRequested) {
      child.kill("SIGTERM");
    }

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
    runtimeState.child = null;

    let runtimeExecutionId = findLineValue(stdout, "execution_id:");
    let runtimeLogPath = findLineValue(stdout, "log:");
    if (!runtimeLogPath) {
      const inferred = await inferRuntimeLogFromDisk(retention.logsDirectory, job, running.started_at ?? job.created_at);
      if (inferred) {
        runtimeLogPath = inferred.path;
        if (!runtimeExecutionId && inferred.executionId) {
          runtimeExecutionId = inferred.executionId;
        }
      }
    }

    let receipt: Record<string, unknown> | undefined;
    if (runtimeLogPath) {
      receipt = await loadSanitizedReceipt(runtimeLogPath).catch(() => undefined);
      if (receipt) {
        receipt = {
          ...receipt,
          tenant_id: job.tenant_id
        };
      }
    }

    const finishedBase: ExecutionJob = {
      ...running,
      finished_at: new Date().toISOString(),
      runtime_execution_id: runtimeExecutionId,
      runtime_log_path: runtimeLogPath,
      receipt
    };

    if (isCancellationRequested(jobs, runtimeStateByExecutionId, job.execution_id)) {
      return;
    }

    if (timeoutHit) {
      const timedOut: ExecutionJob = {
        ...finishedBase,
        status: "timeout",
        error_code: "EXECUTION_TIMEOUT",
        message: `execution exceeded timeout ${executionTimeoutMs}ms`
      };
      jobs.set(job.execution_id, timedOut);
      await persistJobs();
      await appendTenantAudit(timedOut).catch(() => undefined);
      await applyLogRetentionAndPersist(retention, jobs, persistJobs);
      return;
    }

    if (exitCode === 0) {
      const succeeded: ExecutionJob = {
        ...finishedBase,
        status: "succeeded",
        message: "completed"
      };
      jobs.set(job.execution_id, succeeded);
      await persistJobs();
      await appendTenantAudit(succeeded).catch(() => undefined);
      await applyLogRetentionAndPersist(retention, jobs, persistJobs);
      return;
    }

    const mapped = mapRuntimeError(stderr || stdout);
    const rollbackAssessment = assessRollbackFromReceipt(receipt);
    const effectiveMapped = rollbackAssessment.manualRecoveryRequired
      ? {
          code: "COMPENSATION_INCOMPLETE",
          message: `manual recovery required: compensation state=${rollbackAssessment.state ?? "unknown"}`
        }
      : mapped;
    const status: JobStatus = effectiveMapped.code === "EXECUTION_TIMEOUT" ? "timeout" : "failed";
    const failed: ExecutionJob = {
      ...finishedBase,
      status,
      error_code: effectiveMapped.code,
      message: effectiveMapped.message
    };
    jobs.set(job.execution_id, failed);
    await persistJobs();
    await appendTenantAudit(failed).catch(() => undefined);
    await applyLogRetentionAndPersist(retention, jobs, persistJobs);
  } finally {
    runtimeState.child = null;
    runtimeStateByExecutionId.delete(job.execution_id);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function summarizeJob(job: ExecutionJob): Record<string, unknown> {
  return {
    execution_id: job.execution_id,
    button_id: job.button_id,
    spell_id: job.spell_id,
    version: job.version,
    require_signature: job.require_signature,
    status: job.status,
    tenant_id: job.tenant_id,
    actor_role: job.actor_role,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error_code: job.error_code,
    message: job.message,
    runtime_execution_id: job.runtime_execution_id,
    retry_of: job.retry_of,
    retried_by: job.retried_by
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
    rollback: sanitizeRollbackSummary(parsed.rollback),
    success: parsed.success,
    error: parsed.error
  };
}

async function readOutputValueFromRuntimeLog(runtimeLogPath: string, outputRef: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(runtimeLogPath, "utf8");
  } catch {
    throw new Error("execution log not found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("execution log is invalid json");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("execution log is invalid json");
  }

  const outputs = (parsed as Record<string, unknown>).outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error("execution log has no outputs");
  }

  const value = resolveOutputReference(outputs as Record<string, unknown>, outputRef);
  if (value === undefined) {
    throw new Error(`output value not found: ${outputRef}`);
  }

  return value;
}

function mapRuntimeError(raw: string): { code: string; message: string } {
  const compensation = /manual recovery required: compensation state=([a-z_]+)/.exec(raw);
  if (compensation) {
    return {
      code: "COMPENSATION_INCOMPLETE",
      message: `manual recovery required: compensation state=${compensation[1]}`
    };
  }

  const executionTimeout = /cast execution timed out after \d+ms(?: while running step '[^']+')?/.exec(raw);
  if (executionTimeout) {
    return { code: "EXECUTION_TIMEOUT", message: executionTimeout[0] };
  }
  const stepTimeout = /shell step '[^']+' timed out after \d+ms/.exec(raw);
  if (stepTimeout) {
    return { code: "STEP_TIMEOUT", message: stepTimeout[0] };
  }
  const inputTooLarge = /merged input is \d+ bytes, exceeds SPELL_RUNTIME_INPUT_MAX_BYTES=\d+/.exec(raw);
  if (inputTooLarge) {
    return { code: "INPUT_TOO_LARGE", message: inputTooLarge[0] };
  }
  if (/signature required:/.test(raw)) {
    return { code: "SIGNATURE_REQUIRED", message: "signature required" };
  }
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

function sanitizeRollbackSummary(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const rollback = raw as Record<string, unknown>;
  return {
    total_executed_steps: rollback.total_executed_steps,
    rollback_planned_steps: rollback.rollback_planned_steps,
    rollback_attempted_steps: rollback.rollback_attempted_steps,
    rollback_succeeded_steps: rollback.rollback_succeeded_steps,
    rollback_failed_steps: rollback.rollback_failed_steps,
    rollback_skipped_without_handler_steps: rollback.rollback_skipped_without_handler_steps,
    failed_step_names: rollback.failed_step_names,
    state: rollback.state,
    require_full_compensation: rollback.require_full_compensation,
    manual_recovery_required: rollback.manual_recovery_required
  };
}

function assessRollbackFromReceipt(receipt: Record<string, unknown> | undefined): { manualRecoveryRequired: boolean; state?: string } {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { manualRecoveryRequired: false };
  }

  const rollback = (receipt as Record<string, unknown>).rollback;
  if (!rollback || typeof rollback !== "object" || Array.isArray(rollback)) {
    return { manualRecoveryRequired: false };
  }

  const rollbackObj = rollback as Record<string, unknown>;
  return {
    manualRecoveryRequired: rollbackObj.manual_recovery_required === true,
    state: typeof rollbackObj.state === "string" ? rollbackObj.state : undefined
  };
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

async function inferRuntimeLogFromDisk(
  logsDirectory: string,
  job: ExecutionJob,
  startedAtIso: string
): Promise<{ path: string; executionId?: string } | null> {
  const startedAtMs = Date.parse(startedAtIso);
  const candidates = await readdir(logsDirectory).catch(() => []);

  for (const name of candidates.sort().reverse()) {
    if (!name.endsWith(".json") || name === "index.json") {
      continue;
    }

    const candidatePath = path.join(logsDirectory, name);

    let statInfo: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      statInfo = await stat(candidatePath);
    } catch {
      continue;
    }
    if (!statInfo.isFile()) {
      continue;
    }

    if (Number.isFinite(startedAtMs) && statInfo.mtimeMs + 1000 < startedAtMs) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(candidatePath, "utf8"));
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const log = parsed as Record<string, unknown>;
    if (log.id !== job.spell_id || log.version !== job.version) {
      continue;
    }

    const executionId = typeof log.execution_id === "string" ? log.execution_id : undefined;
    return {
      path: candidatePath,
      executionId
    };
  }

  return null;
}

function parseIdempotencyKey(
  headerValue: string | string[] | undefined
): { ok: true; key: string | null } | { ok: false; message: string } {
  if (headerValue === undefined) {
    return { ok: true, key: null };
  }

  const raw = Array.isArray(headerValue) ? headerValue.join(",") : headerValue;
  const key = raw.trim();
  if (
    key.length < 1 ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_PRINTABLE_ASCII.test(key)
  ) {
    return {
      ok: false,
      message: "invalid Idempotency-Key header: expected printable ASCII, trimmed length 1..128"
    };
  }

  return { ok: true, key };
}

function normalizeConfirmationFlags(confirmation: CreateExecutionRequest["confirmation"] | undefined): {
  risk_acknowledged: boolean;
  billing_acknowledged: boolean;
} {
  return {
    risk_acknowledged: confirmation?.risk_acknowledged === true,
    billing_acknowledged: confirmation?.billing_acknowledged === true
  };
}

function cloneExecutionInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function cloneExecutionRequestSnapshot(snapshot: ExecutionRequestSnapshot): ExecutionRequestSnapshot {
  return {
    input: cloneExecutionInput(snapshot.input),
    dry_run: snapshot.dry_run,
    confirmation: {
      risk_acknowledged: snapshot.confirmation.risk_acknowledged,
      billing_acknowledged: snapshot.confirmation.billing_acknowledged
    }
  };
}

function computeExecutionRequestFingerprint(payload: {
  tenant_id: string;
  button_id: string;
  input: Record<string, unknown>;
  dry_run: boolean;
  confirmation: {
    risk_acknowledged: boolean;
    billing_acknowledged: boolean;
  };
  actor_role: string;
}): string {
  const canonical = canonicalizeForFingerprint(payload);
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized).digest("hex");
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForFingerprint(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const next = canonicalizeForFingerprint(value[key]);
      if (next !== undefined) {
        out[key] = next;
      }
    }
    return out;
  }
  return value;
}

function parseCreateExecutionRequest(payload: unknown): CreateExecutionRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("request body must be an object");
  }

  const obj = payload as Record<string, unknown>;
  const allowedKeys = new Set(["button_id", "dry_run", "input", "confirmation", "actor_role", "tenant", "tenant_id"]);
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
  if (confirmation && "risk_acknowledged" in confirmation) {
    const value = (confirmation as Record<string, unknown>).risk_acknowledged;
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error("confirmation.risk_acknowledged must be boolean");
    }
  }
  if (confirmation && "billing_acknowledged" in confirmation) {
    const value = (confirmation as Record<string, unknown>).billing_acknowledged;
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error("confirmation.billing_acknowledged must be boolean");
    }
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

function countInFlightJobsForTenant(jobs: Map<string, ExecutionJob>, tenantId: string): number {
  let total = 0;
  for (const job of jobs.values()) {
    if (job.tenant_id !== tenantId) {
      continue;
    }
    if (job.status === "queued" || job.status === "running") {
      total += 1;
    }
  }
  return total;
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

function findExistingJobByIdempotencyKey(
  jobs: Map<string, ExecutionJob>,
  tenantId: string,
  idempotencyKey: string
): ExecutionJob | null {
  let existing: ExecutionJob | null = null;
  for (const job of jobs.values()) {
    if (job.tenant_id !== tenantId || job.idempotency_key !== idempotencyKey) {
      continue;
    }
    if (!existing || job.created_at > existing.created_at) {
      existing = job;
    }
  }
  return existing;
}

function parseListExecutionsQuery(params: URLSearchParams): ListExecutionsQuery {
  const statusParam = params.get("status");
  const buttonIdParam = params.get("button_id");
  const spellIdParam = params.get("spell_id");
  const tenantIdParam = params.get("tenant_id");
  const limitParam = params.get("limit");
  const fromParam = params.get("from");
  const toParam = params.get("to");

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
  const spellId = spellIdParam && spellIdParam.trim() !== "" ? spellIdParam.trim() : null;
  const tenantId = tenantIdParam && tenantIdParam.trim() !== "" ? tenantIdParam.trim() : null;
  if (tenantId && !AUTH_KEY_SEGMENT_PATTERN.test(tenantId)) {
    throw new Error(`invalid tenant_id filter: ${tenantId}`);
  }

  const fromAtMs = parseTimeFilter(fromParam, "from");
  const toAtMs = parseTimeFilter(toParam, "to");
  if (fromAtMs !== null && toAtMs !== null && fromAtMs > toAtMs) {
    throw new Error("invalid time range: from must be <= to");
  }

  return {
    statuses,
    buttonId,
    spellId,
    tenantId,
    limit,
    fromAtMs,
    toAtMs
  };
}

function matchJobByQuery(job: ExecutionJob, query: ListExecutionsQuery): boolean {
  if (query.statuses && !query.statuses.has(job.status)) {
    return false;
  }
  if (query.buttonId && job.button_id !== query.buttonId) {
    return false;
  }
  if (query.spellId && job.spell_id !== query.spellId) {
    return false;
  }
  if (query.tenantId && job.tenant_id !== query.tenantId) {
    return false;
  }

  if (query.fromAtMs !== null || query.toAtMs !== null) {
    const createdAtMs = Date.parse(job.created_at);
    if (!Number.isFinite(createdAtMs)) {
      return false;
    }
    if (query.fromAtMs !== null && createdAtMs < query.fromAtMs) {
      return false;
    }
    if (query.toAtMs !== null && createdAtMs > query.toAtMs) {
      return false;
    }
  }

  return true;
}

function parseTimeFilter(raw: string | null, label: string): number | null {
  if (!raw || raw.trim() === "") {
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${label}: expected ISO-8601 timestamp`);
  }
  return parsed;
}

function isJobStatus(value: string): value is JobStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "timeout" ||
    value === "canceled"
  );
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "timeout" || status === "canceled";
}

function isRetryableJobStatus(status: JobStatus): boolean {
  return status === "failed" || status === "timeout" || status === "canceled";
}

function requiresApiAuth(route: string): boolean {
  return (
    route === "/buttons" ||
    route === "/spell-executions" ||
    route.startsWith("/spell-executions/") ||
    route.startsWith("/tenants/")
  );
}

function authorizeRequest(
  req: IncomingMessage,
  authTokens: Set<string>,
  authKeys: ApiAuthKey[]
): ApiAuthContext {
  if (authTokens.size === 0 && authKeys.length === 0) {
    return { ok: true, tenantId: DEFAULT_TENANT_ID };
  }

  const token = readAuthToken(req);
  if (!token) {
    return { ok: false, errorCode: "AUTH_REQUIRED", message: "authorization token is required" };
  }

  if (authKeys.length > 0) {
    for (const key of authKeys) {
      if (secureTokenEquals(key.token, token)) {
        return { ok: true, tenantId: key.tenantId, role: key.role };
      }
    }

    return { ok: false, errorCode: "AUTH_INVALID", message: "invalid authorization token" };
  }

  for (const expectedToken of authTokens) {
    if (secureTokenEquals(expectedToken, token)) {
      return { ok: true, tenantId: DEFAULT_TENANT_ID };
    }
  }

  return { ok: false, errorCode: "AUTH_INVALID", message: "invalid authorization token" };
}

function parseAuthKeys(entries: string[]): ApiAuthKey[] {
  const out: ApiAuthKey[] = [];
  const seenTokens = new Set<string>();

  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }

    let left = "";
    let token = "";
    if (trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      if (idx <= 0 || idx >= trimmed.length - 1) {
        throw new Error(`invalid auth key entry: ${trimmed}`);
      }
      left = trimmed.slice(0, idx).trim();
      token = trimmed.slice(idx + 1).trim();
    } else {
      const legacyIdx = trimmed.indexOf(":");
      if (legacyIdx <= 0 || legacyIdx >= trimmed.length - 1) {
        throw new Error(`invalid auth key entry: ${trimmed}`);
      }
      left = trimmed.slice(0, legacyIdx).trim();
      token = trimmed.slice(legacyIdx + 1).trim();
    }

    const leftSegments = left.split(":");
    let tenantId = DEFAULT_TENANT_ID;
    let role = "";
    if (leftSegments.length === 1) {
      [role] = leftSegments;
    } else if (leftSegments.length === 2) {
      [tenantId, role] = leftSegments;
    } else {
      throw new Error(`invalid auth key entry: ${trimmed}`);
    }

    if (!tenantId || !AUTH_KEY_SEGMENT_PATTERN.test(tenantId)) {
      throw new Error(`invalid auth key tenant: ${tenantId || "(empty)"}`);
    }
    if (!role || !AUTH_KEY_SEGMENT_PATTERN.test(role)) {
      throw new Error(`invalid auth key role: ${role || "(empty)"}`);
    }
    if (!token) {
      throw new Error(`invalid auth key token: ${tenantId}:${role} has empty token`);
    }

    if (seenTokens.has(token)) {
      throw new Error(`duplicate auth key token configured for role: ${tenantId}:${role}`);
    }
    seenTokens.add(token);

    out.push({ tenantId, role, token });
  }

  return out;
}

function readAuthToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const matched = /^Bearer\s+(.+)$/.exec(authorization.trim());
    if (matched && matched[1]) {
      return matched[1].trim();
    }
  }

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim() !== "") {
    return apiKey.trim();
  }

  return null;
}

function secureTokenEquals(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
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
    const partial = item as Partial<ExecutionJob>;
    const request = isExecutionRequestSnapshot(partial.request)
      ? cloneExecutionRequestSnapshot(partial.request)
      : undefined;
    jobs.set(item.execution_id, {
      ...item,
      tenant_id: normalizeTenantId(partial.tenant_id),
      require_signature: Boolean(partial.require_signature),
      request,
      retry_of: typeof partial.retry_of === "string" ? partial.retry_of : undefined,
      retried_by: typeof partial.retried_by === "string" ? partial.retried_by : undefined
    });
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

async function applyLogRetentionAndPersist(
  retention: {
    logsDirectory: string;
    logRetentionDays: number;
    logMaxFiles: number;
  },
  jobs: Map<string, ExecutionJob>,
  persistJobs: () => Promise<void>
): Promise<void> {
  const pruned = await applyLogRetentionPolicy(
    retention.logsDirectory,
    jobs,
    retention.logRetentionDays,
    retention.logMaxFiles
  );

  if (pruned) {
    await persistJobs();
  }
}

async function applyLogRetentionPolicy(
  logsDirectory: string,
  jobs: Map<string, ExecutionJob>,
  logRetentionDays: number,
  logMaxFiles: number
): Promise<boolean> {
  const entries = await readdir(logsDirectory).catch(() => []);
  const candidates: Array<{ fileName: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "index.json") {
      continue;
    }

    const filePath = path.join(logsDirectory, entry);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      continue;
    }

    candidates.push({
      fileName: entry,
      mtimeMs: info.mtimeMs
    });
  }

  const toDelete = new Set<string>();

  if (logRetentionDays > 0) {
    const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
    for (const candidate of candidates) {
      if (candidate.mtimeMs < cutoff) {
        toDelete.add(candidate.fileName);
      }
    }
  }

  const remaining = candidates
    .filter((candidate) => !toDelete.has(candidate.fileName))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));

  if (logMaxFiles > 0 && remaining.length > logMaxFiles) {
    for (let i = logMaxFiles; i < remaining.length; i += 1) {
      toDelete.add(remaining[i].fileName);
    }
  }

  let changed = false;

  if (toDelete.size > 0) {
    for (const fileName of toDelete) {
      const removed = await rm(path.join(logsDirectory, fileName), { force: true })
        .then(() => true)
        .catch(() => false);
      if (removed) {
        changed = true;
      }
    }
  }

  const jobIdsToDelete = new Set<string>();
  const jobsList = Array.from(jobs.values());

  if (logRetentionDays > 0) {
    const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
    for (const job of jobsList) {
      const time = readJobTimestamp(job);
      if (time !== null && time < cutoff) {
        jobIdsToDelete.add(job.execution_id);
      }
    }
  }

  const remainingJobs = jobsList
    .filter((job) => !jobIdsToDelete.has(job.execution_id))
    .sort((a, b) => {
      const t1 = readJobTimestamp(a) ?? 0;
      const t2 = readJobTimestamp(b) ?? 0;
      return t2 - t1;
    });

  if (logMaxFiles > 0 && remainingJobs.length > logMaxFiles) {
    for (let i = logMaxFiles; i < remainingJobs.length; i += 1) {
      jobIdsToDelete.add(remainingJobs[i].execution_id);
    }
  }

  const retainedLogPaths = new Set<string>();
  for (const job of jobsList) {
    if (jobIdsToDelete.has(job.execution_id)) {
      continue;
    }
    if (job.runtime_log_path) {
      retainedLogPaths.add(job.runtime_log_path);
    }
  }

  for (const executionId of jobIdsToDelete) {
    const job = jobs.get(executionId);
    if (!job) {
      continue;
    }

    if (job.runtime_log_path) {
      // A runtime log path can (rarely) be shared if the runtime execution id collides.
      // Do not delete a log file that is still referenced by a retained job.
      if (!retainedLogPaths.has(job.runtime_log_path)) {
        await rm(job.runtime_log_path, { force: true }).catch(() => undefined);
      }
    }

    jobs.delete(executionId);
    changed = true;
  }

  return changed;
}

function readJobTimestamp(job: ExecutionJob): number | null {
  const source = job.finished_at ?? job.created_at;
  const value = Date.parse(source);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function isExecutionRequestSnapshot(value: unknown): value is ExecutionRequestSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  if (!obj.input || typeof obj.input !== "object" || Array.isArray(obj.input)) {
    return false;
  }
  if (typeof obj.dry_run !== "boolean") {
    return false;
  }
  if (!obj.confirmation || typeof obj.confirmation !== "object" || Array.isArray(obj.confirmation)) {
    return false;
  }

  const confirmation = obj.confirmation as Record<string, unknown>;
  return (
    typeof confirmation.risk_acknowledged === "boolean" && typeof confirmation.billing_acknowledged === "boolean"
  );
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
    (obj.require_signature === undefined || typeof obj.require_signature === "boolean") &&
    (obj.tenant_id === undefined || typeof obj.tenant_id === "string") &&
    typeof obj.actor_role === "string" &&
    typeof obj.created_at === "string" &&
    typeof obj.status === "string" &&
    (obj.idempotency_key === undefined || typeof obj.idempotency_key === "string") &&
    (obj.idempotency_fingerprint === undefined || typeof obj.idempotency_fingerprint === "string") &&
    (obj.request === undefined || isExecutionRequestSnapshot(obj.request)) &&
    (obj.retry_of === undefined || typeof obj.retry_of === "string") &&
    (obj.retried_by === undefined || typeof obj.retried_by === "string") &&
    isJobStatus(obj.status)
  );
}

function scopeListExecutionsQuery(
  query: ListExecutionsQuery,
  authContext: ApiAuthContext,
  authKeysEnabled: boolean
): { ok: true; query: ListExecutionsQuery } | { ok: false; errorCode: string; message: string } {
  if (!authKeysEnabled || !authContext.ok || authContext.role === "admin") {
    return { ok: true, query };
  }

  if (query.tenantId && query.tenantId !== authContext.tenantId) {
    return {
      ok: false,
      errorCode: "TENANT_FORBIDDEN",
      message: `tenant query denied: ${query.tenantId}`
    };
  }

  return {
    ok: true,
    query: {
      ...query,
      tenantId: authContext.tenantId
    }
  };
}

function normalizeTenantId(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_TENANT_ID;
  }
  const tenantId = value.trim();
  if (!tenantId) {
    return DEFAULT_TENANT_ID;
  }
  return tenantId;
}

function isCancellationRequested(
  jobs: Map<string, ExecutionJob>,
  runtimeStateByExecutionId: Map<string, ExecutionRuntimeState>,
  executionId: string
): boolean {
  const job = jobs.get(executionId);
  if (job?.status === "canceled") {
    return true;
  }
  return runtimeStateByExecutionId.get(executionId)?.cancelRequested === true;
}

function summarizeTenantUsage(
  jobs: Map<string, ExecutionJob>,
  tenantId: string
): { queued: number; running: number; submissions_last_24h: number } {
  let queued = 0;
  let running = 0;
  let submissionsLast24h = 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const job of jobs.values()) {
    if (job.tenant_id !== tenantId) {
      continue;
    }

    if (job.status === "queued") {
      queued += 1;
    } else if (job.status === "running") {
      running += 1;
    }

    const createdAt = Date.parse(job.created_at);
    if (Number.isFinite(createdAt) && createdAt >= cutoff) {
      submissionsLast24h += 1;
    }
  }

  return {
    queued,
    running,
    submissions_last_24h: submissionsLast24h
  };
}

function makeTenantAuditEvent(job: ExecutionJob): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    tenant_id: job.tenant_id,
    execution_id: job.execution_id,
    button_id: job.button_id,
    status: job.status,
    actor_role: job.actor_role,
    ...(job.error_code ? { error_code: job.error_code } : {})
  };
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
