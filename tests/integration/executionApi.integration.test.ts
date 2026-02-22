import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      expect(Object.prototype.hasOwnProperty.call(buttonsPayload.buttons[0] ?? {}, "allowed_tenants")).toBe(true);
      const teamAOnly = buttonsPayload.buttons.find((button) => button.button_id === "call_webhook_team_a_only");
      expect(teamAOnly?.allowed_tenants).toEqual(["team_a"]);

      const page = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Spell Receipts UI");
      expect(html).toContain("guardHint");
      expect(html).toContain("executionStatus");
      expect(html).toContain("apiToken");
      expect(html).toContain("tenantHint");

      const js = await fetch(`http://127.0.0.1:${server.port}/ui/app.js`);
      expect(js.status).toBe(200);
      const script = await js.text();
      expect(script).toContain("updateGuardHints");
      expect(script).toContain("actor role not allowed for selected button");
      expect(script).toContain("Allowed tenants");
      expect(script).toContain("makeApiHeaders");
      expect(script).toContain("data-cancel-id");
      expect(script).toContain("/cancel");
      expect(script).toContain("data-retry-id");
      expect(script).toContain("/retry");
      expect(script).toContain("/events");
      expect(script).toContain("startExecutionStream");
      expect(script).toContain("/api/spell-executions/events");
      expect(script).toContain("startListStream");
      expect(script).toContain("Retry links:");
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

  test("GET /api/spell-executions supports status/button_id/spell_id/tenant_id/limit filters", async () => {
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
        `http://127.0.0.1:${server.port}/api/spell-executions?status=succeeded&button_id=publish_site_high_risk&spell_id=samples/publish-site&tenant_id=default&limit=1`
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

      const spellFiltered = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions?spell_id=samples/repo-ops`
      );
      expect(spellFiltered.status).toBe(200);
      const spellFilteredPayload = (await spellFiltered.json()) as {
        executions: Array<{ execution_id: string; spell_id: string }>;
      };
      expect(spellFilteredPayload.executions.some((execution) => execution.execution_id === failedExecutionId)).toBe(true);
      expect(spellFilteredPayload.executions.every((execution) => execution.spell_id === "samples/repo-ops")).toBe(true);

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

  test("GET /api/spell-executions supports from/to time filters", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const executionId = await createExecution(server.port, {
        button_id: "call_webhook_demo",
        actor_role: "admin",
        dry_run: true
      });
      await waitForExecution(server.port, executionId);

      const nowIso = new Date().toISOString();
      const olderIso = new Date(Date.now() - 60_000).toISOString();
      const futureIso = new Date(Date.now() + 60_000).toISOString();

      const inRange = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions?from=${encodeURIComponent(olderIso)}&to=${encodeURIComponent(nowIso)}`
      );
      expect(inRange.status).toBe(200);
      const inRangePayload = (await inRange.json()) as {
        executions: Array<{ execution_id: string }>;
      };
      expect(inRangePayload.executions.some((execution) => execution.execution_id === executionId)).toBe(true);

      const outOfRange = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions?from=${encodeURIComponent(futureIso)}`
      );
      expect(outOfRange.status).toBe(200);
      const outOfRangePayload = (await outOfRange.json()) as {
        executions: Array<{ execution_id: string }>;
      };
      expect(outOfRangePayload.executions.some((execution) => execution.execution_id === executionId)).toBe(false);

      const invalid = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?from=not-a-time`);
      expect(invalid.status).toBe(400);
      const invalidPayload = (await invalid.json()) as Record<string, unknown>;
      expect(invalidPayload.error_code).toBe("INVALID_QUERY");
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions/events streams filtered execution list updates", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const streamPromise = readExecutionListStreamEvents(
        `http://127.0.0.1:${server.port}/api/spell-executions/events?status=succeeded&limit=20`,
        2200
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      const executionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      await waitForExecution(server.port, executionId);

      const events = await streamPromise;
      expect(events.some((event) => event.event === "snapshot")).toBe(true);
      const executionSeen = events
        .filter((event) => event.event === "snapshot" || event.event === "executions")
        .map((event) => event.data)
        .some((payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return false;
          }
          const executions = (payload as { executions?: Array<{ execution_id?: string }> }).executions;
          if (!Array.isArray(executions)) {
            return false;
          }
          return executions.some((execution) => execution.execution_id === executionId);
        });
      expect(executionSeen).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions/events enforces tenant scope for auth keys", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:operator=team-b-op-token"]
    });

    try {
      const createdA = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(createdA.status).toBe(202);
      const payloadA = (await createdA.json()) as Record<string, unknown>;
      const executionA = String(payloadA.execution_id);
      await waitForExecution(server.port, executionA, "team-a-op-token");

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
      const payloadB = (await createdB.json()) as Record<string, unknown>;
      const executionB = String(payloadB.execution_id);
      await waitForExecution(server.port, executionB, "team-b-op-token");

      const events = await readExecutionListStreamEvents(
        `http://127.0.0.1:${server.port}/api/spell-executions/events?limit=50`,
        1000,
        "team-a-op-token"
      );
      const snapshots = events.filter((event) => event.event === "snapshot" || event.event === "executions");
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) {
        const data = snapshot.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          continue;
        }
        const executions = (data as { executions?: Array<{ tenant_id?: string; execution_id?: string }> }).executions;
        if (!Array.isArray(executions)) {
          continue;
        }
        for (const execution of executions) {
          expect(execution.tenant_id).toBe("team_a");
          expect(execution.execution_id).not.toBe(executionB);
        }
      }

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/events?tenant_id=team_b`, {
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("TENANT_FORBIDDEN");
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions/:execution_id/output returns one output value", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const executionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      await waitForExecution(server.port, executionId);

      const output = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/output?path=step.publish.stdout`
      );
      expect(output.status).toBe(200);
      const outputPayload = (await output.json()) as {
        execution_id: string;
        path: string;
        value: unknown;
      };
      expect(outputPayload.execution_id).toBe(executionId);
      expect(outputPayload.path).toBe("step.publish.stdout");
      expect(String(outputPayload.value)).toContain("publish simulated");

      const invalidPath = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/output?path=bad-reference`
      );
      expect(invalidPath.status).toBe(400);
      const invalidPayload = (await invalidPath.json()) as Record<string, unknown>;
      expect(invalidPayload.error_code).toBe("INVALID_OUTPUT_PATH");

      const missingOutput = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/output?path=step.publish.json.value`
      );
      expect(missingOutput.status).toBe(404);
      const missingPayload = (await missingOutput.json()) as Record<string, unknown>;
      expect(missingPayload.error_code).toBe("OUTPUT_NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions/:execution_id/events streams execution updates until terminal", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const executionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });

      const streamResponse = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/events`, {
        signal: AbortSignal.timeout(8_000)
      });
      expect(streamResponse.status).toBe(200);
      expect(String(streamResponse.headers.get("content-type") ?? "")).toContain("text/event-stream");

      const streamBody = await streamResponse.text();
      const events = parseSseEvents(streamBody);
      expect(events.some((event) => event.event === "snapshot")).toBe(true);
      expect(events.some((event) => event.event === "terminal")).toBe(true);

      const terminal = [...events].reverse().find((event) => event.event === "terminal");
      const terminalPayload = (terminal?.data ?? {}) as { execution?: { status?: string } };
      const status = String(terminalPayload.execution?.status ?? "");
      expect(["succeeded", "failed", "timeout", "canceled"]).toContain(status);
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions/:execution_id/events forbids non-admin cross-tenant stream with auth keys", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:operator=team-b-op-token"]
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const executionId = String(createdPayload.execution_id);

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/events`, {
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("TENANT_FORBIDDEN");
    } finally {
      await server.close();
    }
  });

  test("POST /api/spell-executions/:execution_id/cancel cancels queued executions", async () => {
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
          actor_role: "admin",
          dry_run: true,
          input: {
            payload: {
              blob: "x".repeat(48_000)
            }
          }
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      expect(createdPayload.status).toBe("queued");
      const executionId = String(createdPayload.execution_id);

      const canceled = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/cancel`, {
        method: "POST"
      });
      expect(canceled.status).toBe(200);
      const canceledPayload = (await canceled.json()) as Record<string, unknown>;
      expect(canceledPayload.status).toBe("canceled");

      const done = await waitForExecution(server.port, executionId);
      expect(done.execution.status).toBe("canceled");

      const listed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?status=canceled`);
      expect(listed.status).toBe(200);
      const listedPayload = (await listed.json()) as {
        executions: Array<{ execution_id: string; status: string }>;
      };
      expect(listedPayload.executions.some((execution) => execution.execution_id === executionId)).toBe(true);
      expect(listedPayload.executions.every((execution) => execution.status === "canceled")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("POST /api/spell-executions/:execution_id/cancel terminates running executions", async () => {
    const bundleDir = await createHostShellBundle("tests/cancel-running", [
      {
        name: "slow",
        fileName: "slow.js",
        source: "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write('done\\n'); }, 1500);\n"
      }
    ]);
    const registryDir = await mkdtemp(path.join(tmpdir(), "spell-api-registry-"));
    const registryPath = path.join(registryDir, "button-registry.v1.json");

    const baseRegistryRaw = await readFile(path.join(process.cwd(), "examples/button-registry.v1.json"), "utf8");
    const baseRegistry = JSON.parse(baseRegistryRaw) as {
      version: "v1";
      buttons: Array<Record<string, unknown>>;
    };
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: baseRegistry.version,
          buttons: [
            ...baseRegistry.buttons,
            {
              button_id: "cancel_running_demo",
              label: "Cancel Running Demo",
              description: "Fixture for canceling running execution",
              spell_id: "tests/cancel-running",
              version: "1.0.0",
              defaults: {
                name: "world"
              },
              required_confirmations: {
                risk: false,
                billing: false
              },
              require_signature: false,
              allowed_roles: ["admin", "operator"]
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

    const server = await startExecutionApiServer({
      port: 0,
      registryPath,
      executionTimeoutMs: 10_000
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "cancel_running_demo",
          actor_role: "admin"
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const executionId = String(createdPayload.execution_id);

      await waitForExecutionStatus(server.port, executionId, "running");

      const canceled = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/cancel`, {
        method: "POST"
      });
      expect(canceled.status).toBe(200);
      const canceledPayload = (await canceled.json()) as Record<string, unknown>;
      expect(canceledPayload.status).toBe("canceled");

      const done = await waitForExecution(server.port, executionId);
      expect(done.execution.status).toBe("canceled");
    } finally {
      await server.close();
      await rm(bundleDir, { recursive: true, force: true });
      await rm(registryDir, { recursive: true, force: true });
    }
  });

  test("POST /api/spell-executions/:execution_id/cancel returns ALREADY_TERMINAL for terminal execution", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const executionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      const done = await waitForExecution(server.port, executionId);
      expect(done.execution.status).toBe("succeeded");

      const canceled = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/cancel`, {
        method: "POST"
      });
      expect(canceled.status).toBe(409);
      const canceledPayload = (await canceled.json()) as Record<string, unknown>;
      expect(canceledPayload.error_code).toBe("ALREADY_TERMINAL");
    } finally {
      await server.close();
    }
  });

  test("POST /api/spell-executions/:execution_id/retry enqueues linked retry for retryable execution", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const sourceExecutionId = await createExecution(server.port, {
        button_id: "repo_ops_guarded",
        actor_role: "admin"
      });
      const sourceDone = await waitForExecution(server.port, sourceExecutionId);
      expect(sourceDone.execution.status).toBe("failed");

      const retried = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${sourceExecutionId}/retry`, {
        method: "POST"
      });
      expect(retried.status).toBe(202);
      const retriedPayload = (await retried.json()) as Record<string, unknown>;
      const retryExecutionId = String(retriedPayload.execution_id);
      expect(retryExecutionId).not.toBe(sourceExecutionId);
      expect(retriedPayload.retry_of).toBe(sourceExecutionId);
      expect(retriedPayload.status).toBe("queued");

      const retryDone = await waitForExecution(server.port, retryExecutionId);
      expect(retryDone.execution.retry_of).toBe(sourceExecutionId);
      expect(retryDone.execution.button_id).toBe(sourceDone.execution.button_id);
      expect(retryDone.execution.spell_id).toBe(sourceDone.execution.spell_id);
      expect(retryDone.execution.version).toBe(sourceDone.execution.version);
      expect(retryDone.execution.tenant_id).toBe(sourceDone.execution.tenant_id);
      expect(retryDone.execution.actor_role).toBe(sourceDone.execution.actor_role);

      const sourceDetail = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${sourceExecutionId}`);
      expect(sourceDetail.status).toBe(200);
      const sourceDetailPayload = (await sourceDetail.json()) as { execution: Record<string, unknown> };
      expect(sourceDetailPayload.execution.retried_by).toBe(retryExecutionId);

      const listed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions?limit=10`);
      expect(listed.status).toBe(200);
      const listedPayload = (await listed.json()) as {
        executions: Array<{ execution_id: string; retry_of?: string; retried_by?: string }>;
      };
      const listedSource = listedPayload.executions.find((execution) => execution.execution_id === sourceExecutionId);
      const listedRetry = listedPayload.executions.find((execution) => execution.execution_id === retryExecutionId);
      expect(listedSource?.retried_by).toBe(retryExecutionId);
      expect(listedRetry?.retry_of).toBe(sourceExecutionId);
    } finally {
      await server.close();
    }
  });

  test("POST /api/spell-executions/:execution_id/retry returns NOT_RETRYABLE for non-retryable status", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const sourceExecutionId = await createExecution(server.port, {
        button_id: "publish_site_high_risk",
        actor_role: "admin",
        confirmation: { risk_acknowledged: true }
      });
      const sourceDone = await waitForExecution(server.port, sourceExecutionId);
      expect(sourceDone.execution.status).toBe("succeeded");

      const retried = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${sourceExecutionId}/retry`, {
        method: "POST"
      });
      expect(retried.status).toBe(409);
      const retriedPayload = (await retried.json()) as Record<string, unknown>;
      expect(retriedPayload.error_code).toBe("NOT_RETRYABLE");
    } finally {
      await server.close();
    }
  });

  test("POST /api/spell-executions/:execution_id/retry forbids non-admin cross-tenant retry with auth keys", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:admin=team-b-admin-token"]
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-admin-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "repo_ops_guarded",
          actor_role: "operator"
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const sourceExecutionId = String(createdPayload.execution_id);

      const sourceDone = await waitForExecution(server.port, sourceExecutionId, "team-b-admin-token");
      expect(sourceDone.execution.status).toBe("failed");
      expect(sourceDone.execution.tenant_id).toBe("team_b");

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${sourceExecutionId}/retry`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("TENANT_FORBIDDEN");
    } finally {
      await server.close();
    }
  });

  test("GET /api/spell-executions/:execution_id/output forbids non-admin cross-tenant access with auth keys", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:admin=team-b-admin-token"]
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-admin-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "publish_site_high_risk",
          actor_role: "admin",
          confirmation: {
            risk_acknowledged: true
          }
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const executionId = String(createdPayload.execution_id);
      await waitForExecution(server.port, executionId, "team-b-admin-token");

      const forbidden = await fetch(
        `http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/output?path=step.publish.stdout`,
        {
          headers: { authorization: "Bearer team-a-op-token" }
        }
      );
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("TENANT_FORBIDDEN");
    } finally {
      await server.close();
    }
  });

  test("persists retry linkage and restores after server restart", async () => {
    const registryPath = path.join(process.cwd(), "examples/button-registry.v1.json");

    const server1 = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    let sourceExecutionId = "";
    let retryExecutionId = "";
    try {
      sourceExecutionId = await createExecution(server1.port, {
        button_id: "repo_ops_guarded",
        actor_role: "admin"
      });
      await waitForExecution(server1.port, sourceExecutionId);

      const retried = await fetch(`http://127.0.0.1:${server1.port}/api/spell-executions/${sourceExecutionId}/retry`, {
        method: "POST"
      });
      expect(retried.status).toBe(202);
      const retriedPayload = (await retried.json()) as Record<string, unknown>;
      retryExecutionId = String(retriedPayload.execution_id);
      await waitForExecution(server1.port, retryExecutionId);
    } finally {
      await server1.close();
    }

    const indexPath = path.join(tempHome, ".spell", "logs", "index.json");
    const indexRaw = await readFile(indexPath, "utf8");
    expect(indexRaw).toContain(sourceExecutionId);
    expect(indexRaw).toContain(retryExecutionId);
    expect(indexRaw).toContain('"retry_of"');
    expect(indexRaw).toContain('"retried_by"');

    const server2 = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    try {
      const sourceDetail = await fetch(`http://127.0.0.1:${server2.port}/api/spell-executions/${sourceExecutionId}`);
      expect(sourceDetail.status).toBe(200);
      const sourcePayload = (await sourceDetail.json()) as { execution: Record<string, unknown> };
      expect(sourcePayload.execution.retried_by).toBe(retryExecutionId);

      const retryDetail = await fetch(`http://127.0.0.1:${server2.port}/api/spell-executions/${retryExecutionId}`);
      expect(retryDetail.status).toBe(200);
      const retryPayload = (await retryDetail.json()) as { execution: Record<string, unknown> };
      expect(retryPayload.execution.retry_of).toBe(sourceExecutionId);
    } finally {
      await server2.close();
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

  test("replays POST with same Idempotency-Key and returns existing execution", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const body = JSON.stringify({
        button_id: "call_webhook_demo",
        actor_role: "admin",
        dry_run: true,
        input: {
          event: "deploy",
          payload: {
            service: "web"
          }
        },
        confirmation: {
          risk_acknowledged: false,
          billing_acknowledged: false
        }
      });

      const first = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": " replay-key-1 " },
        body
      });
      expect(first.status).toBe(202);
      const firstPayload = (await first.json()) as Record<string, unknown>;
      const executionId = String(firstPayload.execution_id);
      expect(firstPayload.idempotent_replay).toBeUndefined();

      const replay = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "replay-key-1" },
        body
      });
      expect(replay.status).toBe(202);
      const replayPayload = (await replay.json()) as Record<string, unknown>;
      expect(replayPayload.execution_id).toBe(executionId);
      expect(replayPayload.idempotent_replay).toBe(true);
      expect(typeof replayPayload.status).toBe("string");

      const listed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`);
      expect(listed.status).toBe(200);
      const listedPayload = (await listed.json()) as {
        executions: Array<{ execution_id: string }>;
      };
      expect(listedPayload.executions.filter((execution) => execution.execution_id === executionId)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test("returns IDEMPOTENCY_CONFLICT when same Idempotency-Key is reused with different request", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json")
    });

    try {
      const first = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "conflict-key" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(first.status).toBe(202);

      const conflicting = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "conflict-key" },
        body: JSON.stringify({
          button_id: "call_webhook_demo",
          actor_role: "admin",
          dry_run: false
        })
      });
      expect(conflicting.status).toBe(409);
      const conflictPayload = (await conflicting.json()) as Record<string, unknown>;
      expect(conflictPayload.error_code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      await server.close();
    }
  });

  test("persists idempotency mapping and replays across server restart", async () => {
    const registryPath = path.join(process.cwd(), "examples/button-registry.v1.json");
    const requestBody = JSON.stringify({
      button_id: "call_webhook_demo",
      actor_role: "admin",
      dry_run: true,
      input: {
        event: "deploy"
      }
    });

    const server1 = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    let executionId = "";
    try {
      const created = await fetch(`http://127.0.0.1:${server1.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "restart-key-1" },
        body: requestBody
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      executionId = String(createdPayload.execution_id);
      await waitForExecution(server1.port, executionId);
    } finally {
      await server1.close();
    }

    const indexPath = path.join(tempHome, ".spell", "logs", "index.json");
    const indexRaw = await readFile(indexPath, "utf8");
    expect(indexRaw).toContain("restart-key-1");

    const server2 = await startExecutionApiServer({
      port: 0,
      registryPath
    });

    try {
      const replay = await fetch(`http://127.0.0.1:${server2.port}/api/spell-executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "restart-key-1" },
        body: requestBody
      });
      expect(replay.status).toBe(202);
      const replayPayload = (await replay.json()) as Record<string, unknown>;
      expect(replayPayload.execution_id).toBe(executionId);
      expect(replayPayload.idempotent_replay).toBe(true);
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

  test("POST /api/spell-executions/:execution_id/cancel forbids non-admin cross-tenant cancel with auth keys", async () => {
    const bundleDir = await createHostShellBundle("tests/cancel-tenant-scope", [
      {
        name: "slow",
        fileName: "slow.js",
        source: "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write('done\\n'); }, 1500);\n"
      }
    ]);
    const registryDir = await mkdtemp(path.join(tmpdir(), "spell-api-registry-"));
    const registryPath = path.join(registryDir, "button-registry.v1.json");

    const baseRegistryRaw = await readFile(path.join(process.cwd(), "examples/button-registry.v1.json"), "utf8");
    const baseRegistry = JSON.parse(baseRegistryRaw) as {
      version: "v1";
      buttons: Array<Record<string, unknown>>;
    };
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: baseRegistry.version,
          buttons: [
            ...baseRegistry.buttons,
            {
              button_id: "cancel_tenant_scope_demo",
              label: "Cancel Tenant Scope Demo",
              description: "Fixture for tenant-scoped cancel",
              spell_id: "tests/cancel-tenant-scope",
              version: "1.0.0",
              defaults: {
                name: "world"
              },
              required_confirmations: {
                risk: false,
                billing: false
              },
              require_signature: false,
              allowed_roles: ["admin", "operator"]
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

    const server = await startExecutionApiServer({
      port: 0,
      registryPath,
      executionTimeoutMs: 10_000,
      authKeys: ["team_a:operator=team-a-op-token", "team_b:operator=team-b-op-token"]
    });

    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "cancel_tenant_scope_demo",
          actor_role: "admin"
        })
      });
      expect(created.status).toBe(202);
      const createdPayload = (await created.json()) as Record<string, unknown>;
      const executionId = String(createdPayload.execution_id);

      await waitForExecutionStatus(server.port, executionId, "running", "team-b-op-token");

      const forbidden = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token" }
      });
      expect(forbidden.status).toBe(403);
      const forbiddenPayload = (await forbidden.json()) as Record<string, unknown>;
      expect(forbiddenPayload.error_code).toBe("TENANT_FORBIDDEN");

      const allowed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions/${executionId}/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-op-token" }
      });
      expect(allowed.status).toBe(200);
      const allowedPayload = (await allowed.json()) as Record<string, unknown>;
      expect(allowedPayload.status).toBe("canceled");

      const done = await waitForExecution(server.port, executionId, "team-b-op-token");
      expect(done.execution.status).toBe("canceled");
    } finally {
      await server.close();
      await rm(bundleDir, { recursive: true, force: true });
      await rm(registryDir, { recursive: true, force: true });
    }
  });

  test("enforces button tenant allowlist for auth keys", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      authKeys: ["team_a:operator=team-a-op-token", "team_b:operator=team-b-op-token"]
    });

    try {
      const allowed = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-a-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_team_a_only",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(allowed.status).toBe(202);
      const allowedPayload = (await allowed.json()) as Record<string, unknown>;
      expect(allowedPayload.tenant_id).toBe("team_a");

      const denied = await fetch(`http://127.0.0.1:${server.port}/api/spell-executions`, {
        method: "POST",
        headers: { authorization: "Bearer team-b-op-token", "content-type": "application/json" },
        body: JSON.stringify({
          button_id: "call_webhook_team_a_only",
          actor_role: "admin",
          dry_run: true
        })
      });
      expect(denied.status).toBe(403);
      const deniedPayload = (await denied.json()) as Record<string, unknown>;
      expect(deniedPayload.error_code).toBe("TENANT_NOT_ALLOWED");
      expect(String(deniedPayload.message)).toContain("team_b");
      expect(String(deniedPayload.message)).toContain("call_webhook_team_a_only");
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

      const payload = await waitForExecutionList(
        server.port,
        (executions) => executions.length === 1 && executions[0]?.execution_id === secondExecutionId
      );
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

  test("can force signature policy globally for all buttons", async () => {
    const server = await startExecutionApiServer({
      port: 0,
      registryPath: path.join(process.cwd(), "examples/button-registry.v1.json"),
      forceRequireSignature: true
    });

    try {
      const buttons = await fetch(`http://127.0.0.1:${server.port}/api/buttons`);
      expect(buttons.status).toBe(200);
      const buttonsPayload = (await buttons.json()) as {
        buttons: Array<{ button_id: string; require_signature: boolean }>;
      };
      const callWebhook = buttonsPayload.buttons.find((button) => button.button_id === "call_webhook_demo");
      expect(callWebhook?.require_signature).toBe(true);

      const executionId = await createExecution(server.port, {
        button_id: "call_webhook_demo",
        actor_role: "admin"
      });
      const done = await waitForExecution(server.port, executionId);
      expect(done.execution.status).toBe("failed");
      expect(done.execution.error_code).toBe("SIGNATURE_REQUIRED");
    } finally {
      await server.close();
    }
  });

  test("marks failed compensation as COMPENSATION_INCOMPLETE when rollback policy requires full compensation", async () => {
    const bundleDir = await createHostShellBundle("tests/api-rollback-strict", [
      {
        name: "prepare",
        fileName: "prepare.js",
        source: ["#!/usr/bin/env node", "console.log('prepared');"].join("\n"),
        rollbackFileName: "rollback-prepare.js",
        rollbackSource: ["#!/usr/bin/env node", "process.stderr.write('rollback failed\\n');", "process.exit(1);"].join("\n")
      },
      {
        name: "deploy",
        fileName: "deploy.js",
        source: ["#!/usr/bin/env node", "process.stderr.write('deploy failed\\n');", "process.exit(1);"].join("\n"),
        dependsOn: ["prepare"]
      }
    ]);
    const tempRegistryDir = await mkdtemp(path.join(tmpdir(), "spell-api-rollback-registry-"));
    const registryPath = path.join(tempRegistryDir, "button-registry.v1.json");

    try {
      expect(await runCli(["node", "spell", "install", bundleDir])).toBe(0);

      const baseRegistryRaw = await readFile(path.join(process.cwd(), "examples/button-registry.v1.json"), "utf8");
      const baseRegistry = JSON.parse(baseRegistryRaw) as {
        version: "v1";
        buttons: Array<Record<string, unknown>>;
      };
      const extendedRegistry = {
        version: baseRegistry.version,
        buttons: [
          ...baseRegistry.buttons,
          {
            button_id: "rollback_strict_test",
            label: "Rollback Strict Test",
            description: "compensation strictness test",
            spell_id: "tests/api-rollback-strict",
            version: "1.0.0",
            defaults: {
              name: "demo"
            },
            required_confirmations: {
              risk: false,
              billing: false
            },
            require_signature: false,
            allowed_roles: ["admin"]
          }
        ]
      };
      await writeFile(registryPath, `${JSON.stringify(extendedRegistry, null, 2)}\n`, "utf8");

      const spellDir = path.join(tempHome, ".spell");
      await mkdir(spellDir, { recursive: true });
      await writeFile(
        path.join(spellDir, "policy.json"),
        `${JSON.stringify({ version: "v1", default: "allow", rollback: { require_full_compensation: true } }, null, 2)}\n`,
        "utf8"
      );

      const server = await startExecutionApiServer({
        port: 0,
        registryPath
      });

      try {
        const executionId = await createExecution(server.port, {
          button_id: "rollback_strict_test",
          actor_role: "admin"
        });
        const done = await waitForExecution(server.port, executionId);
        expect(done.execution.status).toBe("failed");
        expect(done.execution.error_code).toBe("COMPENSATION_INCOMPLETE");

        const receipt = done.receipt as Record<string, unknown>;
        const rollback = receipt.rollback as Record<string, unknown>;
        expect(rollback.manual_recovery_required).toBe(true);
        expect(rollback.require_full_compensation).toBe(true);
        expect(rollback.state).toBe("not_compensated");
      } finally {
        await server.close();
      }
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
      await rm(tempRegistryDir, { recursive: true, force: true });
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
      if (status === "succeeded" || status === "failed" || status === "timeout" || status === "canceled") {
        return payload;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("execution did not finish in time");
}

async function waitForExecutionList(
  port: number,
  predicate: (executions: Array<{ execution_id: string }>) => boolean,
  token?: string
): Promise<{ executions: Array<{ execution_id: string }> }> {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/spell-executions`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined
    });
    if (response.status === 200) {
      const payload = (await response.json()) as { executions: Array<{ execution_id: string }> };
      if (predicate(payload.executions)) {
        return payload;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("execution list did not reach expected state");
}

async function waitForExecutionStatus(
  port: number,
  executionId: string,
  expectedStatus: string,
  token?: string
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/spell-executions/${executionId}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined
    });
    if (response.status !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      continue;
    }

    const payload = (await response.json()) as { execution: { status?: string } };
    const status = String(payload.execution.status ?? "");
    if (status === expectedStatus) {
      return;
    }

    if (status === "succeeded" || status === "failed" || status === "timeout" || status === "canceled") {
      throw new Error(`execution reached terminal status ${status} before ${expectedStatus}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error(`execution did not reach status ${expectedStatus} in time`);
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

function parseSseEvents(raw: string): Array<{ event: string; data: unknown }> {
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const events: Array<{ event: string; data: unknown }> = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }

    const dataRaw = dataLines.join("\n");
    let data: unknown = dataRaw;
    try {
      data = JSON.parse(dataRaw) as unknown;
    } catch {
      // keep string payload for non-json data frames.
    }

    events.push({ event, data });
  }

  return events;
}

async function readExecutionListStreamEvents(
  url: string,
  durationMs: number,
  token?: string
): Promise<Array<{ event: string; data: unknown }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, durationMs);

  let streamRaw = "";
  try {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(String(response.headers.get("content-type") ?? "")).toContain("text/event-stream");
    if (!response.body) {
      return [];
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        streamRaw += decoder.decode(next.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    const aborted =
      error instanceof Error
        ? error.name === "AbortError"
        : typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError";
    if (!aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }

  return parseSseEvents(streamRaw);
}

async function createHostShellBundle(
  spellId: string,
  steps: Array<{
    name: string;
    fileName: string;
    source: string;
    dependsOn?: string[];
    rollbackFileName?: string;
    rollbackSource?: string;
  }>
): Promise<string> {
  const bundleDir = await mkdtemp(path.join(tmpdir(), "spell-cancel-bundle-"));
  const stepsDir = path.join(bundleDir, "steps");
  await mkdir(stepsDir, { recursive: true });

  for (const step of steps) {
    const stepPath = path.join(stepsDir, step.fileName);
    await writeFile(stepPath, step.source, "utf8");
    await chmod(stepPath, 0o755);

    if (step.rollbackFileName) {
      const rollbackPath = path.join(stepsDir, step.rollbackFileName);
      await writeFile(rollbackPath, step.rollbackSource ?? "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
      await chmod(rollbackPath, 0o755);
    }
  }

  await writeFile(
    path.join(bundleDir, "schema.json"),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: true
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const manifestLines: string[] = [
    `id: ${spellId}`,
    "version: 1.0.0",
    "name: Cancel Fixture",
    "summary: cancel fixture",
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
    `    - ${process.platform}/${process.arch}`,
    "steps:"
  ];

  for (const step of steps) {
    manifestLines.push("  - uses: shell");
    manifestLines.push(`    name: ${step.name}`);
    manifestLines.push(`    run: steps/${step.fileName}`);
    if (step.dependsOn && step.dependsOn.length > 0) {
      manifestLines.push("    depends_on:");
      for (const dep of step.dependsOn) {
        manifestLines.push(`      - ${dep}`);
      }
    }
    if (step.rollbackFileName) {
      manifestLines.push(`    rollback: steps/${step.rollbackFileName}`);
    }
  }

  manifestLines.push("checks:");
  manifestLines.push("  - type: exit_code");
  manifestLines.push("    params: {}");
  manifestLines.push("");

  await writeFile(path.join(bundleDir, "spell.yaml"), manifestLines.join("\n"), "utf8");
  return bundleDir;
}
