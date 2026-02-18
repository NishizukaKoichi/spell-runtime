import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../../src/cli/index";
import { startExecutionApiServer } from "../../src/api/server";

describe("execution api integration", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), "spell-api-home-"));
    process.env.HOME = tempHome;
    delete process.env.CONNECTOR_GITHUB_TOKEN;

    expect(await runCli(["node", "spell", "install", path.join(process.cwd(), "examples/spells/call-webhook")])).toBe(0);
    expect(await runCli(["node", "spell", "install", path.join(process.cwd(), "examples/spells/repo-ops")])).toBe(0);
    expect(await runCli(["node", "spell", "install", path.join(process.cwd(), "examples/spells/publish-site")])).toBe(0);
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  test("POST creates async execution and GET returns sanitized receipt", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "publish_site_high_risk",
          actor_role: "admin",
          input: {
            site_name: "api-demo"
          },
          confirmation: {
            risk_acknowledged: true,
            billing_acknowledged: false
          }
        })
      });

      expect(created.status).toBe(202);
      const payload = (await created.json()) as Record<string, unknown>;
      const executionId = String(payload.execution_id);

      const done = await waitForExecution(server.port, executionId);
      expect(done.execution.status).toBe("succeeded");
      expect(done.receipt).toBeTruthy();
      expect((done.receipt as Record<string, unknown>).tenant_id).toBe("default");
      expect(JSON.stringify(done.receipt)).not.toContain("stdout_head");
      expect(JSON.stringify(done.receipt)).not.toContain("stderr_head");

      const statuses = await waitForTenantAuditStatuses(tempHome, executionId, new Set(["queued", "running", "succeeded"]));
      expect(statuses).toContain("queued");
      expect(statuses).toContain("running");
      expect(statuses).toContain("succeeded");
    } finally {
      await server.close();
    }
  });

  test("serves buttons endpoint and UI assets", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const buttonsResponse = await fetch(`http://127.0.0.1:${server.port}/api/buttons`);
      expect(buttonsResponse.status).toBe(200);
      const buttonsPayload = (await buttonsResponse.json()) as {
        buttons: Array<Record<string, unknown>>;
      };
      expect(buttonsPayload.buttons.length).toBeGreaterThan(0);
      expect(buttonsPayload.buttons[0]?.button_id).toBeTruthy();

      const page = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Spell Receipts UI");
      expect(html).toContain("guardHint");
      expect(html).toContain("executionStatus");
      expect(html).toContain("apiToken");

      const js = await fetch(`http://127.0.0.1:${server.port}/ui/app.js`);
      expect(js.status).toBe(200);
      const script = await js.text();
      expect(script).toContain("updateGuardHints");
      expect(script).toContain("actor role not allowed for selected button");
      expect(script).toContain("makeApiHeaders");
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions returns execution list", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin"
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const executionId = String(createdPayload.execution_id);

      const listed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`);
      expect(listed.status).toBe(200);
      const payload = (await listed.json()) as {
        executions: Array<{ execution_id: string }>;
      };
      expect(payload.executions.some((execution) => execution.execution_id === executionId)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions supports status/button_id/tenant_id/limit filters", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const succeededExecutionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      await waitForExecution(server.port, succeededExecutionId);

      const failedExecutionId = await createExecution(server.port, {
        button_id: "repo_ops_guarded",
        actor_role: "admin"
      });
      await waitForExecution(server.port, failedExecutionId);

      const successOnly = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions?status=succeeded&button_id=publish_site_high_risk&tenant_id=default&limit=1`
      );
      expect(successOnly.status).toBe(200);
      const successPayload = (await successOnly.json()) as {
        executions: Array<{ execution_id: string; status: string }>;
      };
      expect(successPayload.executions.length).toBe(1);
      expect(successPayload.executions[0]?.execution_id).toBe(succeededExecutionId);
      expect(successPayload.executions[0]?.status).toBe("succeeded");

      const failedOnly = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?status=failed`);
      expect(failedOnly.status).toBe(200);
      const failedPayload = (await failedOnly.json()) as {
        executions: Array<{ execution_id: string; status: string }>;
      };
      expect(failedPayload.executions.some((execution) => execution.execution_id === failedExecutionId)).toBe(true);
      expect(failedPayload.executions.every((execution) => execution.status === "failed")).toBe(true);

      const none = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?tenant_id=team_b`);
      expect(none.status).toBe(200);
      const nonePayload = (await none.json()) as {
        executions: Array<{ execution_id: string; tenant_id: string }>;
      };
      expect(nonePayload.executions).toHaveLength(0);

      const invalid = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?status=unknown`);
      expect(invalid.status).toBe(400);
      const invalidPayload = (await invalid.json()) as Record<string, unknown>;
      expect(invalidPayload.error_code).toBe("INVALID_QUERY");
    } finally {
      await server.close();
    }
  });

  test("persists execution list index and restores after server restart", async () => {
    const registryPath = path.join(process.cwd(), "examples/button-registry.v1.json");

    const server1 = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    let executionId = "";
    try {
      executionId = await createExecution(server1.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      await waitForExecution(server1.port, executionId);
    } finally {
      await server1.close();
    }

    const indexPath = path.join(tempHome, ".spell", "logs", "index.json");
    const indexRaw = await readFile(indexPath, "utf8");
    expect(indexRaw).toContain(executionId);

    const server2 = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    try {
      const listed = await fetch(`http://127.0.0.1:${server2.port}/api/spell-executions?status=succeeded`);
      expect(listed.status).toBe(200);
      const payload = (await listed.json()) as {
        executions: Array<{ execution_id: string }>;
      };
      expect(payload.executions.some((execution) => execution.execution_id === executionId)).toBe(true);

      const detail = await fetch(`http://127.0.0.1:${server2.port}/api/spell-executions/${executionId}`);
      expect(detail.status).toBe(200);
    } finally {
      await server2.close();
    }
  });

  test("enforces API auth when auth tokens are configured", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authTokens: ["top-secret-token"]
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/buttons`);
      expect(unauthorized.status).toBe(401);
      const unauthorizedPayload = (await unauthorized.json()) as Record<string, unknown>;
      expect(unauthorizedPayload.error_code).toBe("AUTH_REQUIRED");

      const invalid = await fetch(`http://127.0.0.1:${server.port}/api/buttons`, {
        headers: { authorization: "Bearer wrong-token" }
      });
      expect(invalid.status).toBe(401);
      const invalidPayload = (await invalid.json()) as Record<string, unknown>;
      expect(invalidPayload.error_code).toBe("AUTH_INVALID");

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/buttons`, {
        headers: { authorization: "Bearer top-secret-token" }
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test("enforces role-based auth keys and derives actor_role from token", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["operator=op-token", "admin=admin-token"]
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/buttons`);
      expect(unauthorized.status).toBe(401);

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "publish_site_high_risk",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("ROLE_NOT_ALLOWED");

      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const executionId = String(createdPayload.execution_id);
      expect(createdPayload.tenant_id).toBe("default");

      const done = await waitForExecution(server.port, executionId, "op-token");
      expect(done.execution.actor_role).toBe("operator");
      expect(done.execution.tenant_id).toBe("default");
    } finally {
      await server.close();
    }
  });

  test("enforces tenant scoping for auth keys and ignores client tenant fields", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:operator=team-b-op-token", "team_a:admin=team-a-admin-token"]
    });

    try {
      const createdA = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true,
          tenant: "team_b",
          tenant_id: "team_b"
        })
      });
      expect(createdA.status).toBe(202);
      const createdAPayload = (await createdA.json()) as Record<string, unknown>;
      expect(createdAPayload.tenant_id).toBe("team_a");
      const executionA = String(createdAPayload.execution_id);
      const doneA = await waitForExecution(server.port, executionA, "team-a-op-token");
      expect(doneA.execution.tenant_id).toBe("team_a");

      const createdB = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(createdB.status).toBe(202);
      const createdBPayload = (await createdB.json()) as Record<string, unknown>;
      expect(createdBPayload.tenant_id).toBe("team_b");
      const executionB = String(createdBPayload.execution_id);
      const doneB = await waitForExecution(server.port, executionB, "team-b-op-token");
      expect(doneB.execution.tenant_id).toBe("team_b");

      const ownTenant = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(ownTenant.status).toBe(200);
      const ownTenantPayload = (await ownTenant.json()) as {
        filters: { tenant_id: string | null };
        executions: Array<{ execution_id: string; tenant_id: string }>;
      };
      expect(ownTenantPayload.filters.tenant_id).toBe("team_a");
      expect(ownTenantPayload.executions.some((execution) => execution.execution_id === executionA)).toBe(true);
      expect(ownTenantPayload.executions.some((execution) => execution.execution_id === executionB)).toBe(false);
      expect(ownTenantPayload.executions.every((execution) => execution.tenant_id === "team_a")).toBe(true);

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?tenant_id=team_b`, {
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("TENANT_FORBIDDEN");

      const crossTenant = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?tenant_id=team_b`, {
        headers: { authorization: "Bearer team-a-admin-token" }
      });
      expect(crossTenant.status).toBe(200);
      const crossTenantPayload = (await crossTenant.json()) as {
        filters: { tenant_id: string | null };
        executions: Array<{ execution_id: string; tenant_id: string }>;
      };
      expect(crossTenantPayload.filters.tenant_id).toBe("team_b");
      expect(crossTenantPayload.executions.some((execution) => execution.execution_id === executionB)).toBe(true);
      expect(crossTenantPayload.executions.every((execution) => execution.tenant_id === "team_b")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("applies log retention max-files policy and prunes execution index", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      logRetentionDays: 0,
      logMaxFiles: 1
    });

    try {
      const firstExecutionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      await waitForExecution(server.port, firstExecutionId);

      const secondExecutionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      await waitForExecution(server.port, secondExecutionId);

      const files = await readdir(path.join(tempHome, ".spell", "logs"));
      const logFiles = files.filter((name) => name.endsWith(".json") && name !== "index.json");
      expect(logFiles.length).toBe(1);

      const listed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`);
      expect(listed.status).toBe(200);
      const payload = (await listed.json()) as {
        executions: Array<{ execution_id: string }>;
      };
      expect(payload.executions.length).toBe(1);
      expect(payload.executions[0]?.execution_id).toBe(secondExecutionId);
    } finally {
      await server.close();
    }
  });

  test("rejects role not in allowed_roles", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "repo_ops_guarded",
          actor_role: "viewer"
        })
      });

      expect(response.status).toBe(403);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.error_code).toBe("ROLE_NOT_ALLOWED");
    } finally {
      await server.close();
    }
  });

  test("requires risk confirmation for high-risk button", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "publish_site_high_risk",
          actor_role: "admin"
        })
      });

      expect(response.status).toBe(400);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.error_code).toBe("RISK_CONFIRMATION_REQUIRED");
    } finally {
      await server.close();
    }
  });

  test("enforces signature policy when button requires signature", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "spell-api-registry-"));
    const registryPath = path.join(tempDir, "button-registry.v1.json");

    const baseRegistryRaw = await readFile(path.join(process.cwd(), "examples/button-registry.v1.json"), "utf8");
    const baseRegistry = JSON.parse(baseRegistryRaw) as {
      version: "v1";
      buttons: Array<Record<string, unknown>>;
    };

    const mutated = {
      version: baseRegistry.version,
      buttons: baseRegistry.buttons.map((button) => {
        if (button.button_id === "call_webhook_demo") {
          return {
            ...button,
            require_signature: true
          };
        }
        return button;
      })
    };
    await writeFile(registryPath, `${JSON.stringify(mutated, null, 2)}\n`, "utf8");

    const server = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    try {
      const executionId = await createExecution(server.port, {
        button_id: "call_webhook_demo",
        actor_role: "admin"
      });
      const done = await waitForExecution(server.port, executionId);
      expect(done.execution.status).toBe("failed");
      expect(done.execution.error_code).toBe("SIGNATURE_REQUIRED");
    } finally {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects request with direct spell_id field (button_id only contract)", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          spell_id: "samples/call-webhook",
          actor_role: "admin"
        })
      });

      expect(response.status).toBe(400);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.error_code).toBe("BAD_REQUEST");
      expect(String(payload.message)).toContain("unsupported field");
    } finally {
      await server.close();
    }
  });

  test("applies tenant POST rate limit per tenant_id", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:operator=team-b-op-token"],
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 50,
      tenantRateLimitWindowMs: 60_000,
      tenantRateLimitMaxRequests: 1
    });

    try {
      const firstA = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(firstA.status).toBe(202);

      const secondA = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(secondA.status).toBe(429);
      const secondAPayload = (await secondA.json()) as Record<string, unknown>;
      expect(secondAPayload.error_code).toBe("TENANT_RATE_LIMITED");

      const firstB = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(firstB.status).toBe(202);
    } finally {
      await server.close();
    }
  });

  test("blocks when tenant in-flight concurrency limit is reached", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token"],
      maxConcurrentExecutions: 10,
      tenantMaxConcurrentExecutions: 0
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });

      expect(response.status).toBe(429);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.error_code).toBe("TENANT_CONCURRENCY_LIMITED");
    } finally {
      await server.close();
    }
  });

  test("GET /api/tenants/:tenant_id/usage enforces auth and admin role with auth keys", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_a:admin=team-a-admin-token"]
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/tenants/team_a/usage`);
      expect(unauthorized.status).toBe(401);
      const unauthorizedPayload = (await unauthorized.json()) as Record<string, unknown>;
      expect(unauthorizedPayload.error_code).toBe("AUTH_REQUIRED");

      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(created.status).toBe(202);

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/tenants/team_a/usage`, {
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("ADMIN_ROLE_REQUIRED");

      const allowed = await fetch(`http://127.0.0.1:${server.port}/api/tenants/team_a/usage`, {
        headers: { authorization: "Bearer team-a-admin-token" }
      });
      expect(allowed.status).toBe(200);
      const allowedPayload = (await allowed.json()) as {
        tenant_id: string;
        usage: { queued: number; running: number; submissions_last_24h: number };
      };
      expect(allowedPayload.tenant_id).toBe("team_a");
      expect(typeof allowedPayload.usage.queued).toBe("number");
      expect(typeof allowedPayload.usage.running).toBe("number");
      expect(allowedPayload.usage.submissions_last_24h).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  test("applies POST rate limit", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 1
    });

    try {
      const first = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "repo_ops_guarded",
          actor_role: "admin"
        })
      });
      expect(first.status).toBe(202);

      const second = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "repo_ops_guarded",
          actor_role: "admin"
        })
      });
      expect(second.status).toBe(429);
    } finally {
      await server.close();
    }
  });

  test("blocks when in-flight concurrency limit is reached", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      maxConcurrentExecutions: 0
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "repo_ops_guarded",
          actor_role: "admin"
        })
      });

      expect(response.status).toBe(429);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.error_code).toBe("CONCURRENCY_LIMITED");
    } finally {
      await server.close();
    }
  });
});

