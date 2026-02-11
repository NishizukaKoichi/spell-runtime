import { describe, expect, test } from "vitest";
import { applyTemplate } from "../../src/util/template";

describe("template replacement", () => {
  test("replaces INPUT and ENV placeholders", () => {
    const result = applyTemplate(
      {
        url: "https://api.test/{{INPUT.project}}",
        token: "{{ENV.TEST_TOKEN}}"
      },
      { project: "demo" },
      { TEST_TOKEN: "secret" }
    );

    expect(result).toEqual({
      url: "https://api.test/demo",
      token: "secret"
    });
  });

  test("fails on unresolved template", () => {
    expect(() => applyTemplate("{{INPUT.missing}}", {}, {})).toThrow(/unresolved template/);
  });
});
