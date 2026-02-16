import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpellError } from "../util/errors";
import { trustedPublishersRoot } from "../util/paths";

export interface PublisherTrustKeyV1 {
  key_id: string;
  algorithm: "ed25519";
  public_key: string; // base64url spki der
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
    return { key_id: keyId, algorithm: "ed25519", public_key: publicKey };
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
  filtered.push(key);
  filtered.sort((a, b) => a.key_id.localeCompare(b.key_id));

  const payload: PublisherTrustV1 = {
    version: "v1",
    publisher,
    keys: filtered
  };

  const filePath = publisherTrustFilePath(publisher);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
      keys.push({ key_id: kk.key_id, algorithm: "ed25519", public_key: kk.public_key });
    }

    if (keys.length === 0) continue;
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

function assertUniqueKeyIds(keys: PublisherTrustKeyV1[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.key_id)) {
      throw new SpellError(`duplicate trust key_id: ${key.key_id}`);
    }
    seen.add(key.key_id);
  }
}

