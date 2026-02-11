import { describe, expect, test } from "vitest";
import { buildInput, validateInputAgainstSchema } from "../../src/runner/input";

describe("input builder and schema validation", () => {
  test("buildInput merges -p values and nested key", async () => {
    const input = await buildInput(undefined, ["name=koichi", "meta.version=1"]);
    expect(input).toEqual({ name: "koichi", meta: { version: 1 } });
  });

  test("validateInputAgainstSchema rejects invalid input", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" }
      },
      required: ["name"],
      additionalProperties: false
    };

    expect(() => validateInputAgainstSchema(schema, {})).toThrow(/input does not match schema/);
  });
});
