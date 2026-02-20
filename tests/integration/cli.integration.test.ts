import { chmod, copyFile, cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
    delete process.env.SPELL_REGISTRY_REQUIRED_PINS;
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
    delete process.env.SPELL_REGISTRY_REQUIRED_PINS;
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

  test("get-output reads one value from execution log", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const castResult = await runCliCapture([
      "node",
      "spell",
      "cast",
      "fixtures/hello-host",
      "--allow-unsigned",
      "-p",
      "name=world"
    ]);
    expect(castResult.code).toBe(0);

    const executionMatch = /execution_id:\s*(.+)/.exec(castResult.stdout);
    expect(executionMatch?.[1]).toBeTruthy();
    const executionId = String(executionMatch?.[1]).trim();

    const outputResult = await runCliCapture(["node", "spell", "get-output", executionId, "step.hello.stdout"]);
    expect(outputResult.code).toBe(0);
    expect(outputResult.stdout).toContain("hello");

    const missingOutput = await runCliCapture(["node", "spell", "get-output", executionId, "step.hello.stdout.missing"]);
    expect(missingOutput.code).toBe(1);
    expect(missingOutput.stderr).toContain("stdout reference does not support nested path");
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

  test("install supports OCI image sources", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const ociSource = "oci:ghcr.io/spell-runtime/examples/hello-host:1.0.0";

    await withFakeDockerBundle(fixture, async () => {
      expect(await runCli(["node", "spell", "install", ociSource])).toBe(0);
    });

    expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host"])).toBe(0);

    const sourceMetadata = JSON.parse(
      await readFile(installedSourceMetadataPath(tempHome, "fixtures/hello-host", "1.0.0"), "utf8")
    ) as Record<string, unknown>;
    expect(sourceMetadata).toMatchObject({
      type: "oci",
      source: ociSource,
      image: "ghcr.io/spell-runtime/examples/hello-host:1.0.0"
    });
    expect(Number.isNaN(Date.parse(String(sourceMetadata.installed_at)))).toBe(false);
  });

  test("install rejects malformed OCI source", async () => {
    const result = await runCliCapture(["node", "spell", "install", "oci:"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid oci source");
  });

  test("registry set/show and install resolves a registry source", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const expectedDigest = `sha256:${(await computeBundleDigest(fixture)).valueHex.toUpperCase()}`;
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
            commit: gitRepo.commit.toUpperCase(),
            digest: expectedDigest
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

  test("registry install supports implicit latest version resolution", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const expectedDigest = `sha256:${(await computeBundleDigest(fixture)).valueHex.toUpperCase()}`;
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;
    const indexUrl = "https://registry.test/spell-index.v1.json";

    try {
      expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

      nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "0.9.0",
            source: gitSource,
            commit: gitRepo.commit.toUpperCase(),
            digest: expectedDigest
          },
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: gitSource,
            commit: gitRepo.commit.toUpperCase(),
            digest: expectedDigest
          }
        ]
      });

      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(await runCli(["node", "spell", "install", "registry:fixtures/hello-host"])).toBe(0);
      });

      expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host", "--version", "1.0.0"])).toBe(0);
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("registry install can use named registry index via --registry", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const expectedDigest = `sha256:${(await computeBundleDigest(fixture)).valueHex.toUpperCase()}`;
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;

    try {
      expect(await runCli(["node", "spell", "registry", "set", "https://registry-primary.test/spell-index.v1.json"])).toBe(0);
      expect(await runCli(["node", "spell", "registry", "add", "mirror", "https://registry-mirror.test/spell-index.v1.json"])).toBe(0);

      nock("https://registry-primary.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: []
      });

      nock("https://registry-mirror.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: gitSource,
            commit: gitRepo.commit.toUpperCase(),
            digest: expectedDigest
          }
        ]
      });

      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(
          await runCli([
            "node",
            "spell",
            "install",
            "registry:fixtures/hello-host@1.0.0",
            "--registry",
            "mirror"
          ])
        ).toBe(0);
      });
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("registry resolve prints concrete source, pins, and resolved version", async () => {
    const indexUrl = "https://registry.test/spell-index.v1.json";
    expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        {
          id: "fixtures/hello-host",
          version: "1.0.0",
          source: "https://spell.test/hello-host.git#v1.0.0",
          commit: "AABBCCDDEEFF00112233445566778899AABBCCDD",
          digest: "sha256:AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899"
        },
        {
          id: "fixtures/hello-host",
          version: "1.2.0",
          source: "https://spell.test/hello-host.git#v1.2.0",
          commit: "BBCCDDEEFF00112233445566778899AABBCCDDEE",
          digest: "sha256:BBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899AA"
        }
      ]
    });

    const result = await runCliCapture(["node", "spell", "registry", "resolve", "registry:fixtures/hello-host"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("registry\tdefault\thttps://registry.test/spell-index.v1.json");
    expect(result.stdout).toContain("id@version\tfixtures/hello-host@1.2.0");
    expect(result.stdout).toContain("source\thttps://spell.test/hello-host.git#v1.2.0");
    expect(result.stdout).toContain("commit\tBBCCDDEEFF00112233445566778899AABBCCDDEE");
  });

  test("registry install fails when --registry name does not exist", async () => {
    expect(await runCli(["node", "spell", "registry", "set", "https://registry-primary.test/spell-index.v1.json"])).toBe(0);

    const result = await runCliCapture([
      "node",
      "spell",
      "install",
      "registry:fixtures/hello-host@1.0.0",
      "--registry",
      "missing"
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry index not found: missing");
  });

  test("local install rejects --registry option", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const result = await runCliCapture(["node", "spell", "install", fixture, "--registry", "mirror"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--registry is only supported for registry:<id> install sources");
  });

  test("registry add/remove/validate lifecycle", async () => {
    const defaultUrl = "https://registry.test/spell-index.v1.json";
    const mirrorUrl = "https://registry-mirror.test/spell-index.v1.json";

    expect(await runCli(["node", "spell", "registry", "set", defaultUrl])).toBe(0);
    expect(await runCli(["node", "spell", "registry", "add", "mirror", mirrorUrl])).toBe(0);

    const showWithMirror = await runCliCapture(["node", "spell", "registry", "show"]);
    expect(showWithMirror.code).toBe(0);
    expect(showWithMirror.stdout).toContain(`default\t${defaultUrl}`);
    expect(showWithMirror.stdout).toContain(`mirror\t${mirrorUrl}`);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [{ id: "fixtures/hello-host", version: "1.0.0", source: "https://spell.test/hello-host.git#main" }]
    });

    nock("https://registry-mirror.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        { id: "fixtures/hello-host", version: "1.0.0", source: "https://spell.test/hello-host.git#main" },
        { id: "fixtures/hello-host", version: "2.0.0", source: "https://spell.test/hello-host.git#v2" }
      ]
    });

    const validateAll = await runCliCapture(["node", "spell", "registry", "validate"]);
    expect(validateAll.code).toBe(0);
    expect(validateAll.stdout).toContain(`default\t${defaultUrl}\t1`);
    expect(validateAll.stdout).toContain(`mirror\t${mirrorUrl}\t2`);

    nock("https://registry-mirror.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [{ id: "fixtures/hello-host", version: "1.0.0", source: "https://spell.test/hello-host.git#main" }]
    });

    const validateMirrorOnly = await runCliCapture(["node", "spell", "registry", "validate", "--name", "mirror"]);
    expect(validateMirrorOnly.code).toBe(0);
    expect(validateMirrorOnly.stdout).toContain(`mirror\t${mirrorUrl}\t1`);
    expect(validateMirrorOnly.stdout).not.toContain(`default\t${defaultUrl}`);

    const removeMirror = await runCliCapture(["node", "spell", "registry", "remove", "mirror"]);
    expect(removeMirror.code).toBe(0);
    expect(removeMirror.stdout).toContain("removed\tmirror");

    const showAfterRemove = await runCliCapture(["node", "spell", "registry", "show"]);
    expect(showAfterRemove.code).toBe(0);
    expect(showAfterRemove.stdout).toContain(`default\t${defaultUrl}`);
    expect(showAfterRemove.stdout).not.toContain("mirror\t");
  });

  test("registry add/remove/validate reports failure cases", async () => {
    const defaultUrl = "https://registry.test/spell-index.v1.json";
    expect(await runCli(["node", "spell", "registry", "set", defaultUrl])).toBe(0);

    expect(await runCli(["node", "spell", "registry", "add", "mirror", "https://registry-mirror.test/spell-index.v1.json"])).toBe(
      0
    );

    const duplicateAdd = await runCliCapture([
      "node",
      "spell",
      "registry",
      "add",
      "mirror",
      "https://registry-another.test/spell-index.v1.json"
    ]);
    expect(duplicateAdd.code).toBe(1);
    expect(duplicateAdd.stderr).toContain("registry index already exists: mirror");

    const emptyName = await runCliCapture([
      "node",
      "spell",
      "registry",
      "add",
      "   ",
      "https://registry-another.test/spell-index.v1.json"
    ]);
    expect(emptyName.code).toBe(1);
    expect(emptyName.stderr).toContain("invalid registry index name");

    const removeDefault = await runCliCapture(["node", "spell", "registry", "remove", "default"]);
    expect(removeDefault.code).toBe(1);
    expect(removeDefault.stderr).toContain("cannot remove registry index 'default'");

    const missingName = await runCliCapture(["node", "spell", "registry", "validate", "--name", "missing"]);
    expect(missingName.code).toBe(1);
    expect(missingName.stderr).toContain("registry index not found: missing");
  });

  test("registry validate returns non-zero with fetch failure reason", async () => {
    const defaultUrl = "https://registry.test/spell-index.v1.json";
    expect(await runCli(["node", "spell", "registry", "set", defaultUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(500, { error: "server error" });

    const result = await runCliCapture(["node", "spell", "registry", "validate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "registry validation failed for 'default': failed to fetch registry index 'https://registry.test/spell-index.v1.json': HTTP 500"
    );
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

  test("registry install defaults to requiring both pins", async () => {
    const indexUrl = "https://registry.test/spell-index.v1.json";
    delete process.env.SPELL_REGISTRY_REQUIRED_PINS;
    expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        {
          id: "fixtures/hello-host",
          version: "1.0.0",
          source: "https://spell.test/hello-host.git#main",
          commit: "0000000000000000000000000000000000000000"
        }
      ]
    });

    const result = await runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry entry missing required digest pin for fixtures/hello-host@1.0.0");
  });

  test("registry install requires commit pin when SPELL_REGISTRY_REQUIRED_PINS=commit", async () => {
    const indexUrl = "https://registry.test/spell-index.v1.json";
    process.env.SPELL_REGISTRY_REQUIRED_PINS = "commit";
    expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        {
          id: "fixtures/hello-host",
          version: "1.0.0",
          source: "https://spell.test/hello-host.git#main",
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        }
      ]
    });

    const result = await runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry entry missing required commit pin for fixtures/hello-host@1.0.0");
  });

  test("registry install requires digest pin when SPELL_REGISTRY_REQUIRED_PINS=digest", async () => {
    const indexUrl = "https://registry.test/spell-index.v1.json";
    process.env.SPELL_REGISTRY_REQUIRED_PINS = "digest";
    expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        {
          id: "fixtures/hello-host",
          version: "1.0.0",
          source: "https://spell.test/hello-host.git#main",
          commit: "0000000000000000000000000000000000000000"
        }
      ]
    });

    const result = await runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry entry missing required digest pin for fixtures/hello-host@1.0.0");
  });

  test("registry install allows missing pins when SPELL_REGISTRY_REQUIRED_PINS=none", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;
    const indexUrl = "https://registry.test/spell-index.v1.json";
    process.env.SPELL_REGISTRY_REQUIRED_PINS = "none";

    try {
      expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

      nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: gitSource
          }
        ]
      });

      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(await runCli(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"])).toBe(0);
      });
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("registry install requires both pins when SPELL_REGISTRY_REQUIRED_PINS=both", async () => {
    const indexUrl = "https://registry.test/spell-index.v1.json";
    process.env.SPELL_REGISTRY_REQUIRED_PINS = "both";
    expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

    nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        {
          id: "fixtures/hello-host",
          version: "1.0.0",
          source: "https://spell.test/hello-host.git#main",
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        }
      ]
    });

    const result = await runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry entry missing required commit pin for fixtures/hello-host@1.0.0");
  });

  test("non-registry local installs ignore SPELL_REGISTRY_REQUIRED_PINS", async () => {
    process.env.SPELL_REGISTRY_REQUIRED_PINS = "invalid";
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);
  });

  test("non-registry git installs ignore SPELL_REGISTRY_REQUIRED_PINS", async () => {
    process.env.SPELL_REGISTRY_REQUIRED_PINS = "invalid";
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;

    try {
      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(await runCli(["node", "spell", "install", gitSource])).toBe(0);
      });
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
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
            commit: expectedCommit,
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
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

  test("registry install fails when digest pin does not match canonical bundle digest", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const actualDigest = `sha256:${(await computeBundleDigest(fixture)).valueHex}`;
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";
    const gitSource = `${gitUrl}#main`;
    const indexUrl = "https://registry.test/spell-index.v1.json";
    const expectedDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    try {
      expect(await runCli(["node", "spell", "registry", "set", indexUrl])).toBe(0);

      nock("https://registry.test").get("/spell-index.v1.json").reply(200, {
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: gitSource,
            commit: gitRepo.commit,
            digest: expectedDigest
          }
        ]
      });

      const result = await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () =>
        runCliCapture(["node", "spell", "install", "registry:fixtures/hello-host@1.0.0"])
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`registry digest mismatch: expected ${expectedDigest}, got ${actualDigest}`);
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

  test("trust commands list active/revoked keys and support key revoke/restore", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;

    expect(await runCli(["node", "spell", "trust", "add", "trust-lifecycle", publicKeyDer.toString("base64url"), "--key-id", "k1"])).toBe(0);

    const listInitial = await runCliCapture(["node", "spell", "trust", "list"]);
    expect(listInitial.code).toBe(0);
    expect(listInitial.stdout).toContain("publisher\tkey_id\tstatus");
    expect(listInitial.stdout).toContain("trust-lifecycle\tk1\tactive");

    const inspectInitial = await runCliCapture(["node", "spell", "trust", "inspect", "trust-lifecycle"]);
    expect(inspectInitial.code).toBe(0);
    expect(inspectInitial.stdout).toContain("key_id\tstatus\talgorithm\tfingerprint");
    expect(inspectInitial.stdout).toMatch(/k1\tactive\ted25519\t[0-9a-f]{12}\.\.\.[0-9a-f]{8}/);

    const revoke = await runCliCapture([
      "node",
      "spell",
      "trust",
      "revoke-key",
      "trust-lifecycle",
      "--key-id",
      "k1",
      "--reason",
      "incident"
    ]);
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain("revoked publisher=trust-lifecycle key_id=k1");

    const listRevoked = await runCliCapture(["node", "spell", "trust", "list"]);
    expect(listRevoked.code).toBe(0);
    expect(listRevoked.stdout).toContain("trust-lifecycle\tk1\trevoked");

    const inspectRevoked = await runCliCapture(["node", "spell", "trust", "inspect", "trust-lifecycle"]);
    expect(inspectRevoked.code).toBe(0);
    expect(inspectRevoked.stdout).toMatch(/k1\trevoked\ted25519\t[0-9a-f]{12}\.\.\.[0-9a-f]{8}/);

    const restore = await runCliCapture([
      "node",
      "spell",
      "trust",
      "restore-key",
      "trust-lifecycle",
      "--key-id",
      "k1"
    ]);
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain("restored publisher=trust-lifecycle key_id=k1");

    const listRestored = await runCliCapture(["node", "spell", "trust", "list"]);
    expect(listRestored.code).toBe(0);
    expect(listRestored.stdout).toContain("trust-lifecycle\tk1\tactive");
  });

  test("trust remove-key removes one key and deletes publisher trust on last key", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const encoded = publicKeyDer.toString("base64url");

    expect(await runCli(["node", "spell", "trust", "add", "trust-remove", encoded, "--key-id", "k1"])).toBe(0);
    expect(await runCli(["node", "spell", "trust", "add", "trust-remove", encoded, "--key-id", "k2"])).toBe(0);

    const removeK1 = await runCliCapture(["node", "spell", "trust", "remove-key", "trust-remove", "--key-id", "k1"]);
    expect(removeK1.code).toBe(0);
    expect(removeK1.stdout).toContain("removed publisher=trust-remove key_id=k1");

    const inspectAfterK1 = await runCliCapture(["node", "spell", "trust", "inspect", "trust-remove"]);
    expect(inspectAfterK1.code).toBe(0);
    expect(inspectAfterK1.stdout).not.toContain("k1\t");
    expect(inspectAfterK1.stdout).toContain("k2\tactive\ted25519\t");

    const missingKey = await runCliCapture(["node", "spell", "trust", "remove-key", "trust-remove", "--key-id", "missing"]);
    expect(missingKey.code).toBe(1);
    expect(missingKey.stderr).toContain("trusted key not found: publisher=trust-remove key_id=missing");

    const removeK2 = await runCliCapture(["node", "spell", "trust", "remove-key", "trust-remove", "--key-id", "k2"]);
    expect(removeK2.code).toBe(0);
    expect(removeK2.stdout).toContain("removed publisher=trust-remove key_id=k2");

    const inspectMissingPublisher = await runCliCapture(["node", "spell", "trust", "inspect", "trust-remove"]);
    expect(inspectMissingPublisher.code).toBe(1);
    expect(inspectMissingPublisher.stderr).toContain("trusted publisher not found: trust-remove");

    const missingPublisher = await runCliCapture(["node", "spell", "trust", "remove-key", "trust-remove", "--key-id", "k2"]);
    expect(missingPublisher.code).toBe(1);
    expect(missingPublisher.stderr).toContain("trusted publisher not found: trust-remove");
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

  test("policy show reports clear message when ~/.spell/policy.json is missing", async () => {
    const result = await runCliCapture(["node", "spell", "policy", "show"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`No runtime policy configured at ${path.join(tempHome, ".spell", "policy.json")}`);
  });

  test("policy show prints current policy JSON when file exists", async () => {
    const spellDir = path.join(tempHome, ".spell");
    const policyPath = path.join(spellDir, "policy.json");
    await mkdir(spellDir, { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({ version: "v1", default: "allow" }, null, 2)}\n`, "utf8");

    const result = await runCliCapture(["node", "spell", "policy", "show"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify({ version: "v1", default: "allow" }, null, 2)}\n`);
  });

  test("policy validate reports policy valid for valid file", async () => {
    const candidatePath = path.join(tempHome, "candidate-policy.json");
    await writeFile(candidatePath, `${JSON.stringify({ version: "v1", default: "allow" }, null, 2)}\n`, "utf8");

    const result = await runCliCapture(["node", "spell", "policy", "validate", "--file", candidatePath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("policy valid");
  });

  test("policy validate returns invalid policy errors", async () => {
    const candidatePath = path.join(tempHome, "candidate-invalid-policy.json");
    await writeFile(candidatePath, `${JSON.stringify({ version: "v1", default: "block" }, null, 2)}\n`, "utf8");

    const result = await runCliCapture(["node", "spell", "policy", "validate", "--file", candidatePath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid policy: default must be 'allow' or 'deny', got 'block'");
  });

  test("policy set validates then writes ~/.spell/policy.json", async () => {
    const candidatePath = path.join(tempHome, "candidate-set-policy.json");
    await writeFile(candidatePath, `${JSON.stringify({ version: "v1", default: "allow" }, null, 2)}\n`, "utf8");

    const result = await runCliCapture(["node", "spell", "policy", "set", "--file", candidatePath]);
    const destinationPath = path.join(tempHome, ".spell", "policy.json");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`policy written: ${destinationPath}`);

    const stored = await readFile(destinationPath, "utf8");
    expect(stored).toBe(`${JSON.stringify({ version: "v1", default: "allow" }, null, 2)}\n`);
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

  test("policy effects deny_mutations blocks cast", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/permissions-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const spellDir = path.join(tempHome, ".spell");
    await mkdir(spellDir, { recursive: true });
    await writeFile(
      path.join(spellDir, "policy.json"),
      `${JSON.stringify({ version: "v1", default: "allow", effects: { deny_mutations: true } }, null, 2)}\n`,
      "utf8"
    );

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/permissions-guard", "--allow-unsigned"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("policy denied: effect type 'deploy' mutates target 'github' and mutations are denied");
  });

  test("policy signature.require_verified blocks --allow-unsigned path", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const spellDir = path.join(tempHome, ".spell");
    await mkdir(spellDir, { recursive: true });
    await writeFile(
      path.join(spellDir, "policy.json"),
      `${JSON.stringify({ version: "v1", default: "allow", signature: { require_verified: true } }, null, 2)}\n`,
      "utf8"
    );

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/hello-host", "--allow-unsigned", "-p", "name=world"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("policy denied: signature status 'unsigned' is not allowed (verified required)");
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

  test("verify command reports unsigned status and exits non-zero for unsigned bundle", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "verify", "fixtures/hello-host"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("status: unsigned");
    expect(result.stderr).toContain("signature unsigned:");
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

  const dockerTest = process.env.SPELL_DOCKER_TESTS === "1" && isDockerDaemonAvailable() ? test : test.skip;
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

  dockerTest("oci install succeeds (real docker image source)", async () => {
    const repoRoot = process.cwd();
    const fixture = path.join(repoRoot, "fixtures/spells/hello-host");
    const dockerContext = await mkdtemp(path.join(tmpdir(), "spell-oci-context-"));
    const imageTag = `spell-runtime-test-oci:${Date.now()}`;

    try {
      await cp(fixture, path.join(dockerContext, "spell"), { recursive: true });
      await writeFile(
        path.join(dockerContext, "Dockerfile"),
        [
          "FROM node:20-slim",
          "COPY spell/ /spell/",
          ""
        ].join("\n"),
        "utf8"
      );

      await runCommand("docker", ["build", "-t", imageTag, dockerContext], repoRoot);

      expect(await runCli(["node", "spell", "install", `oci:${imageTag}`])).toBe(0);
      expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host"])).toBe(0);

      const sourceMetadata = JSON.parse(
        await readFile(installedSourceMetadataPath(tempHome, "fixtures/hello-host", "1.0.0"), "utf8")
      ) as Record<string, unknown>;
      expect(sourceMetadata).toMatchObject({
        type: "oci",
        source: `oci:${imageTag}`,
        image: imageTag
      });
      expect(Number.isNaN(Date.parse(String(sourceMetadata.installed_at)))).toBe(false);
    } finally {
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

async function withFakeDockerBundle<T>(bundleDir: string, run: () => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(path.join(tmpdir(), "spell-fake-docker-"));
  const dockerPath = path.join(binDir, "docker");
  const previousPath = process.env.PATH;
  const previousBundle = process.env.SPELL_TEST_FAKE_DOCKER_BUNDLE_DIR;
  const fakeContainerId = "spell-fake-container";

  const script = `#!/usr/bin/env node
const { cp, mkdir, readdir } = require("node:fs/promises");
const path = require("node:path");

async function copyBundleInto(targetDir, bundleDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(bundleDir, { withFileTypes: true });
  for (const entry of entries) {
    await cp(path.join(bundleDir, entry.name), path.join(targetDir, entry.name), { recursive: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const bundleDir = process.env.SPELL_TEST_FAKE_DOCKER_BUNDLE_DIR;
  if (!bundleDir) {
    process.stderr.write("missing SPELL_TEST_FAKE_DOCKER_BUNDLE_DIR\\n");
    process.exit(1);
    return;
  }

  if (command === "create") {
    if (!args[1]) {
      process.stderr.write("missing image\\n");
      process.exit(1);
      return;
    }
    process.stdout.write("${fakeContainerId}\\n");
    return;
  }

  if (command === "cp") {
    const source = args[1];
    const target = args[2];
    if (source !== "${fakeContainerId}:/spell/." || !target) {
      process.stderr.write("unsupported cp args\\n");
      process.exit(1);
      return;
    }
    await copyBundleInto(target, bundleDir);
    return;
  }

  if (command === "rm") {
    return;
  }

  process.stderr.write("unsupported fake docker command\\n");
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(String(error?.message ?? error) + "\\n");
  process.exit(1);
});
`;

  await writeFile(dockerPath, script, "utf8");
  await chmod(dockerPath, 0o755);

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.SPELL_TEST_FAKE_DOCKER_BUNDLE_DIR = bundleDir;

  try {
    return await run();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    if (previousBundle === undefined) {
      delete process.env.SPELL_TEST_FAKE_DOCKER_BUNDLE_DIR;
    } else {
      process.env.SPELL_TEST_FAKE_DOCKER_BUNDLE_DIR = previousBundle;
    }

    await rm(binDir, { recursive: true, force: true });
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

function isDockerDaemonAvailable(): boolean {
  try {
    const probe = spawnSync("docker", ["info"], {
      shell: false,
      stdio: "ignore",
      env: process.env
    });
    return probe.status === 0;
  } catch {
    return false;
  }
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
