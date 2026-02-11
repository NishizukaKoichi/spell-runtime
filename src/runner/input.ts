import { readFile } from "node:fs/promises";
import Ajv2020, { type AnySchema } from "ajv/dist/2020";
import { SpellError } from "../util/errors";
import { parseKeyValuePair, setByDotPath } from "../util/object";

const ajv = new Ajv2020({ allErrors: true, strict: false });

export async function buildInput(inputFile: string | undefined, paramPairs: string[]): Promise<Record<string, unknown>> {
  let baseInput: Record<string, unknown> = {};

  if (inputFile) {
    const raw = await readFile(inputFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SpellError("--input must be a JSON object");
    }
    baseInput = { ...(parsed as Record<string, unknown>) };
  }

  for (const pair of paramPairs) {
    const { key, value } = parseKeyValuePair(pair);
    setByDotPath(baseInput, key, value);
  }

  return baseInput;
}

export function validateInputAgainstSchema(schema: unknown, input: Record<string, unknown>): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new SpellError("schema.json must be a JSON object");
  }

  const validate = ajv.compile(schema as AnySchema);
  const valid = validate(input);
  if (!valid) {
    const messages = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message}`.trim())
      .join("; ");
    throw new SpellError(`input does not match schema: ${messages}`);
  }
}
