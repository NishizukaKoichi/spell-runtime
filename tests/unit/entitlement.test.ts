import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseEntitlementToken, verifyEntitlementToken } from "../../src/license/entitlement";
import { upsertTrustedPublisherKey } from "../../src/signature/trustStore";

describe("entitlement token", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-entitlement-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  test("parseEntitlementToken parses ent1 payload and required claims", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "issuer-a",
      keyId: "k1",
      mode: "on_success",
      currency: "USD",
      maxAmount: 42,
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z"
    });

    const parsed = parseEntitlementToken(token);
    expect(parsed.claims.issuer).toBe("issuer-a");
    expect(parsed.claims.key_id).toBe("k1");
    expect(parsed.claims.mode).toBe("on_success");
    expect(parsed.claims.currency).toBe("USD");
    expect(parsed.claims.max_amount).toBe(42);
    expect(parsed.metadata.format).toBe("ent1");
  });

  test("verifyEntitlementToken succeeds with trusted issuer/key and valid signature", async () => {
    const now = new Date("2026-02-18T10:30:00.000Z");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

    await upsertTrustedPublisherKey("issuer-a", {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: publicKeyDer.toString("base64url")
    });

    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "issuer-a",
      keyId: "k1",
      mode: "subscription",
      currency: "EUR",
      maxAmount: 99,
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z"
    });

    const verified = await verifyEntitlementToken(token, now);
    expect(verified.claims.mode).toBe("subscription");
    expect(verified.claims.max_amount).toBe(99);
  });

  test("verifyEntitlementToken rejects untrusted issuer", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "issuer-a",
      keyId: "k1",
      mode: "upfront",
      currency: "USD",
      maxAmount: 10,
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z"
    });

    await expect(verifyEntitlementToken(token)).rejects.toThrow("entitlement issuer is not trusted: issuer-a");
  });

  test("verifyEntitlementToken rejects signature mismatch", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const { privateKey: untrustedPrivateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

    await upsertTrustedPublisherKey("issuer-a", {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: publicKeyDer.toString("base64url")
    });

    const token = createSignedEntitlementToken({
      privateKey: untrustedPrivateKey,
      issuer: "issuer-a",
      keyId: "k1",
      mode: "upfront",
      currency: "USD",
      maxAmount: 10,
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z"
    });

    await expect(verifyEntitlementToken(token)).rejects.toThrow("entitlement signature verification failed");
  });

  test("verifyEntitlementToken rejects expired entitlement", async () => {
    const now = new Date("2026-02-18T10:30:00.000Z");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

    await upsertTrustedPublisherKey("issuer-a", {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: publicKeyDer.toString("base64url")
    });

    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "issuer-a",
      keyId: "k1",
      mode: "upfront",
      currency: "USD",
      maxAmount: 10,
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z"
    });

    await expect(verifyEntitlementToken(token, now)).rejects.toThrow("entitlement token expired");
  });
});

function createSignedEntitlementToken(options: {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  issuer: string;
  keyId: string;
  mode: "upfront" | "on_success" | "subscription";
  currency: string;
  maxAmount: number;
  notBefore: string;
  expiresAt: string;
}): string {
  const payload = {
    version: "v1",
    issuer: options.issuer,
    key_id: options.keyId,
    mode: options.mode,
    currency: options.currency,
    max_amount: options.maxAmount,
    not_before: options.notBefore,
    expires_at: options.expiresAt
  } as const;

  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signatureSegment = sign(null, Buffer.from(payloadSegment, "utf8"), options.privateKey).toString("base64url");
  return `ent1.${payloadSegment}.${signatureSegment}`;
}
