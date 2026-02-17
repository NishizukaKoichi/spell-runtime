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
  });

  afterEach(async () => {
    nock.cleanAll();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.APP_SECRET;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("install -> list -> inspect -> cast --dry-run flow", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");

    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);
    expect(await runCli(["node", "spell", "list"])).toBe(0);
    expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host"])).toBe(0);
    expect(await runCli(["node", "spell", "cast", "fixtures/hello-host", "--dry-run", "-p", "name=world"])).toBe(0);
    expect(await runCli(["node", "spell", "cast", "fixtures/hello-host", "-p", "name=world"])).toBe(0);

    const logsDir = path.join(tempHome, ".spell", "logs");
    const logs = await readdir(logsDir);
    expect(logs.length).toBeGreaterThan(0);
  });

  test("install supports git https sources", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const gitRepo = await createBareGitRepoFromSource(fixture);
    const gitUrl = "https://spell.test/hello-host.git";

    try {
      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        expect(await runCli(["node", "spell", "install", gitUrl])).toBe(0);
      });

      expect(await runCli(["node", "spell", "inspect", "fixtures/hello-host"])).toBe(0);
    } finally {
      await rm(gitRepo.tempDir, { recursive: true, force: true });
    }
  });

  test("install from git source reports clone failure", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "spell-git-missing-"));
    const gitUrl = "https://spell.test/missing.git";
    const missingRemote = path.join(tempDir, "missing.git");

    try {
      await withGitUrlRewrite(gitUrl, missingRemote, async () => {
        const result = await runCliCapture(["node", "spell", "install", gitUrl]);
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

    try {
      await withGitUrlRewrite(gitUrl, gitRepo.remotePath, async () => {
        const result = await runCliCapture(["node", "spell", "install", gitUrl]);
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
      const result = await runCliCapture(["node", "spell", "install", "https://spell.test/repo.git"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("git executable not found");
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  test("license commands add/list/remove local tokens", async () => {
    const addResult = await runCliCapture(["node", "spell", "license", "add", "dev", "token-123"]);
    expect(addResult.code).toBe(0);

    const listResult = await runCliCapture(["node", "spell", "license", "list"]);
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("name\thas_token\tupdated_at");
    expect(listResult.stdout).toContain("dev\ttrue\t");
    expect(listResult.stdout).not.toContain("token-123");

    const removeResult = await runCliCapture(["node", "spell", "license", "remove", "dev"]);
    expect(removeResult.code).toBe(0);

    const listAfterRemove = await runCliCapture(["node", "spell", "license", "list"]);
    expect(listAfterRemove.code).toBe(0);
    expect(listAfterRemove.stdout).toContain("No licenses");
  });

  test("billing guard blocks without --allow-billing", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/billing-guard"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("billing enabled requires --allow-billing");
  });

  test("billing guard blocks without license token after --allow-billing", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/billing-guard", "--allow-billing"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("billing enabled requires license token (spell license add ...)");
  });

  test("billing guard passes with --allow-billing when a license token exists", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/billing-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);
    expect(await runCli(["node", "spell", "license", "add", "dev", "token-123"])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/billing-guard", "--allow-billing"]);
    expect(result.code).toBe(0);

    const logsDir = path.join(tempHome, ".spell", "logs");
    const logs = (await readdir(logsDir)).sort();
    const lastLog = logs[logs.length - 1];
    const payload = JSON.parse(await readFile(path.join(logsDir, lastLog), "utf8")) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;

    expect(summary.license).toEqual({ licensed: true, name: "dev" });
  });

  test("risk guard blocks without --yes", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/risk-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/risk-guard"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("risk high requires --yes");
  });

  test("permissions guard blocks without connector token", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/permissions-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/permissions-guard"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing connector token CONNECTOR_GITHUB_TOKEN");
  });

  test("platform guard blocks on mismatch", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/platform-guard");
    expect(await runCli(["node", "spell", "install", fixture])).toBe(0);

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/platform-guard"]);
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

    const result = await runCliCapture(["node", "spell", "cast", "fixtures/http-step", "-p", "project=demo"]);
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

    const result = await runCliCapture(["node", "spell", "cast", "samples/repo-ops", "-p", "branch=main"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing connector token CONNECTOR_GITHUB_TOKEN");
  });

  test("real sample: publish-site requires --yes then succeeds", async () => {
    const sample = path.join(process.cwd(), "examples/spells/publish-site");
    expect(await runCli(["node", "spell", "install", sample])).toBe(0);

    const blocked = await runCliCapture(["node", "spell", "cast", "samples/publish-site", "-p", "site_name=demo"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("risk high requires --yes");

    const ok = await runCliCapture([
      "node",
      "spell",
      "cast",
      "samples/publish-site",
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

      const result = await runCliCapture(["node", "spell", "cast", "tests/docker-hello", "-p", "name=world"]);
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
): Promise<{ tempDir: string; remotePath: string }> {
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

  return { tempDir, remotePath };
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
