import { describe, expect, test } from "vitest";
import { resolveOutputReference } from "../../src/util/outputs";

describe("output reference", () => {
  test("resolves json nested path", () => {
    const outputs = {
      "step.deploy.json": {
        data: {
          id: "abc"
        }
      }
    };

    expect(resolveOutputReference(outputs, "step.deploy.json.data.id")).toBe("abc");
  });

  test("resolves stdout", () => {
    const outputs = {
      "step.echo.stdout": "hello"
    };

    expect(resolveOutputReference(outputs, "step.echo.stdout")).toBe("hello");
  });
});
