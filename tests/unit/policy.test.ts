import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  evaluateRuntimePolicy,
  loadRuntimePolicy,
  parseRuntimePolicy,
  parseRuntimePolicyFile,
  runtimePolicyFilePath
} from "../../src/policy";

describe("parseRuntimePolicy", () => {
  test("parses valid v1 policy", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      spells: {
        allow: ["fixtures/hello-host"],
        deny: ["fixtures/blocked"]
      },
      publishers: {
        allow: ["fixtures"],
        deny: ["blocked"]
      },
      max_risk: "high",
      runtime: {
        allow_execution: ["host"]
      },
      effects: {
        allow_types: ["notify"],
        deny_types: ["delete"],
        deny_mutations: true
      },
      signature: {
        require_verified: true
      },
      rollback: {
        require_full_compensation: true
      }
    });

    expect(policy).toEqual({
      version: "v1",
      default: "allow",
      spells: {
        allow: ["fixtures/hello-host"],
        deny: ["fixtures/blocked"]
      },
      publishers: {
        allow: ["fixtures"],
        deny: ["blocked"]
      },
      max_risk: "high",
      runtime: {
        allow_execution: ["host"]
      },
      effects: {
        allow_types: ["notify"],
        deny_types: ["delete"],
        deny_mutations: true
      },
      signature: {
        require_verified: true
      },
      rollback: {
        require_full_compensation: true
      }
    });
  });

  test("rejects invalid shape", () => {
    expect(() => parseRuntimePolicy([])).toThrow("invalid policy: policy must be a JSON object");
  });

  test("rejects unknown keys", () => {
    expect(() =>
      parseRuntimePolicy({
        version: "v1",
        default: "allow",
        unexpected: true
      })
    ).toThrow("invalid policy: policy contains unknown key 'unexpected'");
  });

  test("rejects invalid rollback policy shape", () => {
    expect(() =>
      parseRuntimePolicy({
        version: "v1",
        default: "allow",
        rollback: "strict"
      })
    ).toThrow("invalid policy: rollback must be an object");
  });
});

describe("evaluateRuntimePolicy", () => {
  const context = {
    spell_id: "fixtures/hello-host",
    publisher: "fixtures",
    risk: "medium" as const,
    execution: "host" as const,
    effects: [{ type: "notify", target: "stdout", mutates: false }],
    signature_status: "verified" as const
  };

  test("allows when policy file is missing", () => {
    expect(evaluateRuntimePolicy(null, context)).toEqual({ allow: true });
  });

  test("denies publisher on deny list", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      publishers: {
        deny: ["fixtures"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "publisher 'fixtures' is denied"
    });
  });

  test("denies spell on deny list", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      spells: {
        deny: ["fixtures/hello-host"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "spell 'fixtures/hello-host' is denied"
    });
  });

  test("denies spell not listed in allow list", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      spells: {
        allow: ["fixtures/other-spell"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "spell 'fixtures/hello-host' is not allowed"
    });
  });

  test("spell deny list takes precedence over allow list", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      spells: {
        allow: ["fixtures/hello-host"],
        deny: ["fixtures/hello-host"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "spell 'fixtures/hello-host' is denied"
    });
  });

  test("deny list takes precedence over allow list", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      publishers: {
        allow: ["fixtures"],
        deny: ["fixtures"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "publisher 'fixtures' is denied"
    });
  });

  test("denies publisher not listed in allow list", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      publishers: {
        allow: ["samples"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "publisher 'fixtures' is not allowed"
    });
  });

  test("denies risk above max_risk", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      max_risk: "low"
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "risk 'medium' exceeds max_risk 'low'"
    });
  });

  test("denies runtime execution not in allow_execution", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      runtime: {
        allow_execution: ["docker"]
      }
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "runtime execution 'host' is not allowed"
    });
  });

  test("respects default deny", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "deny"
    });

    expect(evaluateRuntimePolicy(policy, context)).toEqual({
      allow: false,
      reason: "default policy is deny"
    });
  });

  test("keeps existing behavior when effects policy is omitted", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow"
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        effects: [{ type: "deploy", target: "remote", mutates: true }]
      })
    ).toEqual({ allow: true });
  });

  test("denies mutating effects when deny_mutations is true", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      effects: {
        deny_mutations: true
      }
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        effects: [{ type: "deploy", target: "remote", mutates: true }]
      })
    ).toEqual({
      allow: false,
      reason: "effect type 'deploy' mutates target 'remote' and mutations are denied"
    });
  });

  test("denies effect types in deny_types", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      effects: {
        deny_types: ["delete", "deploy"]
      }
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        effects: [{ type: "deploy", target: "remote", mutates: false }]
      })
    ).toEqual({
      allow: false,
      reason: "effect type 'deploy' is denied"
    });
  });

  test("denies effect types not included in allow_types", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      effects: {
        allow_types: ["notify"]
      }
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        effects: [{ type: "deploy", target: "remote", mutates: false }]
      })
    ).toEqual({
      allow: false,
      reason: "effect type 'deploy' is not allowed"
    });
  });

  test("deny_types takes precedence over allow_types", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      effects: {
        allow_types: ["deploy"],
        deny_types: ["deploy"]
      }
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        effects: [{ type: "deploy", target: "remote", mutates: false }]
      })
    ).toEqual({
      allow: false,
      reason: "effect type 'deploy' is denied"
    });
  });

  test("denies non-verified signature when signature.require_verified is true", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      signature: {
        require_verified: true
      }
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        signature_status: "unsigned"
      })
    ).toEqual({
      allow: false,
      reason: "signature status 'unsigned' is not allowed (verified required)"
    });
  });

  test("allows verified signature when signature.require_verified is true", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      signature: {
        require_verified: true
      }
    });

    expect(
      evaluateRuntimePolicy(policy, {
        ...context,
        signature_status: "verified"
      })
    ).toEqual({ allow: true });
  });
});

describe("loadRuntimePolicy", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-policy-home-"));
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

  test("returns null when policy.json is missing", async () => {
    await expect(loadRuntimePolicy()).resolves.toBeNull();
  });

  test("resolves ~/.spell policy path", () => {
    expect(runtimePolicyFilePath()).toBe(path.join(tempHome, ".spell", "policy.json"));
  });

  test("fails with invalid policy message for invalid JSON", async () => {
    const spellDir = path.join(tempHome, ".spell");
    await mkdir(spellDir, { recursive: true });
    await writeFile(path.join(spellDir, "policy.json"), "{", "utf8");

    await expect(loadRuntimePolicy()).rejects.toThrow("invalid policy: failed to parse JSON:");
  });
});

describe("parseRuntimePolicyFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "spell-policy-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("parses a valid policy from an explicit file path", async () => {
    const filePath = path.join(tempDir, "policy.json");
    await writeFile(filePath, `${JSON.stringify({ version: "v1", default: "allow" }, null, 2)}\n`, "utf8");

    await expect(parseRuntimePolicyFile(filePath)).resolves.toMatchObject({
      version: "v1",
      default: "allow"
    });
  });

  test("returns invalid policy when explicit file is missing", async () => {
    const filePath = path.join(tempDir, "missing-policy.json");
    await expect(parseRuntimePolicyFile(filePath)).rejects.toThrow(`invalid policy: failed to read ${filePath}:`);
  });

  test("returns invalid policy when explicit file has invalid JSON", async () => {
    const filePath = path.join(tempDir, "invalid-policy.json");
    await writeFile(filePath, "{", "utf8");

    await expect(parseRuntimePolicyFile(filePath)).rejects.toThrow("invalid policy: failed to parse JSON:");
  });
});
