import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nock from "nock";
import { describe, expect, test } from "vitest";
import { evaluateChecks } from "../../src/checks/evaluate";

describe("evaluateChecks", () => {
  test("checks file_exists and jsonpath_equals", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "spell-check-"));
    const filePath = path.join(dir, "result.txt");
    await writeFile(filePath, "ok", "utf8");

    const checks = [
      {
        type: "file_exists",
        params: { path: filePath }
      },
      {
        type: "jsonpath_equals",
        params: {
          from_output: "step.deploy.json",
          path: "data.id",
          expected: "abc"
        }
      }
    ] as const;

    const outputs = {
      "step.deploy.json": {
        data: { id: "abc" }
      }
    };

    const results = await evaluateChecks(checks as unknown as never[], dir, outputs, true);
    expect(results.every((r) => r.success)).toBe(true);
  });

  test("checks http_status", async () => {
    nock("https://status.example.test").get("/health").reply(200, "ok");

    const results = await evaluateChecks(
      [
        {
          type: "http_status",
          params: {
            expect: 200,
            url: "https://status.example.test/health"
          }
        }
      ] as never[],
      process.cwd(),
      {},
      true
    );

    expect(results[0].success).toBe(true);
  });
});
