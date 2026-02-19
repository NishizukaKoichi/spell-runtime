import { describe, expect, test } from "vitest";
import {
  parseRegistryIndexJson,
  parseRegistryInstallRef,
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
