import { chmod, copyFile, cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../../src/cli/index";
import { computeBundleDigest } from "../../src/signature/bundleDigest";
import { toIdKey } from "../../src/util/idKey";

describe("spell cli integration", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-home-"));
    process.env.HOME = tempHome;
    delete process.env.CONNECTOR_GITHUB_TOKEN;
    delete process.env.TEST_HEADER;
    delete process.env.APP_SECRET;
    delete process.env.SPELL_RUNTIME_INPUT_MAX_BYTES;
    delete process.env.SPELL_RUNTIME_STEP_TIMEOUT_MS;
    delete process.env.SPELL_RUNTIME_EXECUTION_TIMEOUT_MS;
  });

  afterEach(async () => {
    nock.cleanAll();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.APP_SECRET;
    delete process.env.SPELL_RUNTIME_INPUT_MAX_BYTES;
    delete process.env.SPELL_RUNTIME_STEP_TIMEOUT_MS;
    delete process.env.SPELL_RUNTIME_EXECUTION_TIMEOUT_MS;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("install -> list -> inspect -> cast --dry-run flow", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");

    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);
    expect(await runCli(["node", "spell", "list"])).toBe(0);
    expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host"])).toBe(0);
    expect(
      await runCli(["node", "spell", "cast", "fixtures/hello-host", "--allow-unsigned", "--dry-run", "-p", "name=world"])
    ).toBe(0);
    expect(await runCli(["node", "spell", "cast", "fixtures/hello-host", "--allow-unsigned", "-p", "name=world"])).toBe(0);

    const logsDir = path.join(tempHome, ".spell", "logs");
    const logs = await readdir(logsDir);
    expect(logs.length).toBeGreaterThan(0);

    const sourceMetadata = JSON.parse(
      await readFile(installedSourceMetadataPath(tempHome, "fixtures/hello-host", "1.0.0"), "utf8")
    ) as Record<string, unknown>;
    expect(sourceMetadata).toMatchObject({
      type: "local",
      source: fixture
    });
    expect(Number.isNaN(Date.parse(String(sourceMetadata.installed_at)))).toBe(false);
  });

  test("install supports git https sources", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;

    try {
      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(await runCli(["node", "spell", "install", gitSource])).toBe(0);
      });

      expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host"])).toBe(0);

      const sourceMetadata = JSON.parse(
        await readFile(installedSourceMetadataPath(tempHome, "fixtures/hello-host", "1.0.0"), "utf8")
      ) as Record<string, unknown>;
      expect(sourceMetadata).toMatchObject({
        type: "git",
        source: gitSource,
        ref: "main",
        commit: gitRepo.commit
      });
      expect(Number.isNaN(Date.parse(String(sourceMetadata.installed_at)))).toBe(false);
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("registry set/show and install resolves a registry source", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;
    const indexUrl = "https://registry.test/spell-index.v1.json";

    try {
      expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

      const showResult = await runCliCapture(["node", "spell", "registry", "show"]);
      expect(showResult.code).toBe(0);
      expect(showResult.stdout).toContain("name\turl");
      expect(showResult.stdout).toContain(`default\t${indexUrl}`);

      nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: gitSource,
            commit: gitRepo.commit.toUpperCase()
          }
        ]
      });

      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(await runCli(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"])).toBe(0);
      });

      const sourceMetadata = JSON.parse(
        await readFile(installedSourceMetadataPath(tempHome, "fixtures/hello-host", "1.0.0"), "utf8")
      ) as Record<string, unknown>;
      expect(sourceMetadata).toMatchObject({
        type: "git",
        source: gitSource,
        ref: "main",
        commit: gitRepo.commit
      });
      expect(Number.isNaN(Date.parse(String(sourceMetadata.installed_at)))).toBe(false);
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("registry install reports missing entry", async () => {
    const indexUrl = "https://registry.test/spell-index.v1.json";
    expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: []
    });

    const result = await runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry entry not found: fixtures/hello-host@1.0.0");
  });

  test("registry install fails when commit pin does not match cloned HEAD", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;
    const indexUrl = "https://registry.test/spell-index.v1.json";
    const expectedCommit = "0000000000000000000000000000000000000000";

    try {
      expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

      nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: gitSource,
            commit: expectedCommit
          }
        ]
      });

      const result = await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () =>
        runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"])
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`registry commit mismatch: expected ${expectedCommit}, got ${gitRepo.commit}`);
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("install from git source requires explicit ref", async () => {
    const result = await runCliCapture(["node", "spell", "install", "https://spell.test/repo.git"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git source requires explicit ref (#<ref>)");
  });

  test("install from git source reports clone failure", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "spell-git-missing-"));
    const gitUrl = "https://spell.test/missing.git";
    const gitSource = `${gitUrl}#main`;
    const missingRemote = path.join(tempDir, "missing.git");

    try {
      await withGitUrlRewrite(gitUrl, missingRemote, async () => {
        const result = await runCliCapture(["node", "spell", "install", gitSource]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("failed to clone git source");
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("install from git source fails when cloned root has no spell.yaml", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture, { removeSpellYaml: true });
    const gitUrl = "https://spell.test/no-manifest.git";
    const gitSource = `${gitUrl}#main`;

    try {
      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        const result = await runCliCapture(["node", "spell", "install", gitSource]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("spell.yaml not found");
      });
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("install from git source reports missing git executable", async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const result = await runCliCapture(["node", "spell", "install", "https://spell.test/repo.git#main"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("git executable not found");
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  test("license commands add/inspect/revoke/restore/remove local tokens", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(await runCli(["node", "spell", "trust", "add", "entitlement-dev", publicKeyDer.toString("base64url"), "--key-id", "k1"])).toBe(0);

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

    const addResult = await runCliCapture(["node", "spell", "license", "add", "dev", token]);
    expect(addResult.code).toBe(0);

    const inspectResult = await runCliCapture(["node", "spell", "license", "inspect", "dev"]);
    expect(inspectResult.code).toBe(0);
    expect(inspectResult.stdout).toContain("issuer: entitlement-dev");
    expect(inspectResult.stdout).toContain("mode: on_success");
    expect(inspectResult.stdout).toContain("currency: USD");
    expect(inspectResult.stdout).toContain("max_amount: 25");
    expect(inspectResult.stdout).toContain("window:");
    expect(inspectResult.stdout).toContain("revoked: false");

    const listResult = await runCliCapture(["node", "spell", "license", "list"]);
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("name\tissuer\tmode\tcurrency\tmax_amount\texpires_at\trevoked\tupdated_at");
    expect(listResult.stdout).toContain("dev\tentitlement-dev\ton_success\tUSD\t25\t");
    expect(listResult.stdout).toContain("\tfalse\t");
    expect(listResult.stdout).not.toContain(token);

    const revokeResult = await runCliCapture([
      "node",
      "spell",
      "license",
      "revoke",
      "dev",
      "--reason",
      "incident window"
    ]);
    expect(revokeResult.code).toBe(0);

    const inspectRevoked = await runCliCapture(["node", "spell", "license", "inspect", "dev"]);
    expect(inspectRevoked.code).toBe(0);
    expect(inspectRevoked.stdout).toContain("revoked: true");

    const restoreResult = await runCliCapture(["node", "spell", "license", "restore", "dev"]);
    expect(restoreResult.code).toBe(0);

    const inspectRestored = await runCliCapture(["node", "spell", "license", "inspect", "dev"]);
    expect(inspectRestored.code).toBe(0);
    expect(inspectRestored.stdout).toContain("revoked: false");

    const removeResult = await runCliCapture(["node", "spell", "license", "remove", "dev"]);
    expect(removeResult.code).toBe(0);

    const listAfterRemove = await runCliCapture(["node", "spell", "license", "list"]);
    expect(listAfterRemove.code).toBe(0);
    expect(listAfterRemove.stdout).toContain("No licenses");
  });

  test("billing guard blocks without --allow-billing", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/billing-guard", "--allow-unsigned"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("billing enabled requires --allow-billing");
  });

  test("billing guard blocks without matching entitlement after --allow-billing", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(await runCli(["node", "spell", "trust", "add", "entitlement-mismatch", publicKeyDer.toString("base64url"), "--key-id", "k1"])).toBe(0);

    const now = Date.now();
    const nonMatchingToken = createSignedEntitlementToken({
      privateKey,
      issuer: "entitlement-mismatch",
      keyId: "k1",
      mode: "upfront",
      currency: "USD",
      maxAmount: 10,
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    });
    expect(await runCli(["node", "spell", "license", "add", "dev-mismatch", nonMatchingToken])).toBe(0);

    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/billing-guard",
      "--allow-unsigned",
      "--allow-billing"
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("billing enabled requires matching entitlement token");
  });

  test("billing guard passes with --allow-billing when a matching entitlement exists", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(await runCli(["node", "spell", "trust", "add", "entitlement-ok", publicKeyDer.toString("base64url"), "--key-id", "k1"])).toBe(0);

    const now = Date.now();
    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "entitlement-ok",
      keyId: "k1",
      mode: "on_success",
      currency: "usd",
      maxAmount: 15,
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    });
    expect(await runCli(["node", "spell", "license", "add", "dev", token])).toBe(0);

    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/billing-guard",
      "--allow-unsigned",
      "--allow-billing"
    ]);
    expect(result.code).toBe(0);

    const logsDir = path.join(tempHome, ".spell", "logs");
    const logs = (await readdir(logsDir)).sort();
    const lastLog = logs[logs.length - 1];
    const payload = JSON.parse(await readFile(path.join(logsDir, lastLog), "utf8")) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;

    expect(summary.license).toEqual({ licensed: true, name: "dev" });
  });

  test("revoked entitlement blocks billing and restore re-enables billing", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(
      await runCli(["node", "spell", "trust", "add", "entitlement-lifecycle", publicKeyDer.toString("base64url"), "--key-id", "k1"])
    ).toBe(0);

    const now = Date.now();
    const token = createSignedEntitlementToken({
      privateKey,
      issuer: "entitlement-lifecycle",
      keyId: "k1",
      mode: "on_success",
      currency: "USD",
      maxAmount: 30,
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    });
    expect(await runCli(["node", "spell", "license", "add", "lifecycle", token])).toBe(0);

    const beforeRevoke = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/billing-guard",
      "--allow-unsigned",
      "--allow-billing"
    ]);
    expect(beforeRevoke.code).toBe(0);

    const revoke = await runCliCapture([
      "node",
      "spell",
      "license",
      "revoke",
      "lifecycle",
      "--reason",
      "incident response"
    ]);
    expect(revoke.code).toBe(0);

    const blocked = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/billing-guard",
      "--allow-unsigned",
      "--allow-billing"
    ]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("billing enabled requires matching entitlement token");

    const restore = await runCliCapture(["node", "spell", "license", "restore", "lifecycle"]);
    expect(restore.code).toBe(0);

    const afterRestore = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/billing-guard",
      "--allow-unsigned",
      "--allow-billing"
    ]);
    expect(afterRestore.code).toBe(0);
  });

  test("risk guard blocks without --yes", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/risk-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/risk-guard", "--allow-unsigned"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("risk high requires --yes");
  });

  test("policy file default deny blocks cast", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const spellDir = path.join(tempHome, ".spell");
    await mkdir(spellDir, { recursive: true });
    await writeFile(
      path.join(spellDir, "policy.json"),
      `${JSON.stringify({ version: "v1", default: "deny" }, null, 2)}\n`,
      "utf8"
    );

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/hello-host", "-p", "name=world"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("policy denied: default policy is deny");
  });

  test("permissions guard blocks without connector token", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/permissions-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/permissions-guard", "--allow-unsigned"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing connector token CONNECTOR_GITHUB_TOKEN");
  });

  test("platform guard blocks on mismatch", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/platform-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/platform-guard", "--allow-unsigned"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("platform mismatch:");
  });

  test("http step with nock succeeds and logs outputs", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/http-step");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    process.env.TEST_HEADER = "header-value";

    nock("https://api.example.test")
      .post("/v1/deploy/demo", { project: "demo" })
      .matchHeader("x-test-header", "header-value")
      .reply(200, {
        health_url: "https://status.example.test/health/abc123",
        data: {
          id: "abc123"
        }
      });

    nock("https://status.example.test").get("/health/abc123").reply(200, "ok");

    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/http-step",
      "--allow-unsigned",
      "-p",
      "project=demo"
    ]);
    expect(result.code).toBe(0);

    const logsDir = path.join(tempHome, ".spell", "logs");
    const logs = (await readdir(logsDir)).sort();
    const lastLog = logs[logs.length - 1];
    const payload = JSON.parse(await readFile(path.join(logsDir, lastLog), "utf8")) as Record<string, unknown>;

    const outputs = payload.outputs as Record<string, unknown>;
    const stepOutput = outputs["step.request.json"] as Record<string, unknown>;
    expect(stepOutput.data).toEqual({ id: "abc123" });
  });

  test("real sample: call-webhook succeeds with http checks", async () => {
    const sample = path.join(process.cwd(), "examples/spells/call-webhook");
    expect(await runCli(["node", "spell", "install", sample])).toBe(0);

    nock("https://hooks.example.test")
      .post("/v1/events/deploy", { event: "deploy", payload: { service: "web" } })
      .matchHeader("x-source", "manual")
      .reply(200, {
        status_url: "https://status.example.test/call-webhook/ok",
        data: { accepted: true }
      });

    nock("https://status.example.test").get("/call-webhook/ok").reply(200, "ok");

    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "samples/call-webhook",
      "--allow-unsigned",
      "-p",
      "event=deploy",
      "-p",
      "source=manual",
      "-p",
      'payload={"service":"web"}'
    ]);

    expect(result.code).toBe(0);
  });

  test("real sample: repo-ops is blocked without connector token", async () => {
    const sample = path.join(process.cwd(), "examples/spells/repo-ops");
    expect(await runCli(["node", "spell", "install", sample])).toBe(0);

    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "samples/repo-ops",
      "--allow-unsigned",
      "-p",
      "branch=main"
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing connector token CONNECTOR_GITHUB_TOKEN");
  });

  test("real sample: publish-site requires --yes then succeeds", async () => {
    const sample = path.join(process.cwd(), "examples/spells/publish-site");
    expect(await runCli(["node", "spell", "install", sample])).toBe(0);

    const blocked = await runCliCapture([
      "node",
      "spell",
      "cast",
      "samples/publish-site",
      "--allow-unsigned",
      "-p",
      "site_name=demo"
    ]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("risk high requires --yes");

    const ok = await runCliCapture([
      "node",
      "spell",
      "cast",
      "samples/publish-site",
      "--allow-unsigned",
      "--yes",
      "-p",
      "site_name=demo"
    ]);
    expect(ok.code).toBe(0);
  });

  test("execution logs redact sensitive input and env-derived values", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    process.env.APP_SECRET = "env-secret-value";

    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/hello-host",
      "--allow-unsigned",
      "-p",
      "name=env-secret-value",
      "-p",
      "token=plain-secret"
    ]);
    expect(result.code).toBe(0);

    const logsDir = path.join(tempHome, ".spell", "logs");
    const logs = (await readdir(logsDir)).sort();
    const lastLog = logs[logs.length - 1];
    const raw = await readFile(path.join(logsDir, lastLog), "utf8");

    expect(raw).not.toContain("env-secret-value");
    expect(raw).not.toContain("plain-secret");

    const payload = JSON.parse(raw) as { input: { name: string; token: string } };
    expect(payload.input.name).toBe("[REDACTED]");
    expect(payload.input.token).toBe("[REDACTED]");
  });

  test("cast rejects merged input above SPELL_RUNTIME_INPUT_MAX_BYTES", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    process.env.SPELL_RUNTIME_INPUT_MAX_BYTES = "8";
    const result = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/hello-host",
      "--allow-unsigned",
      "-p",
      "name=world"
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("merged input is");
    expect(result.stderr).toContain("SPELL_RUNTIME_INPUT_MAX_BYTES=8");
  });

  test("cast fails when a shell step exceeds SPELL_RUNTIME_STEP_TIMEOUT_MS", async () => {
    const bundleDir = await createHostShellBundle("tests/step-timeout", [
      {
        name: "slow",
        fileName: "slow.js",
        source: "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write('done\\n'); }, 200);\n"
      }
    ]);

    try {
      expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

      process.env.SPELL_RUNTIME_STEP_TIMEOUT_MS = "50";
      const result = await runCliCapture([
        "node",
        "spell",
        "cast",
        "tests/step-timeout",
        "--allow-unsigned",
        "-p",
        "name=world"
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("shell step 'slow' timed out after 50ms");
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  test("cast fails when SPELL_RUNTIME_EXECUTION_TIMEOUT_MS is exceeded", async () => {
    const bundleDir = await createHostShellBundle("tests/execution-timeout", [
      {
        name: "slow",
        fileName: "slow.js",
        source: "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write('done\\n'); }, 300);\n"
      }
    ]);

    try {
      expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

      process.env.SPELL_RUNTIME_STEP_TIMEOUT_MS = "1000";
      process.env.SPELL_RUNTIME_EXECUTION_TIMEOUT_MS = "80";
      const result = await runCliCapture([
        "node",
        "spell",
        "cast",
        "tests/execution-timeout",
        "--allow-unsigned",
        "-p",
        "name=world"
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("cast execution timed out after 80ms while running step 'slow'");
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  test("signature guard blocks without trust and allows with trust", async () => {
    const bundleDir = await mkdtemp(path.join(tmpdir(), "spell-signed-"));
    const stepsDir = path.join(bundleDir, "steps");
    await mkdir(stepsDir, { recursive: true });

    const stepPath = path.join(stepsDir, "hello.js");
    await writeFile(stepPath, "#!/usr/bin/env node\nprocess.stdout.write('signed-hello\\n');\n", "utf8");
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
        "id: signed/hello",
        "version: 1.0.0",
        "name: Signed Hello",
        "summary: signed bundle",
        "inputs_schema: ./schema.json",
        "risk: low",
        "permissions: []",
        "effects:",
        "  - type: notify",
        "    target: stdout",
        "    mutates: false",
        "billing:",
        "  enabled: false",
        "  mode: none",
        "  currency: USD",
        "  max_amount: 0",
        "runtime:",
        "  execution: host",
        "  platforms:",
        `    - ${process.platform}/${process.arch}`,
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

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

    const digest = await computeBundleDigest(bundleDir);
    const signature = sign(null, digest.value, privateKey);

    await writeFile(
      path.join(bundleDir, "spell.sig.json"),
      JSON.stringify(
        {
          version: "v1",
          publisher: "signed",
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

    try {
      expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

      const blocked = await runCliCapture([
        "node",
        "spell",
        "cast",
        "signed/hello",
        "--require-signature",
        "-p",
        "name=world"
      ]);
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain("signature required:");

      expect(await runCli(["node", "spell", "trust", "add", "signed", publicKeyDer.toString("base64url")])).toBe(0);

      const ok = await runCliCapture([
        "node",
        "spell",
        "cast",
        "signed/hello",
        "--require-signature",
        "-p",
        "name=world"
      ]);
      expect(ok.code).toBe(0);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  test("cast requires signature by default and --allow-unsigned bypasses for unsigned bundles", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const blocked = await runCliCapture(["node", "spell", "cast", "fixtures/hello-host", "-p", "name=world"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("signature required:");

    const allowed = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/hello-host",
      "--allow-unsigned",
      "-p",
      "name=world"
    ]);
    expect(allowed.code).toBe(0);
  });

  test("sign keygen + sign bundle commands produce a verifiable signature", async () => {
    const bundleDir = await mkdtemp(path.join(tmpdir(), "spell-signed-cmd-"));
    const keysDir = path.join(bundleDir, "keys");
    const stepsDir = path.join(bundleDir, "steps");
    await mkdir(stepsDir, { recursive: true });

    try {
      const stepPath = path.join(stepsDir, "hello.js");
      await writeFile(stepPath, "#!/usr/bin/env node\nprocess.stdout.write('signed-cmd\\n');\n", "utf8");
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
          "id: signed/cmd-hello",
          "version: 1.0.0",
          "name: Signed Cmd Hello",
          "summary: signed bundle generated by CLI commands",
          "inputs_schema: ./schema.json",
          "risk: low",
          "permissions: []",
          "effects:",
          "  - type: notify",
          "    target: stdout",
          "    mutates: false",
          "billing:",
          "  enabled: false",
          "  mode: none",
          "  currency: USD",
          "  max_amount: 0",
          "runtime:",
          "  execution: host",
          "  platforms:",
          `    - ${process.platform}/${process.arch}`,
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

      expect(
        await runCli(["node", "spell", "sign", "keygen", "signed", "--key-id", "k1", "--out-dir", keysDir])
      ).toBe(0);

      const publicKeyPath = path.join(keysDir, "signed__k1.public.b64url.txt");
      const privateKeyPath = path.join(keysDir, "signed__k1.private.pem");
      const publicKey = (await readFile(publicKeyPath, "utf8")).trim();

      expect(await runCli(["node", "spell", "trust", "add", "signed", publicKey, "--key-id", "k1"])).toBe(0);
      expect(
        await runCli([
          "node",
          "spell",
          "sign",
          "bundle",
          bundleDir,
          "--private-key",
          privateKeyPath,
          "--key-id",
          "k1"
        ])
      ).toBe(0);

      expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

      const ok = await runCliCapture([
        "node",
        "spell",
        "cast",
        "signed/cmd-hello",
        "--require-signature",
        "-p",
        "name=world"
      ]);
      expect(ok.code).toBe(0);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  const dockerTest = process.env.SPELL_DOCKER_TESTS === "1" ? test : test.skip;
  dockerTest("docker execution succeeds (runner-in-image)", async () => {
    const repoRoot = process.cwd();

    // Build and pack this repo so a Docker image can install spell-runner.
    await runCommand("npm", ["run", "build"], repoRoot);

    const packDir = await mkdtemp(path.join(tmpdir(), "spell-pack-"));
    const packed = await runCommand("npm", ["pack", "--silent", "--pack-destination", packDir], repoRoot);
    const tgzName = packed.stdout.trim().split(/\s+/).pop();
    if (!tgzName) {
      throw new Error("npm pack produced no output");
    }
    const tgzPath = path.join(packDir, tgzName);

    const dockerContext = await mkdtemp(path.join(tmpdir(), "spell-docker-context-"));
    const imageTag = `spell-runtime-test-runner:${Date.now()}`;

    try {
      await copyFile(tgzPath, path.join(dockerContext, "spell-runtime.tgz"));
      await writeFile(
        path.join(dockerContext, "Dockerfile"),
        [
          "FROM node:20-slim",
          "COPY spell-runtime.tgz /tmp/spell-runtime.tgz",
          "RUN npm i -g /tmp/spell-runtime.tgz && rm /tmp/spell-runtime.tgz",
          ""
        ].join("\n"),
        "utf8"
      );

      await runCommand("docker", ["build", "-t", imageTag, dockerContext], repoRoot);

      // Create a minimal docker-executed spell bundle.
      const spellDir = await mkdtemp(path.join(tmpdir(), "spell-docker-bundle-"));
      const stepsDir = path.join(spellDir, "steps");
      await mkdir(stepsDir, { recursive: true });

      await writeFile(
        path.join(spellDir, "spell.yaml"),
        [
          "id: tests/docker-hello",
          "version: 1.0.0",
          "name: Docker Hello",
          "summary: minimal docker runner success case",
          "inputs_schema: ./schema.json",
          "risk: low",
          "permissions: []",
          "effects:",
          "  - type: notify",
          "    target: stdout",
          "    mutates: false",
          "billing:",
          "  enabled: false",
          "  mode: none",
          "  currency: USD",
          "  max_amount: 0",
          "runtime:",
          "  execution: docker",
          "  docker_image: " + imageTag,
          "  platforms:",
          "    - linux/amd64",
          "    - linux/arm64",
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

      await writeFile(
        path.join(spellDir, "schema.json"),
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

      const stepPath = path.join(stepsDir, "hello.js");
      await writeFile(stepPath, '#!/usr/bin/env node\nprocess.stdout.write("hello-docker\\n");\n', "utf8");
      await chmod(stepPath, 0o755);

      expect(await runCli(["node", "spell", "install", spellDir])).toBe(0);

      const result = await runCliCapture([
        "node",
        "spell",
        "cast",
        "tests/docker-hello",
        "--allow-unsigned",
        "-p",
        "name=world"
      ]);
      expect(result.code).toBe(0);

      const logsDir = path.join(tempHome, ".spell", "logs");
      const logs = (await readdir(logsDir)).sort();
      const lastLog = logs[logs.length - 1];
      const payload = JSON.parse(await readFile(path.join(logsDir, lastLog), "utf8")) as Record<string, unknown>;

      const outputs = payload.outputs as Record<string, unknown>;
      expect(String(outputs["step.hello.stdout"] ?? "")).toContain("hello-docker");
    } finally {
      await rm(packDir, { recursive: true, force: true });
      await rm(dockerContext, { recursive: true, force: true });
      await runCommand("docker", ["rmi", "-f", imageTag], repoRoot).catch(() => undefined);
    }
  });
});

async function createBareGitRepoFromSource(
  sourceDir: string,
  options: { removeSpellYaml?: boolean } = {}
): Promise<{ tempDir: string; remotePath: string; commit: string }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "spell-git-source-"));
  const workPath = path.join(tempDir, "work");
  const remotePath = path.join(tempDir, "bundle.git");

  await cp(sourceDir, workPath, { recursive: true });
  if (options.removeSpellYaml) {
    await rm(path.join(workPath, "spell.yaml"), { force: true });
  }

  await runCommand("git", ["init", "--initial-branch=main"], workPath);
  await runCommand("git", ["add", "."], workPath);
  await runCommand(
    "git",
    ["-c", "user.name=spell-tests", "-c", "user.email=spell-tests@example.test", "commit", "-m", "init"],
    workPath
  );
  await runCommand("git", ["init", "--bare", remotePath], tempDir);
  await runCommand("git", ["remote", "add", "origin", remotePath], workPath);
  await runCommand("git", ["push", "origin", "main"], workPath);
  const commit = (await runCommand("git", ["rev-parse", "HEAD"], workPath)).stdout.trim();

  return { tempDir, remotePath, commit };
}

function installedSourceMetadataPath(homeDir: string, spellId: string, version: string): string {
  return path.join(homeDir, ".spell", "spells", toIdKey(spellId), version, "source.json");
}

async function withGitUrlRewrite<T>(gitUrl: string, targetRepoPath: string, run: () => Promise<T>): Promise<T> {
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const configDir = await mkdtemp(path.join(tmpdir(), "spell-gitconfig-"));
  const configPath = path.join(configDir, "gitconfig");
  const fileUrl = pathToFileURL(targetRepoPath).toString();

  await writeFile(configPath, `[url "${fileUrl}"]\n\tinsteadOf = ${gitUrl}\n`, "utf8");
  process.env.GIT_CONFIG_GLOBAL = configPath;

  try {
    return await run();
  } finally {
    if (previousGlobalConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }

    await rm(configDir, { recursive: true, force: true });
  }
}

async function runCliCapture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown): boolean => {
    stdout += String(chunk);
    return true;
  };

  (process.stderr.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown): boolean => {
    stderr += String(chunk);
    return true;
  };

  try {
    const code = await runCli(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, { shell: false, cwd, env: process.env });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });

  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `${command} exited with code ${code}`;
    throw new Error(detail);
  }

  return { code, stdout, stderr };
}

async function createHostShellBundle(
  spellId: string,
  steps: Array<{ name: string; fileName: string; source: string }>
): Promise<string> {
  const bundleDir = await mkdtemp(path.join(tmpdir(), "spell-timeout-bundle-"));
  const stepsDir = path.join(bundleDir, "steps");
  await mkdir(stepsDir, { recursive: true });

  for (const step of steps) {
    const stepPath = path.join(stepsDir, step.fileName);
    await writeFile(stepPath, step.source, "utf8");
    await chmod(stepPath, 0o755);
  }

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

  const manifestLines: string[] = [
    `id: ${spellId}`,
    "version: 1.0.0",
    "name: Timeout Fixture",
    "summary: runtime timeout fixture",
    "inputs_schema: ./schema.json",
    "risk: low",
    "permissions: []",
    "effects:",
    "  - type: notify",
    "    target: stdout",
    "    mutates: false",
    "billing:",
    "  enabled: false",
    "  mode: none",
    "  currency: USD",
    "  max_amount: 0",
    "runtime:",
    "  execution: host",
    "  platforms:",
    `    - ${process.platform}/${process.arch}`,
    "steps:"
  ];

  for (const step of steps) {
    manifestLines.push("  - uses: shell");
    manifestLines.push(`    name: ${step.name}`);
    manifestLines.push(`    run: steps/${step.fileName}`);
  }

  manifestLines.push("checks:");
  manifestLines.push("  - type: exit_code");
  manifestLines.push("    params: {}");
  manifestLines.push("");

  await writeFile(path.join(bundleDir, "spell.yaml"), manifestLines.join("\n"), "utf8");
  return bundleDir;
}

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
