import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadButtonRegistryFromFile, resolveButtonEntry } from "../../src/contract/buttonRegistry";

describe("button registry contract", () => {
  test("loads sample registry and resolves by button_id", async () => {
    const registryPath = path.join(process.cwd(), "examples/button-registry.v1.json");
    const registry = await loadButtonRegistryFromFile(registryPath);

    const entry = resolveButtonEntry(registry, "call_webhook_demo");
    expect(entry.spell_id).toBe("samples/call-webhook");
    expect(entry.required_confirmations).toEqual({ risk: false, billing: false });
    expect(entry.require_signature).toBe(false);
  });

  test("rejects duplicate button_id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "button-registry-"));
    const file = path.join(dir, "registry.json");

    await writeFile(
      file,
      JSON.stringify(
        {
          version: "v1",
          buttons: [
            {
              button_id: "same",
              spell_id: "samples/call-webhook",
              version: "1.0.0",
              defaults: {},
              required_confirmations: { risk: false, billing: false },
              allowed_roles: ["admin"]
            },
            {
              button_id: "same",
              spell_id: "samples/repo-ops",
              version: "1.0.0",
              defaults: {},
              required_confirmations: { risk: false, billing: false },
              allowed_roles: ["admin"]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(loadButtonRegistryFromFile(file)).rejects.toThrow(/duplicate button_id/);
  });

  test("rejects schema mismatch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "button-registry-"));
    const file = path.join(dir, "invalid.json");

    await writeFile(
      file,
      JSON.stringify(
        {
          version: "v1",
          buttons: [
            {
              button_id: "missing_fields"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(loadButtonRegistryFromFile(file)).rejects.toThrow(/button registry validation failed/);
  });

  test("accepts optional allowed_tenants when valid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "button-registry-"));
    const file = path.join(dir, "allowed-tenants-valid.json");

    await writeFile(
      file,
      JSON.stringify(
        {
          version: "v1",
          buttons: [
            {
              button_id: "tenant_restricted",
              spell_id: "samples/call-webhook",
              version: "1.0.0",
              defaults: {},
              required_confirmations: { risk: false, billing: false },
              allowed_roles: ["admin"],
              allowed_tenants: ["team_a", "team_b"]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const registry = await loadButtonRegistryFromFile(file);
    expect(registry.buttons[0]?.allowed_tenants).toEqual(["team_a", "team_b"]);
  });

  test("rejects invalid allowed_tenants", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "button-registry-"));
    const emptyListFile = path.join(dir, "allowed-tenants-empty.json");
    const emptyTenantFile = path.join(dir, "allowed-tenants-empty-item.json");

    await writeFile(
      emptyListFile,
      JSON.stringify(
        {
          version: "v1",
          buttons: [
            {
              button_id: "tenant_restricted",
              spell_id: "samples/call-webhook",
              version: "1.0.0",
              defaults: {},
              required_confirmations: { risk: false, billing: false },
              allowed_roles: ["admin"],
              allowed_tenants: []
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await writeFile(
      emptyTenantFile,
      JSON.stringify(
        {
          version: "v1",
          buttons: [
            {
              button_id: "tenant_restricted",
              spell_id: "samples/call-webhook",
              version: "1.0.0",
              defaults: {},
              required_confirmations: { risk: false, billing: false },
              allowed_roles: ["admin"],
              allowed_tenants: [""]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(loadButtonRegistryFromFile(emptyListFile)).rejects.toThrow(/button registry validation failed/);
    await expect(loadButtonRegistryFromFile(emptyTenantFile)).rejects.toThrow(/button registry validation failed/);
  });
});
