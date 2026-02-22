import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEntitlementClaims, type EntitlementClaims, type EntitlementMode } from "../license/entitlement";
import { SpellError } from "../util/errors";

const ISSUE_MODES = new Set<EntitlementMode>(["upfront", "on_success", "subscription"]);

export interface EntitlementIssuerConfig {
  issuer: string;
  keyId: string;
  privateKeyPem: string;
}

export interface IssueEntitlementInput {
  mode: EntitlementMode;
  currency: string;
  maxAmount: number;
  notBefore?: string;
  expiresAt?: string;
  ttlSeconds?: number;
}

export interface IssuedEntitlementToken {
  token: string;
  claims: EntitlementClaims;
}

export async function loadPrivateKeyPem(filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new SpellError(`failed to read private key '${filePath}': ${(error as Error).message}`);
  }

  const pem = raw.trim();
  if (!pem) {
    throw new SpellError(`private key file '${filePath}' is empty`);
  }
  return pem;
}

export function issueEntitlementToken(
  config: EntitlementIssuerConfig,
  input: IssueEntitlementInput,
  now: Date = new Date()
): IssuedEntitlementToken {
  const issuer = config.issuer.trim();
  const keyId = config.keyId.trim();
  if (!issuer) {
    throw new SpellError("issuer is required");
  }
  if (!keyId) {
    throw new SpellError("key_id is required");
  }
  if (!config.privateKeyPem.trim()) {
    throw new SpellError("private key PEM is required");
  }

  const mode = String(input.mode ?? "").trim() as EntitlementMode;
  if (!ISSUE_MODES.has(mode)) {
    throw new SpellError(`unsupported entitlement mode '${String(input.mode ?? "")}'`);
  }

  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!currency) {
    throw new SpellError("currency is required");
  }

  const maxAmount = input.maxAmount;
  if (!Number.isFinite(maxAmount) || maxAmount < 0) {
    throw new SpellError("maxAmount must be a non-negative finite number");
  }

  const nowMs = now.getTime();
  const ttlSeconds = input.ttlSeconds ?? 3600;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 60 * 60 * 24 * 365) {
    throw new SpellError("ttlSeconds must be an integer between 1 and 31536000");
  }

  const notBefore = input.notBefore?.trim() || new Date(nowMs - 60_000).toISOString();
  const expiresAt = input.expiresAt?.trim() || new Date(nowMs + ttlSeconds * 1000).toISOString();

  const claims = parseEntitlementClaims({
    version: "v1",
    issuer,
    key_id: keyId,
    mode,
    currency,
    max_amount: maxAmount,
    not_before: notBefore,
    expires_at: expiresAt
  });

  const payloadSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(config.privateKeyPem);
  } catch (error) {
    throw new SpellError(`invalid private key PEM: ${(error as Error).message}`);
  }

  const signatureSegment = sign(null, Buffer.from(payloadSegment, "utf8"), privateKey).toString("base64url");
  return {
    token: `ent1.${payloadSegment}.${signatureSegment}`,
    claims
  };
}
