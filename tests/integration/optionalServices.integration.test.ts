import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseEntitlementToken } from "../../src/license/entitlement";
import { startBillingIssuerServer } from "../../src/optional/billing-server";
import { startKeyBrokerServer } from "../../src/optional/key-server";
import { startMarketServer } from "../../src/optional/market-server";

describe("optional services integration", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let previousEnv: Record<string, string | undefined>;

  const envKeys = [
    "SPELL_REQUIRES_KEY_API_TOKEN",
    "SPELL_REQUIRES_KEY_STORE_PATH",
    "SPELL_MARKET_CATALOG_PATH",
    "SPELL_BILLING_API_TOKEN",
    "SPELL_BILLING_ISSUER",
    "SPELL_BILLING_KEY_ID",
    "SPELL_BILLING_PRIVATE_KEY_PATH"
  ] as const;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-optional-home-"));
    process.env.HOME = tempHome;

    previousEnv = {};
    for (const key of envKeys) {
      previousEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  test("spell requires key resolves token by tenant with auth", async () => {
    const storePath = path.join(tempHome, ".spell", "spell-requires-key.v1.json");
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: "v1",
          tenants: {
            default: {
              connectors: {
                github: { token: "gh-default", scopes: ["repo"] }
              }
            },
            team_a: {
              connectors: {
                cloudflare: { token: "cf-team-a", scopes: ["workers.write"] }
              }
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    process.env.SPELL_REQUIRES_KEY_STORE_PATH = storePath;
    process.env.SPELL_REQUIRES_KEY_API_TOKEN = "key-token";

    const server = await startKeyBrokerServer(0);
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/resolve-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: "team_a", connector: "cloudflare" })
      });
      expect(unauthorized.status).toBe(401);

      const resolved = await fetch(`http://127.0.0.1:${server.port}/v1/resolve-token`, {
        method: "POST",
        headers: { authorization: "Bearer key-token", "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: "team_a", connector: "github" })
      });
      expect(resolved.status).toBe(200);
      const payload = (await resolved.json()) as Record<string, unknown>;
      expect(payload.tenant_id).toBe("default");
      expect(payload.connector).toBe("github");
      expect(payload.token).toBe("gh-default");
    } finally {
      await server.close();
    }
  });

  test("spell market returns filtered spell catalog", async () => {
    const catalogPath = path.join(tempHome, ".spell", "market", "catalog.v1.json");
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(
      catalogPath,
      `${JSON.stringify(
        {
          version: "v1",
          spells: [
            {
              id: "samples/call-webhook",
              version: "1.0.0",
              name: "Call Webhook",
              summary: "Send deploy webhook",
              publisher: "samples",
              risk: "low",
              source: "registry:samples/call-webhook@1.0.0",
              tags: ["webhook", "deploy"]
            },
            {
              id: "samples/publish-site",
              version: "1.0.0",
              name: "Publish Site",
              summary: "Deploy static site",
              publisher: "samples",
              risk: "high",
              source: "registry:samples/publish-site@1.0.0",
              tags: ["deploy"]
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    process.env.SPELL_MARKET_CATALOG_PATH = catalogPath;

    const server = await startMarketServer(0);
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/spells?query=deploy&risk=high&latest=true&limit=10`
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        count: number;
        spells: Array<{ id: string }>;
      };
      expect(payload.count).toBe(1);
      expect(payload.spells[0]?.id).toBe("samples/publish-site");
    } finally {
      await server.close();
    }
  });

  test("billing issuer issues ent1 token with auth", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    const keyPath = path.join(tempHome, ".spell", "billing", "issuer.private.pem");
    await mkdir(path.dirname(keyPath), { recursive: true });
    await writeFile(keyPath, `${privatePem}\n`, "utf8");

    process.env.SPELL_BILLING_PRIVATE_KEY_PATH = keyPath;
    process.env.SPELL_BILLING_ISSUER = "spell-runtime-market";
    process.env.SPELL_BILLING_KEY_ID = "k1";
    process.env.SPELL_BILLING_API_TOKEN = "billing-token";

    const server = await startBillingIssuerServer(0);
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/entitlements/issue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "on_success", currency: "USD", max_amount: 10 })
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/entitlements/issue`, {
        method: "POST",
        headers: { authorization: "Bearer billing-token", "content-type": "application/json" },
        body: JSON.stringify({ mode: "on_success", currency: "USD", max_amount: 10, ttl_seconds: 1200 })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { token: string; claims: Record<string, unknown> };
      const parsed = parseEntitlementToken(payload.token);
      expect(parsed.claims.issuer).toBe("spell-runtime-market");
      expect(parsed.claims.key_id).toBe("k1");
      expect(parsed.claims.mode).toBe("on_success");
      expect(parsed.claims.max_amount).toBe(10);
    } finally {
      await server.close();
    }
  });
});
