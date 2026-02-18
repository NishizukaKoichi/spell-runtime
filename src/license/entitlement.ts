import { createPublicKey, verify } from "node:crypto";
import { loadPublisherTrust } from "../signature/trustStore";
import { SpellError } from "../util/errors";

const TOKEN_PREFIX = "ent1";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ENTITLEMENT_MODES = new Set<EntitlementMode>(["upfront", "on_success", "subscription"]);

export type EntitlementMode = "upfront" | "on_success" | "subscription";

export interface EntitlementClaims {
  version: "v1";
  issuer: string;
  key_id: string;
  mode: EntitlementMode;
  currency: string;
  max_amount: number;
  not_before: string;
  expires_at: string;
}

export interface EntitlementTokenMetadata {
  format: "ent1";
  payload_base64url: string;
  signature_base64url: string;
}

export interface ParsedEntitlementToken {
  rawToken: string;
  claims: EntitlementClaims;
  metadata: EntitlementTokenMetadata;
}

export interface VerifiedEntitlementToken extends ParsedEntitlementToken {}

export function parseEntitlementToken(token: string): ParsedEntitlementToken {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new SpellError("entitlement token must be non-empty");
  }

  const segments = trimmed.split(".");
  if (segments.length !== 3 || segments[0] !== TOKEN_PREFIX) {
    throw new SpellError("invalid entitlement token format; expected ent1.<payloadBase64url>.<signatureBase64url>");
  }

  const payloadSegment = segments[1];
  const signatureSegment = segments[2];
  if (!payloadSegment || !signatureSegment) {
    throw new SpellError("invalid entitlement token format; payload and signature segments are required");
  }

  assertBase64Url(payloadSegment, "entitlement payload segment");
  assertBase64Url(signatureSegment, "entitlement signature segment");

  const payloadBytes = decodeBase64Url(payloadSegment, "entitlement payload");
  const payloadRaw = payloadBytes.toString("utf8");

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw) as unknown;
  } catch (error) {
    throw new SpellError(`invalid entitlement payload JSON: ${(error as Error).message}`);
  }

  const claims = parseEntitlementClaims(payload);

  return {
    rawToken: trimmed,
    claims,
    metadata: {
      format: "ent1",
      payload_base64url: payloadSegment,
      signature_base64url: signatureSegment
    }
  };
}

export async function verifyEntitlementToken(token: string, now: Date = new Date()): Promise<VerifiedEntitlementToken> {
  const parsed = parseEntitlementToken(token);
  const { claims, metadata } = parsed;

  const trust = await loadPublisherTrust(claims.issuer);
  if (!trust) {
    throw new SpellError(`entitlement issuer is not trusted: ${claims.issuer}`);
  }

  const key = trust.keys.find((entry) => entry.key_id === claims.key_id);
  if (!key) {
    throw new SpellError(`entitlement key_id is not trusted for issuer '${claims.issuer}': ${claims.key_id}`);
  }

  const signatureBytes = decodeBase64Url(metadata.signature_base64url, "entitlement signature");
  const publicKeyDer = decodeBase64Url(key.public_key, "trusted public key");

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  } catch (error) {
    throw new SpellError(`invalid trusted public key: ${(error as Error).message}`);
  }

  const payloadSegmentBytes = Buffer.from(metadata.payload_base64url, "utf8");
  const validSignature = verify(null, payloadSegmentBytes, publicKey, signatureBytes);
  if (!validSignature) {
    throw new SpellError("entitlement signature verification failed");
  }

  assertEntitlementWithinTimeWindow(claims, now);

  return parsed;
}

export function isEntitlementWithinTimeWindow(claims: EntitlementClaims, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  const notBeforeMs = parseIsoTimestamp(claims.not_before, "not_before");
  const expiresAtMs = parseIsoTimestamp(claims.expires_at, "expires_at");
  return nowMs >= notBeforeMs && nowMs <= expiresAtMs;
}

export function assertEntitlementWithinTimeWindow(claims: EntitlementClaims, now: Date = new Date()): void {
  const nowMs = now.getTime();
  const notBeforeMs = parseIsoTimestamp(claims.not_before, "not_before");
  const expiresAtMs = parseIsoTimestamp(claims.expires_at, "expires_at");

  if (notBeforeMs > expiresAtMs) {
    throw new SpellError("invalid entitlement payload: not_before must be <= expires_at");
  }

  if (nowMs < notBeforeMs) {
    throw new SpellError(`entitlement token not valid yet (not_before=${claims.not_before})`);
  }

  if (nowMs > expiresAtMs) {
    throw new SpellError(`entitlement token expired (expires_at=${claims.expires_at})`);
  }
}

export function parseEntitlementClaims(payload: unknown): EntitlementClaims {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SpellError("invalid entitlement payload: expected JSON object");
  }

  const obj = payload as Record<string, unknown>;
  const version = readRequiredString(obj, "version");
  if (version !== "v1") {
    throw new SpellError(`invalid entitlement payload: unsupported version '${version}'`);
  }

  const issuer = readRequiredString(obj, "issuer");
  const keyId = readRequiredString(obj, "key_id");
  const mode = readRequiredString(obj, "mode");
  if (!ENTITLEMENT_MODES.has(mode as EntitlementMode)) {
    throw new SpellError(`invalid entitlement payload: unsupported mode '${mode}'`);
  }

  const currency = readRequiredString(obj, "currency");
  const maxAmount = readRequiredNumber(obj, "max_amount");
  if (!Number.isFinite(maxAmount) || maxAmount < 0) {
    throw new SpellError("invalid entitlement payload: max_amount must be a non-negative finite number");
  }

  const notBefore = readRequiredString(obj, "not_before");
  const expiresAt = readRequiredString(obj, "expires_at");
  const notBeforeMs = parseIsoTimestamp(notBefore, "not_before");
  const expiresAtMs = parseIsoTimestamp(expiresAt, "expires_at");
  if (notBeforeMs > expiresAtMs) {
    throw new SpellError("invalid entitlement payload: not_before must be <= expires_at");
  }

  return {
    version: "v1",
    issuer,
    key_id: keyId,
    mode: mode as EntitlementMode,
    currency,
    max_amount: maxAmount,
    not_before: notBefore,
    expires_at: expiresAt
  };
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`invalid entitlement payload: missing '${key}' string`);
  }
  return value.trim();
}

function readRequiredNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number") {
    throw new SpellError(`invalid entitlement payload: missing '${key}' number`);
  }
  return value;
}

function parseIsoTimestamp(value: string, key: "not_before" | "expires_at"): number {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new SpellError(`invalid entitlement payload: '${key}' must be an ISO-8601 timestamp`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw new SpellError(`invalid entitlement payload: '${key}' is not a valid timestamp`);
  }
  return epochMs;
}

function assertBase64Url(value: string, label: string): void {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new SpellError(`invalid ${label}: must be base64url`);
  }
}

function decodeBase64Url(value: string, label: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch (error) {
    throw new SpellError(`invalid base64url for ${label}: ${(error as Error).message}`);
  }
}
