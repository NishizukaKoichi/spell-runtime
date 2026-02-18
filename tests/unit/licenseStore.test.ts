import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findMatchingLicenseForBilling,
  inspectLicense,
  licenseFilePath,
  listLicenses,
  restoreLicense,
  revokeLicense,
  upsertLicense
} from "../../src/license/store";
import { parseEntitlementToken } from "../../src/license/entitlement";
import { upsertTrustedPublisherKey } from "../../src/signature/trustStore";
import { SpellBilling } from "../../src/types";

describe("license store lifecycle", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-license-store-home-"));
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

  test("legacy v2 records load with revoked=false by default", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const now = Date.now();
    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "entitlement-dev",
      keyId: "k1",
      mode: "on_success",
      currency: "USD",
      maxAmount: 25,
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    });
    const parsed = parseEntitlementToken(token);

    const name = "legacy-v2";
    const filePath = licenseFilePath(name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: "v2",
          name,
          token: parsed.rawToken,
          token_metadata: parsed.metadata,
          entitlement: parsed.claims,
          created_at: new Date(now - 10_000).toISOString(),
          updated_at: new Date(now - 5_000).toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const entries = await listLicenses();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(name);
    expect(entries[0].revoked).toBe(false);
  });

  test("revoke/restore lifecycle updates billing eligibility", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    await upsertTrustedPublisherKey("entitlement-dev", {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: publicKeyDer.toString("base64url")
    });

    const now = Date.now();
    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "entitlement-dev",
      keyId: "k1",
      mode: "on_success",
      currency: "USD",
      maxAmount: 25,
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    });

    await upsertLicense("dev", token);

    const billing: SpellBilling = {
      enabled: true,
      mode: "on_success",
      currency: "usd",
      max_amount: 15
    };

    const fresh = await inspectLicense("dev");
    expect(fresh).not.toBeNull();
    expect(fresh?.revoked).toBe(false);
    expect(typeof fresh?.last_validated_at).toBe("string");
    expect(await findMatchingLicenseForBilling(billing, new Date(now))).toMatchObject({ name: "dev" });

    await revokeLicense("dev", "ops freeze");
    const revoked = await inspectLicense("dev");
    expect(revoked).not.toBeNull();
    expect(revoked?.revoked).toBe(true);
    expect(revoked?.revoke_reason).toBe("ops freeze");
    expect(typeof revoked?.revoked_at).toBe("string");
    expect(await findMatchingLicenseForBilling(billing, new Date(now))).toBeNull();

    await restoreLicense("dev");
    const restored = await inspectLicense("dev");
    expect(restored).not.toBeNull();
    expect(restored?.revoked).toBe(false);
    expect(restored?.revoked_at).toBeUndefined();
    expect(restored?.revoke_reason).toBeUndefined();
    expect(await findMatchingLicenseForBilling(billing, new Date(now))).toMatchObject({ name: "dev" });
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

  const payloadBase64Url = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signatureBase64Url = sign(null, Buffer.from(payloadBase64Url, "utf8"), options.privateKey).toString("base64url");
  return `ent1.${payloadBase64Url}.${signatureBase64Url}`;
}
