import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
      expect(JSON.stringify(done.receipt)).not.toContain("stdout_head");
      expect(JSON.stringify(done.receipt)).not.toContain("stderr_head");
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

  test("GET /api/spell-executions supports status/button_id/limit filters", async () => {
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
        `http://127.0.0.1:${server.port}/api/spell-executions?status=succeeded&button_id=publish_site_high_risk&limit=1`
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

      const done = await waitForExecution(server.port, executionId, "op-token");
      expect(done.execution.actor_role).toBe("operator");
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
