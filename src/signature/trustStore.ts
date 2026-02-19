import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpellError } from "../util/errors";
import { trustedPublishersRoot } from "../util/paths";

export interface PublisherTrustKeyV1 {
  key_id: string;
  algorithm: "ed25519";
  public_key: string; // base64url spki der
  revoked?: boolean;
  revoked_at?: string;
  revoke_reason?: string;
}

export interface PublisherTrustV1 {
  version: "v1";
  publisher: string;
  keys: PublisherTrustKeyV1[];
}

export function publisherFromId(id: string): string {
  const idx = id.indexOf("/");
  return idx === -1 ? id : id.slice(0, idx);
}

export function toPublisherKey(publisher: string): string {
  return Buffer.from(publisher, "utf8").toString("base64url");
}

export function publisherTrustFilePath(publisher: string): string {
  const key = toPublisherKey(publisher);
  return path.join(trustedPublishersRoot(), `${key}.json`);
}

export async function loadPublisherTrust(publisher: string): Promise<PublisherTrustV1 | null> {
  const filePath = publisherTrustFilePath(publisher);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SpellError(`failed to parse trust file: ${filePath}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError(`trust file must be a JSON object: ${filePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const version = readRequiredString(obj, "version");
  if (version !== "v1") {
    throw new SpellError(`unsupported trust file version: ${version}`);
  }

  const publisherValue = readRequiredString(obj, "publisher");
  if (publisherValue !== publisher) {
    throw new SpellError(`trust file publisher mismatch: expected '${publisher}', got '${publisherValue}'`);
  }

  const keysRaw = obj.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) {
    throw new SpellError("trust file keys must be a non-empty array");
  }

  const keys: PublisherTrustKeyV1[] = keysRaw.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SpellError(`trust file keys[${idx}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const keyId = readRequiredString(e, "key_id");
    const algorithm = readRequiredString(e, "algorithm");
    if (algorithm !== "ed25519") {
      throw new SpellError(`unsupported trust key algorithm: ${algorithm}`);
    }
    const publicKey = readRequiredString(e, "public_key");
    if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) {
      throw new SpellError("trust key public_key must be base64url");
    }
    const revoked = readOptionalBoolean(e, "revoked");
    if (e.revoked !== undefined && revoked === undefined) {
      throw new SpellError("trust key revoked must be a boolean");
    }

    const revokedAt = revoked === true ? readOptionalIsoTimestamp(e, "revoked_at", keyId) : undefined;
    const revokeReason = revoked === true ? readOptionalString(e, "revoke_reason") : undefined;

    return {
      key_id: keyId,
      algorithm: "ed25519",
      public_key: publicKey,
      revoked: revoked === true,
      revoked_at: revokedAt,
      revoke_reason: revokeReason
    };
  });

  assertUniqueKeyIds(keys);

  return {
    version: "v1",
    publisher,
    keys
  };
}

export async function upsertTrustedPublisherKey(
  publisher: string,
  key: PublisherTrustKeyV1
): Promise<void> {
  await mkdir(trustedPublishersRoot(), { recursive: true });

  const existing = await loadPublisherTrust(publisher);
  const next: PublisherTrustV1 = existing ?? { version: "v1", publisher, keys: [] };

  const filtered = next.keys.filter((entry) => entry.key_id !== key.key_id);
  filtered.push(normalizeTrustKey(key));

  await writePublisherTrust({
    version: "v1",
    publisher,
    keys: filtered
  });
}

export async function revokeTrustedPublisherKey(
  publisher: string,
  keyId: string,
  reason?: string
): Promise<PublisherTrustKeyV1> {
  const now = new Date().toISOString();
  return updateTrustedPublisherKey(publisher, keyId, (current) => ({
    ...current,
    revoked: true,
    revoked_at: now,
    revoke_reason: normalizeOptionalReason(reason)
  }));
}

export async function restoreTrustedPublisherKey(
  publisher: string,
  keyId: string
): Promise<PublisherTrustKeyV1> {
  return updateTrustedPublisherKey(publisher, keyId, (current) => ({
    ...current,
    revoked: false,
    revoked_at: undefined,
    revoke_reason: undefined
  }));
}

export async function removeTrustedPublisher(publisher: string): Promise<boolean> {
  const filePath = publisherTrustFilePath(publisher);
  const existed = await access(filePath).then(() => true).catch(() => false);
  if (!existed) return false;
  await rm(filePath, { force: true });
  return true;
}

export async function listTrustedPublishers(): Promise<Array<{ publisher: string; keys: PublisherTrustKeyV1[] }>> {
  const dir = trustedPublishersRoot();
  const entries = await readdir(dir).catch(() => []);
  const out: Array<{ publisher: string; keys: PublisherTrustKeyV1[] }> = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const obj = parsed as Record<string, unknown>;
    if (obj.version !== "v1") continue;
    if (typeof obj.publisher !== "string" || !obj.publisher.trim()) continue;
    if (!Array.isArray(obj.keys)) continue;

    const publisher = obj.publisher.trim();
    const keys: PublisherTrustKeyV1[] = [];
    for (const k of obj.keys) {
      if (!k || typeof k !== "object" || Array.isArray(k)) continue;
      const kk = k as Record<string, unknown>;
      if (typeof kk.key_id !== "string" || typeof kk.public_key !== "string") continue;
      if (kk.algorithm !== "ed25519") continue;

      const revoked = kk.revoked;
      if (revoked !== undefined && typeof revoked !== "boolean") continue;

      let revokedAt: string | undefined;
      try {
        revokedAt = revoked === true ? readOptionalIsoTimestamp(kk, "revoked_at", kk.key_id) : undefined;
      } catch {
        continue;
      }
      const revokeReason = revoked === true ? readOptionalString(kk, "revoke_reason") : undefined;

      keys.push({
        key_id: kk.key_id,
        algorithm: "ed25519",
        public_key: kk.public_key,
        revoked: revoked === true,
        revoked_at: revokedAt,
        revoke_reason: revokeReason
      });
    }

    if (keys.length === 0) continue;
    keys.sort((a, b) => a.key_id.localeCompare(b.key_id));
    out.push({ publisher, keys });
  }

  out.sort((a, b) => a.publisher.localeCompare(b.publisher));
  return out;
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`missing '${key}' string`);
  }
  return value.trim();
}

function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function readOptionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

function readOptionalIsoTimestamp(
  obj: Record<string, unknown>,
  key: string,
  keyId: string
): string | undefined {
  const value = readOptionalString(obj, key);
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new SpellError(`trust key ${key} must be an ISO timestamp: ${keyId}`);
  }
  return value;
}

function assertUniqueKeyIds(keys: PublisherTrustKeyV1[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.key_id)) {
      throw new SpellError(`duplicate trust key_id: ${key.key_id}`);
    }
    seen.add(key.key_id);
  }
}

function normalizeTrustKey(key: PublisherTrustKeyV1): PublisherTrustKeyV1 {
  const revoked = key.revoked === true;
  const revokedAt = revoked ? normalizeOptionalIsoTimestamp(key.revoked_at) : undefined;
  const revokeReason = revoked ? normalizeOptionalReason(key.revoke_reason) : undefined;

  return {
    key_id: key.key_id,
    algorithm: "ed25519",
    public_key: key.public_key,
    revoked,
    revoked_at: revokedAt,
    revoke_reason: revokeReason
  };
}

async function writePublisherTrust(record: PublisherTrustV1): Promise<void> {
  await mkdir(trustedPublishersRoot(), { recursive: true });
  const filePath = publisherTrustFilePath(record.publisher);
  const keys = [...record.keys].map(normalizeTrustKey).sort((a, b) => a.key_id.localeCompare(b.key_id));
  await writeFile(filePath, `${JSON.stringify({ version: "v1", publisher: record.publisher, keys }, null, 2)}\n`, "utf8");
}

async function updateTrustedPublisherKey(
  publisher: string,
  keyId: string,
  transform: (current: PublisherTrustKeyV1) => PublisherTrustKeyV1
): Promise<PublisherTrustKeyV1> {
  const trust = await loadPublisherTrust(publisher);
  if (!trust) {
    throw new SpellError(`trusted publisher not found: ${publisher}`);
  }

  const index = trust.keys.findIndex((entry) => entry.key_id === keyId);
  if (index < 0) {
    throw new SpellError(`trusted key not found: publisher=${publisher} key_id=${keyId}`);
  }

  const updated = normalizeTrustKey(transform(trust.keys[index]));
  const keys = [...trust.keys];
  keys[index] = updated;
  await writePublisherTrust({
    version: "v1",
    publisher,
    keys
  });

  return updated;
}

function normalizeOptionalReason(value?: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function normalizeOptionalIsoTimestamp(value?: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const normalized = value.trim();
  if (Number.isNaN(Date.parse(normalized))) {
    throw new SpellError("trust key revoked_at must be an ISO timestamp");
  }
  return normalized;
}
