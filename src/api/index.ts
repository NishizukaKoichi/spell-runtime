import { startExecutionApiServer } from "./server";

async function main(): Promise<void> {
  const port = readIntegerEnv("SPELL_API_PORT", 1, 8787);
  const registryPath = process.env.SPELL_BUTTON_REGISTRY_PATH;
  const requestBodyLimitBytes = readOptionalIntegerEnv("SPELL_API_BODY_LIMIT_BYTES", 1);
  const executionTimeoutMs = readOptionalIntegerEnv("SPELL_API_EXECUTION_TIMEOUT_MS", 1);
  const rateLimitWindowMs = readOptionalIntegerEnv("SPELL_API_RATE_LIMIT_WINDOW_MS", 1);
  const rateLimitMaxRequests = readOptionalIntegerEnv("SPELL_API_RATE_LIMIT_MAX_REQUESTS", 1);
  const tenantRateLimitWindowMs = readOptionalIntegerEnv("SPELL_API_TENANT_RATE_LIMIT_WINDOW_MS", 1);
  const tenantRateLimitMaxRequests = readOptionalIntegerEnv("SPELL_API_TENANT_RATE_LIMIT_MAX_REQUESTS", 1);
  const maxConcurrentExecutions = readOptionalIntegerEnv("SPELL_API_MAX_CONCURRENT_EXECUTIONS", 0);
  const tenantMaxConcurrentExecutions = readOptionalIntegerEnv("SPELL_API_TENANT_MAX_CONCURRENT_EXECUTIONS", 0);
  const authTokens = readOptionalCsvEnv("SPELL_API_AUTH_TOKENS");
  const authKeys = readOptionalCsvEnv("SPELL_API_AUTH_KEYS");
  const logRetentionDays = readOptionalIntegerEnv("SPELL_API_LOG_RETENTION_DAYS", 0);
  const logMaxFiles = readOptionalIntegerEnv("SPELL_API_LOG_MAX_FILES", 0);
  const forceRequireSignature = readBooleanEnv("SPELL_API_FORCE_REQUIRE_SIGNATURE", false);

  const started = await startExecutionApiServer({
    port,
    registryPath,
    requestBodyLimitBytes,
    executionTimeoutMs,
    rateLimitWindowMs,
    rateLimitMaxRequests,
    tenantRateLimitWindowMs,
    tenantRateLimitMaxRequests,
    maxConcurrentExecutions,
    tenantMaxConcurrentExecutions,
    authTokens,
    authKeys,
    logRetentionDays,
    logMaxFiles,
    forceRequireSignature
  });

  process.stdout.write(`spell execution api listening on :${started.port}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});

function readOptionalIntegerEnv(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  return readInteger(name, raw, min);
}

function readIntegerEnv(name: string, min: number, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return readInteger(name, raw, min);
}

function readInteger(name: string, raw: string, min: number): number {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return num;
}

function readOptionalCsvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (values.length === 0) {
    return undefined;
  }

  return values;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false/1/0)`);
}
