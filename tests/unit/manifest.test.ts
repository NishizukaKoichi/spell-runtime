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

  test("fails when depends_on references unknown step", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "spell-manifest-"));
    await writeMinimalBundle(
      dir,
      [
        "  - uses: shell",
        "    name: first",
        "    run: steps/first.js",
        "  - uses: shell",
        "    name: second",
        "    run: steps/second.js",
        "    depends_on:",
        "      - missing"
      ].join("\n")
    );

    await expect(loadManifestFromDir(dir)).rejects.toThrow("depends_on unknown step");
  });

  test("fails when when.output_path is missing depends_on", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "spell-manifest-"));
    await writeMinimalBundle(
      dir,
      [
        "  - uses: shell",
        "    name: first",
        "    run: steps/first.js",
        "  - uses: shell",
        "    name: second",
        "    run: steps/second.js",
        "    when:",
        "      output_path: step.first.stdout",
        "      equals: ok"
      ].join("\n")
    );

    await expect(loadManifestFromDir(dir)).rejects.toThrow("when.output_path requires depends_on 'first'");
  });
});

async function writeMinimalBundle(dir: string, stepsYamlBody: string): Promise<void> {
  await mkdir(path.join(dir, "steps"), { recursive: true });

  await writeFile(
    path.join(dir, "spell.yaml"),
    [
      "id: tests/manifest",
      "version: 1.0.0",
      "name: Manifest Test",
      "summary: manifest test",
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
      stepsYamlBody,
      "checks:",
      "  - type: exit_code",
      "    params: {}"
    ].join("\n"),
    "utf8"
  );

  await writeFile(path.join(dir, "schema.json"), "{}", "utf8");
  await writeFile(path.join(dir, "steps/first.js"), "#!/usr/bin/env node\nconsole.log('first');\n", "utf8");
  await writeFile(path.join(dir, "steps/second.js"), "#!/usr/bin/env node\nconsole.log('second');\n", "utf8");
}
