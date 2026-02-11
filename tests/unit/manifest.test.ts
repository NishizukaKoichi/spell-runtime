import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadManifestFromDir } from "../../src/bundle/manifest";

describe("loadManifestFromDir", () => {
  test("loads valid fixture manifest", async () => {
    const fixture = path.join(process.cwd(), "fixtures/spells/hello-host");
    const { manifest } = await loadManifestFromDir(fixture);
    expect(manifest.id).toBe("fixtures/hello-host");
    expect(manifest.steps).toHaveLength(1);
  });

  test("fails on missing required field", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "spell-manifest-"));
    await mkdir(path.join(dir, "steps"));

    await writeFile(
      path.join(dir, "spell.yaml"),
      [
        "version: 1.0.0",
        "name: Broken",
        "summary: broken",
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
        "    name: noop",
        "    run: steps/noop.js",
        "checks:",
        "  - type: exit_code",
        "    params: {}"
      ].join("\n"),
      "utf8"
    );

    await writeFile(path.join(dir, "schema.json"), "{}", "utf8");
    await writeFile(path.join(dir, "steps/noop.js"), "#!/usr/bin/env node\n", "utf8");

    await expect(loadManifestFromDir(dir)).rejects.toThrow(/id/);
  });
});
