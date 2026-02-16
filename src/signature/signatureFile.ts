import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { SpellError } from "../util/errors";

export interface SpellSignatureV1 {
  version: "v1";
  publisher: string;
  key_id: string;
  algorithm: "ed25519";
  digest: {
    algorithm: "sha256";
    value: string; // hex
  };
  signature: string; // base64url
}

export async function readSignatureFile(bundlePath: string): Promise<SpellSignatureV1 | null> {
  const filePath = path.join(bundlePath, "spell.sig.json");
  try {
    await access(filePath);
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new SpellError(`failed to read spell.sig.json: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`failed to parse spell.sig.json: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("spell.sig.json must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const version = readRequiredString(obj, "version");
  if (version !== "v1") {
    throw new SpellError(`unsupported signature version: ${version}`);
  }

  const publisher = readRequiredString(obj, "publisher");
  const keyId = readRequiredString(obj, "key_id");
  const algorithm = readRequiredString(obj, "algorithm");
  if (algorithm !== "ed25519") {
    throw new SpellError(`unsupported signature algorithm: ${algorithm}`);
  }

  const digestRaw = obj.digest;
  if (!digestRaw || typeof digestRaw !== "object" || Array.isArray(digestRaw)) {
    throw new SpellError("spell.sig.json.digest must be an object");
  }
  const digestObj = digestRaw as Record<string, unknown>;
  const digestAlg = readRequiredString(digestObj, "algorithm");
  if (digestAlg !== "sha256") {
    throw new SpellError(`unsupported digest algorithm: ${digestAlg}`);
  }

  const digestValue = readRequiredString(digestObj, "value");
  if (!/^[a-f0-9]{64}$/i.test(digestValue)) {
    throw new SpellError("spell.sig.json.digest.value must be a sha256 hex string");
  }

  const signature = readRequiredString(obj, "signature");
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new SpellError("spell.sig.json.signature must be base64url");
  }

  return {
    version: "v1",
    publisher,
    key_id: keyId,
    algorithm: "ed25519",
    digest: { algorithm: "sha256", value: digestValue.toLowerCase() },
    signature
  };
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`spell.sig.json missing '${key}' string`);
  }
  return value.trim();
}

