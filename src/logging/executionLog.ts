import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionLog } from "../types";
import { sanitizeIdForFilename } from "../util/idKey";
import { ensureSpellDirs, logsRoot } from "../util/paths";
import { redactSecrets } from "../util/redact";

export function makeExecutionId(id: string, version: string, now = new Date()): string {
  const ts = toTimestamp(now);
  return `${ts}_${sanitizeIdForFilename(id)}_${sanitizeIdForFilename(version)}.json`;
}

export async function writeExecutionLog(log: ExecutionLog): Promise<string> {
  await ensureSpellDirs();
  const filePath = path.join(logsRoot(), log.execution_id);
  const sanitized = redactSecrets(log);
  await writeFile(filePath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return filePath;
}

function toTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}