async function waitForExecution(
  port: number,
  executionId: string,
  token?: string
): Promise<{ execution: Record<string, unknown>; receipt: unknown }> {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/spell-executions/${executionId}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined
    });
    if (response.status === 200) {
      const payload = (await response.json()) as { execution: Record<string, unknown>; receipt: unknown };
      const status = payload.execution.status;
      if (status === "succeeded" || status === "failed" || status === "timeout") {
        return payload;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("execution did not finish in time");
}

async function waitForTenantAuditStatuses(
  homeDir: string,
  executionId: string,
  requiredStatuses: Set<string>
): Promise<string[]> {
  const auditPath = path.join(homeDir, ".spell", "logs", "tenant-audit.jsonl");
  const deadline = Date.now() + 4_000;

  while (Date.now() < deadline) {
    const auditRaw = await readFile(auditPath, "utf8").catch(() => "");
    const statuses = auditRaw
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.execution_id === executionId)
      .map((event) => String(event.status));

    const statusSet = new Set(statuses);
    let allPresent = true;
    for (const required of requiredStatuses) {
      if (!statusSet.has(required)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) {
      return statuses;
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("tenant audit statuses not found in time");
}

async function createExecution(
  port: number,
  body: {
    button_id: string;
    actor_role: string;
    confirmation?: {
      risk_acknowledged?: boolean;
      billing_acknowledged?: boolean;
    };
  }
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/spell-executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(202);
  const payload = (await response.json()) as Record<string, unknown>;
  return String(payload.execution_id);
}
