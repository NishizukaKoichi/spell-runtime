import { mkdtemp, rm } from "node:fs/promises";
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
});

async function waitForExecution(port: number, executionId: string): Promise<{ execution: Record<string, unknown>; receipt: unknown }> {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/spell-executions/${executionId}`);
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
