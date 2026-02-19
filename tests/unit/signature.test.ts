import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeBundleDigest } from "../../src/signature/bundleDigest";
import {
  loadPublisherTrust,
  publisherTrustFilePath,
  removeTrustedPublisherKey,
  restoreTrustedPublisherKey,
  revokeTrustedPublisherKey,
  upsertTrustedPublisherKey
} from "../../src/signature/trustStore";
import { verifyBundleSignature } from "../../src/signature/verify";
import { loadManifestFromDir } from "../../src/bundle/manifest";

describe("signature", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-sig-home-"));
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

  test("computeBundleDigest is deterministic and changes on file content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "spell-digest-"));

    try {
      await mkdir(path.join(dir, "steps"), { recursive: true });
      await writeFile(path.join(dir, "spell.yaml"), "id: pub/digest\nversion: 1.0.0\nname: x\nsummary: x\ninputs_schema: ./schema.json\nrisk: low\npermissions: []\neffects: []\nbilling:\n  enabled: false\n  mode: none\n  currency: USD\n  max_amount: 0\nruntime:\n  execution: host\n  platforms: [darwin/arm64]\nsteps:\n  - uses: shell\n    name: s\n    run: steps/s.js\nchecks:\n  - type: exit_code\n    params: {}\n", "utf8");
      await writeFile(path.join(dir, "schema.json"), "{\"type\":\"object\"}\n", "utf8");
      await writeFile(path.join(dir, "steps", "s.js"), "console.log('a')\n", "utf8");

      const first = await computeBundleDigest(dir);
      const second = await computeBundleDigest(dir);
      expect(first.valueHex).toBe(second.valueHex);

      await writeFile(path.join(dir, "steps", "s.js"), "console.log('b')\n", "utf8");
      const third = await computeBundleDigest(dir);
      expect(third.valueHex).not.toBe(first.valueHex);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("verifyBundleSignature succeeds with trusted key and matching digest", async () => {
    const bundleDir = await mkdtemp(path.join(tmpdir(), "spell-signed-bundle-"));

    try {
      const publisher = "pub";
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

      await upsertTrustedPublisherKey(publisher, {
        key_id: "default",
        algorithm: "ed25519",
        public_key: publicKeyDer.toString("base64url")
      });

      await mkdir(path.join(bundleDir, "steps"), { recursive: true });

      const stepPath = path.join(bundleDir, "steps", "hello.js");
      await writeFile(stepPath, "#!/usr/bin/env node\nprocess.stdout.write('hello\\n');\n", "utf8");
      await chmod(stepPath, 0o755);

      await writeFile(
        path.join(bundleDir, "schema.json"),
        JSON.stringify(
          {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: true
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      await writeFile(
        path.join(bundleDir, "spell.yaml"),
        [
          "id: pub/signed",
          "version: 1.0.0",
          "name: Signed",
          "summary: signed bundle",
          "inputs_schema: ./schema.json",
          "risk: low",
          "permissions: []",
          "effects: []",
          "billing:",
          "  enabled: false",
          "  mode: none",
          "  currency: USD",
          "  max_amount: 0",
          "runtime:",
          "  execution: host",
          "  platforms:",
          "    - darwin/arm64",
          "steps:",
          "  - uses: shell",
          "    name: hello",
          "    run: steps/hello.js",
          "checks:",
          "  - type: exit_code",
          "    params: {}",
          ""
        ].join("\n"),
        "utf8"
      );

      const digest = await computeBundleDigest(bundleDir);
      const signature = sign(null, digest.value, privateKey);

      await writeFile(
        path.join(bundleDir, "spell.sig.json"),
        JSON.stringify(
          {
            version: "v1",
            publisher,
            key_id: "default",
            algorithm: "ed25519",
            digest: { algorithm: "sha256", value: digest.valueHex },
            signature: signature.toString("base64url")
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      const { manifest } = await loadManifestFromDir(bundleDir);
      const result = await verifyBundleSignature(manifest, bundleDir);
      expect(result.ok).toBe(true);
      expect(result.status).toBe("verified");
      expect(result.publisher).toBe(publisher);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  test("loadPublisherTrust treats missing revoked metadata as active", async () => {
    const publisher = "legacy";
    const trustFile = publisherTrustFilePath(publisher);

    await mkdir(path.dirname(trustFile), { recursive: true });
    await writeFile(
      trustFile,
      JSON.stringify(
        {
          version: "v1",
          publisher,
          keys: [
            {
              key_id: "default",
              algorithm: "ed25519",
              public_key: "AAAA"
            }
          ]
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const loaded = await loadPublisherTrust(publisher);
    expect(loaded).not.toBeNull();
    expect(loaded?.keys).toHaveLength(1);
    expect(loaded?.keys[0]?.revoked).toBe(false);
    expect(loaded?.keys[0]?.revoked_at).toBeUndefined();
    expect(loaded?.keys[0]?.revoke_reason).toBeUndefined();
  });

  test("removeTrustedPublisherKey removes only the target key and keeps publisher trust", async () => {
    const publisher = "rotation";

    await upsertTrustedPublisherKey(publisher, {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: "AAAA"
    });
    await upsertTrustedPublisherKey(publisher, {
      key_id: "k2",
      algorithm: "ed25519",
      public_key: "BBBB"
    });

    const removed = await removeTrustedPublisherKey(publisher, "k1");
    expect(removed.key_id).toBe("k1");

    const trust = await loadPublisherTrust(publisher);
    expect(trust).not.toBeNull();
    expect(trust?.keys.map((entry) => entry.key_id)).toEqual(["k2"]);
  });

  test("removeTrustedPublisherKey removes publisher trust file when last key is deleted", async () => {
    const publisher = "single-key";

    await upsertTrustedPublisherKey(publisher, {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: "AAAA"
    });

    const removed = await removeTrustedPublisherKey(publisher, "k1");
    expect(removed.key_id).toBe("k1");

    const trust = await loadPublisherTrust(publisher);
    expect(trust).toBeNull();
  });

  test("removeTrustedPublisherKey fails clearly for missing publisher or key", async () => {
    await expect(removeTrustedPublisherKey("missing-publisher", "k1")).rejects.toThrow(
      "trusted publisher not found: missing-publisher"
    );

    await upsertTrustedPublisherKey("missing-key", {
      key_id: "k1",
      algorithm: "ed25519",
      public_key: "AAAA"
    });

    await expect(removeTrustedPublisherKey("missing-key", "k2")).rejects.toThrow(
      "trusted key not found: publisher=missing-key key_id=k2"
    );
  });

  test("revoke/restore trusted key blocks and restores signature verification", async () => {
    const bundleDir = await mkdtemp(path.join(tmpdir(), "spell-signed-bundle-revoke-"));

    try {
      const publisher = "pub";
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

      await upsertTrustedPublisherKey(publisher, {
        key_id: "default",
        algorithm: "ed25519",
        public_key: publicKeyDer.toString("base64url")
      });

      await mkdir(path.join(bundleDir, "steps"), { recursive: true });

      const stepPath = path.join(bundleDir, "steps", "hello.js");
      await writeFile(stepPath, "#!/usr/bin/env node\nprocess.stdout.write('hello\\n');\n", "utf8");
      await chmod(stepPath, 0o755);

      await writeFile(
        path.join(bundleDir, "schema.json"),
        JSON.stringify(
          {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: true
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      await writeFile(
        path.join(bundleDir, "spell.yaml"),
        [
          "id: pub/signed",
          "version: 1.0.0",
          "name: Signed",
          "summary: signed bundle",
          "inputs_schema: ./schema.json",
          "risk: low",
          "permissions: []",
          "effects: []",
          "billing:",
          "  enabled: false",
          "  mode: none",
          "  currency: USD",
          "  max_amount: 0",
          "runtime:",
          "  execution: host",
          "  platforms:",
          "    - darwin/arm64",
          "steps:",
          "  - uses: shell",
          "    name: hello",
          "    run: steps/hello.js",
          "checks:",
          "  - type: exit_code",
          "    params: {}",
          ""
        ].join("\n"),
        "utf8"
      );

      const digest = await computeBundleDigest(bundleDir);
      const signature = sign(null, digest.value, privateKey);

      await writeFile(
        path.join(bundleDir, "spell.sig.json"),
        JSON.stringify(
          {
            version: "v1",
            publisher,
            key_id: "default",
            algorithm: "ed25519",
            digest: { algorithm: "sha256", value: digest.valueHex },
            signature: signature.toString("base64url")
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      const { manifest } = await loadManifestFromDir(bundleDir);
      const verified = await verifyBundleSignature(manifest, bundleDir);
      expect(verified.ok).toBe(true);
      expect(verified.status).toBe("verified");

      const revoked = await revokeTrustedPublisherKey(publisher, "default", "rotation");
      expect(revoked.revoked).toBe(true);
      expect(revoked.revoked_at).toBeTypeOf("string");
      expect(revoked.revoke_reason).toBe("rotation");

      const trustAfterRevoke = await loadPublisherTrust(publisher);
      expect(trustAfterRevoke?.keys[0]?.revoked).toBe(true);

      const blocked = await verifyBundleSignature(manifest, bundleDir);
      expect(blocked.ok).toBe(false);
      expect(blocked.status).toBe("invalid");
      expect(blocked.message).toContain("trusted key_id is revoked: default");

      const restored = await restoreTrustedPublisherKey(publisher, "default");
      expect(restored.revoked).toBe(false);
      expect(restored.revoked_at).toBeUndefined();
      expect(restored.revoke_reason).toBeUndefined();

      const trustAfterRestore = await loadPublisherTrust(publisher);
      expect(trustAfterRestore?.keys[0]?.revoked).toBe(false);

      const verifiedAgain = await verifyBundleSignature(manifest, bundleDir);
      expect(verifiedAgain.ok).toBe(true);
      expect(verifiedAgain.status).toBe("verified");
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });
});
