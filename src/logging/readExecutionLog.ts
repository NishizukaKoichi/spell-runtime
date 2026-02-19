import { readFile } from "node:fs/promises";
import path from "node:path";
import { SpellError } from "../util/errors";
import { resolveOutputReference } from "../util/outputs";
import { logsRoot } from "../util/paths";

const EXECUTION_FILE_BASENAME_PATTERN = /^[a-zA-Z0-9_.-]+\.json$/;

export function resolveExecutionLogPath(executionId: string): string {
  const normalized = executionId.endsWith(".json") ? executionId : `${executionId}.json`;
  if (!EXECUTION_FILE_BASENAME_PATTERN.test(normalized)) {
    throw new SpellError(`invalid execution id: ${executionId}`);
  }
  return path.join(logsRoot(), normalized);
}

export async function readExecutionLogRaw(executionId: string): Promise<string> {
  const filePath = resolveExecutionLogPath(executionId);

  try {
    return await readFile(filePath, "utf8");
  } catch {
    throw new SpellError(`log not found: ${executionId}`);
  }
}

export async function readExecutionLogJson(executionId: string): Promise<Record<string, unknown>> {
  const raw = await readExecutionLogRaw(executionId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SpellError(`invalid log json: ${executionId}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError(`invalid log json: ${executionId}`);
  }

  return parsed as Record<string, unknown>;
}

export function readOutputFromExecutionLog(log: Record<string, unknown>, outputRef: string): unknown {
  const outputs = log.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new SpellError("log has no outputs");
  }

  const value = resolveOutputReference(outputs as Record<string, unknown>, outputRef);
  if (value === undefined) {
    throw new SpellError(`output value not found: ${outputRef}`);
  }

  return value;
}
