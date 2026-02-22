import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { parseEntitlementToken } from "../../src/license/entitlement";
import { issueEntitlementToken } from "../../src/optional/entitlementIssuer";

describe("optional entitlement issuer", () => {
  test("issues signed ent1 token with server-controlled claims", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    const now = new Date("2026-02-22T00:00:00.000Z");
    const issued = issueEntitlementToken(
      {
        issuer: "spell-runtime-market",
        keyId: "k1",
        privateKeyPem: privatePem
      },
      {
        mode: "on_success",
        currency: "usd",
        maxAmount: 25,
        ttlSeconds: 3600
      },
      now
    );

    const parsed = parseEntitlementToken(issued.token);
    expect(parsed.claims.issuer).toBe("spell-runtime-market");
    expect(parsed.claims.key_id).toBe("k1");
    expect(parsed.claims.mode).toBe("on_success");
    expect(parsed.claims.currency).toBe("USD");
    expect(parsed.claims.max_amount).toBe(25);

    const signatureValid = verify(
      null,
      Buffer.from(parsed.metadata.payload_base64url, "utf8"),
      publicKey,
      Buffer.from(parsed.metadata.signature_base64url, "base64url")
    );
    expect(signatureValid).toBe(true);
  });
});
