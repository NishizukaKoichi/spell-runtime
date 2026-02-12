import { describe, expect, test } from "vitest";
import { collectSensitiveEnvValues, redactSecrets } from "../../src/util/redact";

describe("redactSecrets", () => {
  test("redacts sensitive keys and auth headers", () => {
    const value = {
      token: "abc123",
      nested: {
        authorization: "Bearer super-token"
      },
      safe: "ok"
    };

    const redacted = redactSecrets(value, {});

    expect(redacted).toEqual({
      token: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]"
      },
      safe: "ok"
    });
  });

  test("redacts env-derived secret values in free-form strings", () => {
    const env = {
      CONNECTOR_GITHUB_TOKEN: "ghp_superSecretValue",
      APP_SECRET: "env-secret-123"
    } as NodeJS.ProcessEnv;

    const value = {
      line: "token ghp_superSecretValue",
      note: "Bearer env-secret-123",
      keep: "visible"
    };

    const redacted = redactSecrets(value, env);
    expect(JSON.stringify(redacted)).not.toContain("ghp_superSecretValue");
    expect(JSON.stringify(redacted)).not.toContain("env-secret-123");
    expect(redacted.keep).toBe("visible");
  });

  test("collects only sensitive env names", () => {
    const env = {
      CONNECTOR_GITHUB_TOKEN: "a",
      APP_SECRET: "b",
      HOME: "/tmp/home",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv;

    expect(collectSensitiveEnvValues(env).sort()).toEqual(["a", "b"]);
  });
});
