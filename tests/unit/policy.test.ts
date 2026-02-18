import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { evaluateRuntimePolicy, loadRuntimePolicy, parseRuntimePolicy } from "../../src/policy";

describe("parseRuntimePolicy", () => {
  test("parses valid v1 policy", () => {
    const policy = parseRuntimePolicy({
      version: "v1",
      default: "allow",
      publishers: {
        allow: ["fixtures"],
        deny: ["blocked"]
      },
      max_risk: "high",
      runtime: {
        allow_execution: ["host"]
      }
    });

    expect(policy).toEqual({
      version: "v1",
      default: "allow",
      publishers: {
        allow: ["fixtures"],
        deny: ["blocked"]
      },
      max_risk: "high",
      runtime: {
        allow_execution: ["host"]
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
});

describe("evaluateRuntimePolicy", () => {
  const context = {
    publisher: "fixtures",
    risk: "medium" as const,
    execution: "host" as const
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

  test("fails with invalid policy message for invalid JSON", async () => {
    const spellDir = path.join(tempHome, ".spell");
    await mkdir(spellDir, { recursive: true });
    await writeFile(path.join(spellDir, "policy.json"), "{", "utf8");

    await expect(loadRuntimePolicy()).rejects.toThrow("invalid policy: failed to parse JSON:");
  });
});
