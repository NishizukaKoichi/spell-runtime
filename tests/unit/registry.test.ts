import { describe, expect, test } from "vitest";
import {
  DEFAULT_REGISTRY_REQUIRED_PINS,
  enforceRegistryRequiredPins,
  parseRegistryIndexJson,
  parseRegistryInstallRef,
  readRegistryRequiredPinsPolicy,
  resolveRegistryEntry
} from "../../src/bundle/registry";

describe("install registry index", () => {
  test("parses registry index JSON and resolves exact id/version", () => {
    const index = parseRegistryIndexJson(
      JSON.stringify({
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.0.0",
            source: "https://spell.test/hello-host.git#main"
          },
          {
            id: "fixtures/hello-host",
            version: "2.0.0",
            source: "https://spell.test/hello-host.git#v2",
            commit: "AABBCCDDEEFF00112233445566778899AABBCCDD",
            digest: "sha256:AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899"
          }
        ]
      }),
      "inline"
    );

    const resolved = resolveRegistryEntry(index, "fixtures/hello-host", "2.0.0");
    expect(resolved.source).toBe("https://spell.test/hello-host.git#v2");
    expect(resolved.commit).toBe("AABBCCDDEEFF00112233445566778899AABBCCDD");
    expect(resolved.digest).toBe("sha256:AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899");
  });

  test("requires exact id/version match", () => {
    const index = parseRegistryIndexJson(
      JSON.stringify({
        version: "v1",
        spells: [{ id: "fixtures/hello-host", version: "1.0.0", source: "https://spell.test/hello-host.git#main" }]
      }),
      "inline"
    );

    expect(() => resolveRegistryEntry(index, "fixtures/hello-host", "9.9.9")).toThrow(
      /registry entry not found: fixtures\/hello-host@9.9.9/
    );
  });

  test("validates registry index schema", () => {
    expect(() => parseRegistryIndexJson(JSON.stringify({ version: "v1", spells: [{ id: "fixtures/hello-host" }] }), "inline")).toThrow(
      /registry index validation failed/
    );
  });

  test("rejects invalid commit pin in registry index", () => {
    expect(() =>
      parseRegistryIndexJson(
        JSON.stringify({
          version: "v1",
          spells: [
            {
              id: "fixtures/hello-host",
              version: "1.0.0",
              source: "https://spell.test/hello-host.git#main",
              commit: "ZZZZCCDDEEFF00112233445566778899AABBCCDD"
            }
          ]
        }),
        "inline"
      )
    ).toThrow(/registry index validation failed/);
  });

  test("rejects invalid digest pin in registry index", () => {
    expect(() =>
      parseRegistryIndexJson(
        JSON.stringify({
          version: "v1",
          spells: [
            {
              id: "fixtures/hello-host",
              version: "1.0.0",
              source: "https://spell.test/hello-host.git#main",
              digest: "sha256:ZZZZCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899"
            }
          ]
        }),
        "inline"
      )
    ).toThrow(/registry index validation failed/);
  });

  test("parses registry install source", () => {
    expect(parseRegistryInstallRef("registry:fixtures/hello-host@1.0.0")).toEqual({
      id: "fixtures/hello-host",
      version: "1.0.0"
    });
  });

  test("rejects malformed registry install source", () => {
    expect(() => parseRegistryInstallRef("registry:fixtures/hello-host")).toThrow(
      /expected registry:<id>@<version>/
    );
  });
});

describe("registry required pin policy", () => {
  const installRef = { id: "fixtures/hello-host", version: "1.0.0" } as const;
  const entryBase = {
    id: "fixtures/hello-host",
    version: "1.0.0",
    source: "https://spell.test/hello-host.git#main"
  } as const;
  const commitPin = "AABBCCDDEEFF00112233445566778899AABBCCDD";
  const digestPin = "sha256:AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899";

  test("defaults to 'both' when SPELL_REGISTRY_REQUIRED_PINS is unset or blank", () => {
    expect(readRegistryRequiredPinsPolicy({})).toBe(DEFAULT_REGISTRY_REQUIRED_PINS);
    expect(readRegistryRequiredPinsPolicy({ SPELL_REGISTRY_REQUIRED_PINS: "   " })).toBe(
      DEFAULT_REGISTRY_REQUIRED_PINS
    );
  });

  test.each([
    ["none", "none"],
    ["commit", "commit"],
    ["digest", "digest"],
    ["both", "both"],
    ["  CoMmIt  ", "commit"]
  ] as const)("reads SPELL_REGISTRY_REQUIRED_PINS=%s", (rawValue, expected) => {
    expect(readRegistryRequiredPinsPolicy({ SPELL_REGISTRY_REQUIRED_PINS: rawValue })).toBe(expected);
  });

  test("rejects invalid SPELL_REGISTRY_REQUIRED_PINS value", () => {
    expect(() => readRegistryRequiredPinsPolicy({ SPELL_REGISTRY_REQUIRED_PINS: "invalid" })).toThrow(
      /SPELL_REGISTRY_REQUIRED_PINS must be one of: none, commit, digest, both/
    );
  });

  test("mode 'none' allows entries with no pins", () => {
    expect(() => enforceRegistryRequiredPins({ ...entryBase }, installRef, "none")).not.toThrow();
  });

  test("mode 'commit' requires commit pin", () => {
    expect(() => enforceRegistryRequiredPins({ ...entryBase }, installRef, "commit")).toThrow(
      /registry entry missing required commit pin for fixtures\/hello-host@1\.0\.0/
    );
    expect(() => enforceRegistryRequiredPins({ ...entryBase, commit: commitPin }, installRef, "commit")).not.toThrow();
  });

  test("mode 'digest' requires digest pin", () => {
    expect(() => enforceRegistryRequiredPins({ ...entryBase }, installRef, "digest")).toThrow(
      /registry entry missing required digest pin for fixtures\/hello-host@1\.0\.0/
    );
    expect(() => enforceRegistryRequiredPins({ ...entryBase, digest: digestPin }, installRef, "digest")).not.toThrow();
  });

  test("mode 'both' requires both commit and digest pins", () => {
    expect(() => enforceRegistryRequiredPins({ ...entryBase }, installRef, "both")).toThrow(
      /registry entry missing required commit pin for fixtures\/hello-host@1\.0\.0/
    );
    expect(() => enforceRegistryRequiredPins({ ...entryBase, commit: commitPin }, installRef, "both")).toThrow(
      /registry entry missing required digest pin for fixtures\/hello-host@1\.0\.0/
    );
    expect(() =>
      enforceRegistryRequiredPins({ ...entryBase, commit: commitPin, digest: digestPin }, installRef, "both")
    ).not.toThrow();
  });
});
