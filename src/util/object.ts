import { SpellError } from "./errors";

export function getByDotPath(input: unknown, dotPath: string): unknown {
  if (dotPath.trim() === "") {
    return input;
  }

  const parts = dotPath.split(".");
  let cursor: unknown = input;

  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object" || !(part in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

export function setByDotPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".").filter(Boolean);
  if (parts.length === 0) {
    throw new SpellError("invalid -p key: empty key");
  }

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = cursor[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }

  cursor[parts[parts.length - 1]] = value;
}

export function parseKeyValuePair(pair: string): { key: string; value: unknown } {
  const idx = pair.indexOf("=");
  if (idx <= 0) {
    throw new SpellError(`invalid -p argument: ${pair}`);
  }

  const key = pair.slice(0, idx).trim();
  const raw = pair.slice(idx + 1);

  if (!key) {
    throw new SpellError(`invalid -p argument: ${pair}`);
  }

  return { key, value: parseMaybeJson(raw) };
}

export function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
