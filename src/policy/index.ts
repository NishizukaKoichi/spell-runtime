import { readFile } from "node:fs/promises";
import { RuntimeExecution, SpellRisk } from "../types";
import { SpellError } from "../util/errors";
import { runtimePolicyPath } from "../util/paths";

const POLICY_VERSION = "v1";

const ALLOW_DENY_VALUES = new Set(["allow", "deny"]);
const RISK_VALUES = new Set<SpellRisk>(["low", "medium", "high", "critical"]);
const EXECUTION_VALUES = new Set<RuntimeExecution>(["host", "docker"]);

const RISK_ORDER: Record<SpellRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};

export interface RuntimePolicyV1 {
  version: "v1";
  default: "allow" | "deny";
  publishers?: {
    allow?: string[];
    deny?: string[];
  };
  max_risk?: SpellRisk;
  runtime?: {
    allow_execution?: RuntimeExecution[];
  };
}

export interface RuntimePolicyContext {
  publisher: string;
  risk: SpellRisk;
  execution: RuntimeExecution;
}

export interface RuntimePolicyDecision {
  allow: boolean;
  reason?: string;
}

export function runtimePolicyFilePath(): string {
  return runtimePolicyPath();
}

export async function loadRuntimePolicy(): Promise<RuntimePolicyV1 | null> {
  const filePath = runtimePolicyFilePath();
  const raw = await readPolicyFile(filePath, true);
  if (raw === null) {
    return null;
  }
  const parsed = parsePolicyJson(raw);
  return parseRuntimePolicy(parsed);
}

export async function parseRuntimePolicyFile(filePath: string): Promise<RuntimePolicyV1> {
  const raw = await readPolicyFile(filePath, false);
  const parsed = parsePolicyJson(raw);
  return parseRuntimePolicy(parsed);
}

export function parseRuntimePolicy(raw: unknown): RuntimePolicyV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidPolicy("policy must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(obj, ["version", "default", "publishers", "max_risk", "runtime"], "policy");

  const version = readRequiredString(obj, "version");
  if (version !== POLICY_VERSION) {
    throw invalidPolicy(`unsupported version: ${version}`);
  }

  const defaultDecision = readRequiredString(obj, "default");
  if (!ALLOW_DENY_VALUES.has(defaultDecision)) {
    throw invalidPolicy(`default must be 'allow' or 'deny', got '${defaultDecision}'`);
  }

  const publishers = parsePublishers(obj.publishers);
  const maxRisk = parseMaxRisk(obj.max_risk);
  const runtime = parseRuntime(obj.runtime);

  return {
    version: "v1",
    default: defaultDecision as RuntimePolicyV1["default"],
    publishers,
    max_risk: maxRisk,
    runtime
  };
}

export function evaluateRuntimePolicy(
  policy: RuntimePolicyV1 | null,
  context: RuntimePolicyContext
): RuntimePolicyDecision {
  if (!policy) {
    return { allow: true };
  }

  const denyPublishers = policy.publishers?.deny ?? [];
  if (denyPublishers.includes(context.publisher)) {
    return {
      allow: false,
      reason: `publisher '${context.publisher}' is denied`
    };
  }

  const allowPublishers = policy.publishers?.allow;
  if (allowPublishers && !allowPublishers.includes(context.publisher)) {
    return {
      allow: false,
      reason: `publisher '${context.publisher}' is not allowed`
    };
  }

  if (policy.max_risk && RISK_ORDER[context.risk] > RISK_ORDER[policy.max_risk]) {
    return {
      allow: false,
      reason: `risk '${context.risk}' exceeds max_risk '${policy.max_risk}'`
    };
  }

  const allowedExecutions = policy.runtime?.allow_execution;
  if (allowedExecutions && !allowedExecutions.includes(context.execution)) {
    return {
      allow: false,
      reason: `runtime execution '${context.execution}' is not allowed`
    };
  }

  if (policy.default === "deny") {
    return {
      allow: false,
      reason: "default policy is deny"
    };
  }

  return { allow: true };
}

function parsePublishers(raw: unknown): RuntimePolicyV1["publishers"] | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidPolicy("publishers must be an object");
  }

  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(obj, ["allow", "deny"], "publishers");

  return {
    allow: parseStringArray(obj.allow, "publishers.allow"),
    deny: parseStringArray(obj.deny, "publishers.deny")
  };
}

function parseMaxRisk(raw: unknown): SpellRisk | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !RISK_VALUES.has(raw as SpellRisk)) {
    throw invalidPolicy(`max_risk must be one of low|medium|high|critical, got '${String(raw)}'`);
  }
  return raw as SpellRisk;
}

function parseRuntime(raw: unknown): RuntimePolicyV1["runtime"] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidPolicy("runtime must be an object");
  }

  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(obj, ["allow_execution"], "runtime");
  const allowExecution = parseExecutionArray(obj.allow_execution, "runtime.allow_execution");

  return {
    allow_execution: allowExecution
  };
}

function parseStringArray(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw invalidPolicy(`${label} must be an array of strings`);
  }

  return raw.map((value, idx) => {
    if (typeof value !== "string" || !value.trim()) {
      throw invalidPolicy(`${label}[${idx}] must be a non-empty string`);
    }
    return value.trim();
  });
}

function parseExecutionArray(raw: unknown, label: string): RuntimeExecution[] | undefined {
  const values = parseStringArray(raw, label);
  if (!values) {
    return undefined;
  }

  return values.map((value, idx) => {
    if (!EXECUTION_VALUES.has(value as RuntimeExecution)) {
      throw invalidPolicy(`${label}[${idx}] must be 'host' or 'docker'`);
    }
    return value as RuntimeExecution;
  });
}

function assertOnlyKeys(obj: Record<string, unknown>, allowedKeys: string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw invalidPolicy(`${label} contains unknown key '${key}'`);
    }
  }
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw invalidPolicy(`missing '${key}' string`);
  }
  return value.trim();
}

function readPolicyFile(filePath: string, allowMissing: true): Promise<string | null>;
function readPolicyFile(filePath: string, allowMissing: false): Promise<string>;
async function readPolicyFile(filePath: string, allowMissing: boolean): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (allowMissing && nodeError.code === "ENOENT") {
      return null;
    }
    throw invalidPolicy(`failed to read ${filePath}: ${(error as Error).message}`);
  }
}

function parsePolicyJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalidPolicy(`failed to parse JSON: ${(error as Error).message}`);
  }
}

function invalidPolicy(message: string): SpellError {
  return new SpellError(`invalid policy: ${message}`);
}
