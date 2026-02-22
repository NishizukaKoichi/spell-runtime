import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_REGISTRY_REQUIRED_PINS,
  addRegistryIndex,
  enforceRegistryRequiredPins,
  listRegistryCatalog,
  parseRegistryIndexJson,
  parseRegistryInstallRef,
  readRegistryConfig,
  resolveRegistryInstallSource,
  readRegistryRequiredPinsPolicy,
  removeRegistryIndex,
  resolveRegistryEntry,
  setDefaultRegistryIndex,
  validateRegistryIndexes
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

  test("parses registry install source with implicit latest", () => {
    expect(parseRegistryInstallRef("registry:fixtures/hello-host")).toEqual({
      id: "fixtures/hello-host",
      version: "latest"
    });
    expect(parseRegistryInstallRef("registry:fixtures/hello-host@latest")).toEqual({
      id: "fixtures/hello-host",
      version: "latest"
    });
  });

  test("resolves latest version by semver order", () => {
    const index = parseRegistryIndexJson(
      JSON.stringify({
        version: "v1",
        spells: [
          {
            id: "fixtures/hello-host",
            version: "1.2.0",
            source: "https://spell.test/hello-host.git#v1.2.0"
          },
          {
            id: "fixtures/hello-host",
            version: "1.10.0",
            source: "https://spell.test/hello-host.git#v1.10.0"
          },
          {
            id: "fixtures/hello-host",
            version: "1.3.0",
            source: "https://spell.test/hello-host.git#v1.3.0"
          }
        ]
      }),
      "inline"
    );

    const resolved = resolveRegistryEntry(index, "fixtures/hello-host", "latest");
    expect(resolved.version).toBe("1.10.0");
  });

  test("rejects malformed registry install source", () => {
    expect(() => parseRegistryInstallRef("registry:@1.0.0")).toThrow(
      /expected registry:<id> or registry:<id>@<version>/
    );
    expect(() => parseRegistryInstallRef("registry:fixtures/hello-host@")).toThrow(
      /expected registry:<id> or registry:<id>@<version>/
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

describe("registry config lifecycle", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-registry-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    nock.cleanAll();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  test("adds a named registry index and rejects duplicate names", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    const config = await addRegistryIndex("mirror", "https://registry-mirror.test/spell-index.v1.json");

    expect(config.indexes).toEqual([
      { name: "default", url: "https://registry-primary.test/spell-index.v1.json" },
      { name: "mirror", url: "https://registry-mirror.test/spell-index.v1.json" }
    ]);

    await expect(addRegistryIndex("mirror", "https://registry-another.test/spell-index.v1.json")).rejects.toThrow(
      /registry index already exists: mirror/
    );
  });

  test("rejects empty registry index names on add", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    await expect(addRegistryIndex("   ", "https://registry-mirror.test/spell-index.v1.json")).rejects.toThrow(
      /invalid registry index name/
    );
  });

  test("removes non-default indexes and keeps default", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    await addRegistryIndex("mirror", "https://registry-mirror.test/spell-index.v1.json");

    const updated = await removeRegistryIndex("mirror");
    expect(updated.indexes).toEqual([{ name: "default", url: "https://registry-primary.test/spell-index.v1.json" }]);

    const persisted = await readRegistryConfig();
    expect(persisted.indexes).toEqual([{ name: "default", url: "https://registry-primary.test/spell-index.v1.json" }]);
  });

  test("rejects removing default index", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    await addRegistryIndex("mirror", "https://registry-mirror.test/spell-index.v1.json");

    await expect(removeRegistryIndex("default")).rejects.toThrow(/cannot remove registry index 'default'/);
  });

  test("validates all indexes and returns spell counts", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    await addRegistryIndex("mirror", "https://registry-mirror.test/spell-index.v1.json");

    nock("https://registry-primary.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [{ id: "a/spell", version: "1.0.0", source: "https://spell.test/a.git#main" }]
    });

    nock("https://registry-mirror.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        { id: "a/spell", version: "1.0.0", source: "https://spell.test/a.git#main" },
        { id: "b/spell", version: "1.2.3", source: "https://spell.test/b.git#main" }
      ]
    });

    const results = await validateRegistryIndexes();
    expect(results).toEqual([
      {
        name: "default",
        url: "https://registry-primary.test/spell-index.v1.json",
        spellCount: 1
      },
      {
        name: "mirror",
        url: "https://registry-mirror.test/spell-index.v1.json",
        spellCount: 2
      }
    ]);
  });

  test("validates a selected index by name and rejects missing name", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    await addRegistryIndex("mirror", "https://registry-mirror.test/spell-index.v1.json");

    nock("https://registry-mirror.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [{ id: "b/spell", version: "1.2.3", source: "https://spell.test/b.git#main" }]
    });

    await expect(validateRegistryIndexes("missing")).rejects.toThrow(/registry index not found: missing/);

    const selected = await validateRegistryIndexes("mirror");
    expect(selected).toEqual([
      {
        name: "mirror",
        url: "https://registry-mirror.test/spell-index.v1.json",
        spellCount: 1
      }
    ]);
  });

  test("lists registry catalog with filters and latest-only option", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");

    const indexBody = {
      version: "v1" as const,
      spells: [
        { id: "fixtures/hello-host", version: "1.0.0", source: "https://spell.test/hello-host.git#v1.0.0" },
        { id: "fixtures/hello-host", version: "1.2.0", source: "https://spell.test/hello-host.git#v1.2.0" },
        { id: "fixtures/alpha", version: "0.1.0", source: "https://spell.test/alpha.git#v0.1.0" },
        { id: "samples/repo-ops", version: "1.0.0", source: "https://spell.test/repo-ops.git#v1.0.0" }
      ]
    };

    nock("https://registry-primary.test").get("/spell-index.v1.json").times(4).reply(200, indexBody);

    const all = await listRegistryCatalog(undefined);
    expect(all.name).toBe("default");
    expect(all.url).toBe("https://registry-primary.test/spell-index.v1.json");
    expect(all.spells.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "fixtures/alpha@0.1.0",
      "fixtures/hello-host@1.2.0",
      "fixtures/hello-host@1.0.0",
      "samples/repo-ops@1.0.0"
    ]);

    const latestOnly = await listRegistryCatalog(undefined, { latestOnly: true });
    expect(latestOnly.spells.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "fixtures/alpha@0.1.0",
      "fixtures/hello-host@1.2.0",
      "samples/repo-ops@1.0.0"
    ]);

    const prefixFiltered = await listRegistryCatalog(undefined, { idPrefix: "fixtures/" });
    expect(prefixFiltered.spells.map((entry) => entry.id)).toEqual([
      "fixtures/alpha",
      "fixtures/hello-host",
      "fixtures/hello-host"
    ]);

    const limited = await listRegistryCatalog(undefined, { latestOnly: true, limit: 2 });
    expect(limited.spells.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "fixtures/alpha@0.1.0",
      "fixtures/hello-host@1.2.0"
    ]);
  });

  test("rejects invalid registry catalog limit", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    nock("https://registry-primary.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [{ id: "fixtures/hello-host", version: "1.0.0", source: "https://spell.test/hello-host.git#main" }]
    });

    await expect(listRegistryCatalog(undefined, { limit: 0 })).rejects.toThrow(
      /registry catalog limit must be a positive integer/
    );
  });

  test("resolveRegistryInstallSource can target a named index", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");
    await addRegistryIndex("mirror", "https://registry-mirror.test/spell-index.v1.json");

    nock("https://registry-mirror.test").get("/spell-index.v1.json").reply(200, {
      version: "v1",
      spells: [
        {
          id: "fixtures/hello-host",
          version: "1.0.0",
          source: "https://spell.test/hello-host.git#main",
          commit: "AABBCCDDEEFF00112233445566778899AABBCCDD",
          digest: "sha256:AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899"
        }
      ]
    });

    const resolved = await resolveRegistryInstallSource("registry:fixtures/hello-host@1.0.0", "mirror");
    expect(resolved).toEqual({
      id: "fixtures/hello-host",
      version: "1.0.0",
      registryName: "mirror",
      registryUrl: "https://registry-mirror.test/spell-index.v1.json",
      source: "https://spell.test/hello-host.git#main",
      expectedCommit: "AABBCCDDEEFF00112233445566778899AABBCCDD",
      expectedDigest: "sha256:AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899"
    });
  });

  test("validation failure includes index name and reason", async () => {
    await setDefaultRegistryIndex("https://registry-primary.test/spell-index.v1.json");

    nock("https://registry-primary.test").get("/spell-index.v1.json").reply(500, {
      error: "server error"
    });

    await expect(validateRegistryIndexes()).rejects.toThrow(
      /registry validation failed for 'default': failed to fetch registry index 'https:\/\/registry-primary\.test\/spell-index\.v1\.json': HTTP 500/
    );
  });
});
