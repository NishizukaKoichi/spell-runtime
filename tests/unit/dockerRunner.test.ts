import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildDockerArgs } from "../../src/runner/dockerRunner";
import { SpellBundleManifest } from "../../src/types";

const manifest: SpellBundleManifest = {
  id: "tests/docker",
  version: "1.0.0",
  name: "Docker Test",
  summary: "docker test spell",
  inputs_schema: "./schema.json",
  risk: "low",
  permissions: [{ connector: "github", scopes: ["repo:read"] }],
  effects: [],
  billing: {
    enabled: false,
    mode: "none",
    currency: "USD",
    max_amount: 0
  },
  runtime: {
    execution: "docker",
    docker_image: "unused",
    platforms: ["linux/amd64"]
  },
  steps: [{ uses: "shell", name: "hello", run: "steps/hello.js" }],
  checks: [{ type: "exit_code", params: {} }]
};

describe("buildDockerArgs", () => {
  test("applies hardened defaults and preserves env passthrough behavior", () => {
    const args = buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, {
      CONNECTOR_GITHUB_TOKEN: "gh-token",
      SPELL_RUNTIME_STEP_TIMEOUT_MS: " 750 "
    });

    expectFlagValue(args, "--network", "none");
    expectFlagValue(args, "--cap-drop", "ALL");
    expectFlagValue(args, "--security-opt", "no-new-privileges");
    expectFlagValue(args, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m");
    expect(args).toContain("--read-only");
    expectFlagValue(args, "--user", "65532:65532");
    expectFlagValue(args, "--pids-limit", "256");

    expectFlagValue(args, "--workdir", "/spell");
    expect(args).toContain(`${path.resolve("/bundle")}:/spell:ro`);
    expect(args).toContain(`${path.resolve("/input-dir")}:/tmp/spell-input:ro`);
    expect(args).toContain("INPUT_JSON=/tmp/spell-input/input.json");

    expect(args).toContain("CONNECTOR_GITHUB_TOKEN=gh-token");
    expect(args).toContain("SPELL_RUNTIME_STEP_TIMEOUT_MS=750");
    expect(args.slice(-4)).toEqual(["spell:test", "spell-runner", "/spell/spell.yaml", "/tmp/spell-input/input.json"]);
  });

  test("supports docker hardening env overrides", () => {
    const args = buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, {
      SPELL_DOCKER_NETWORK: "bridge",
      SPELL_DOCKER_USER: "",
      SPELL_DOCKER_READ_ONLY: "0",
      SPELL_DOCKER_PIDS_LIMIT: "0",
      SPELL_DOCKER_MEMORY: "128m",
      SPELL_DOCKER_CPUS: "1.5"
    });

    expectFlagValue(args, "--network", "bridge");
    expect(args).not.toContain("--read-only");
    expect(args).not.toContain("--user");
    expect(args).not.toContain("--pids-limit");
    expectFlagValue(args, "--memory", "128m");
    expectFlagValue(args, "--cpus", "1.5");
  });

  test("validates docker hardening env values", () => {
    expect(() => buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, { SPELL_DOCKER_NETWORK: "bad" })).toThrow(
      /SPELL_DOCKER_NETWORK must be one of: none, bridge, host/
    );
    expect(() => buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, { SPELL_DOCKER_USER: "invalid user" })).toThrow(
      /SPELL_DOCKER_USER must not contain whitespace/
    );
    expect(() => buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, { SPELL_DOCKER_READ_ONLY: "2" })).toThrow(
      /SPELL_DOCKER_READ_ONLY must be '1' or '0'/
    );
    expect(() =>
      buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, { SPELL_DOCKER_PIDS_LIMIT: "-1" })
    ).toThrow(/SPELL_DOCKER_PIDS_LIMIT must be an integer >= 0/);
    expect(() => buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, { SPELL_DOCKER_MEMORY: "bad" })).toThrow(
      /SPELL_DOCKER_MEMORY must be a positive integer/
    );
    expect(() => buildDockerArgs("spell:test", "/bundle", "/input-dir", manifest, { SPELL_DOCKER_CPUS: "0" })).toThrow(
      /SPELL_DOCKER_CPUS must be a number > 0/
    );
  });
});

function expectFlagValue(args: string[], flag: string, expectedValue: string): void {
  const index = args.indexOf(flag);
  expect(index).toBeGreaterThan(-1);
  expect(args[index + 1]).toBe(expectedValue);
}
