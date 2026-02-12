import { readFile } from "node:fs/promises";
import Ajv2020, { type AnySchema } from "ajv/dist/2020";
import { SpellError } from "../util/errors";

export interface ButtonRequiredConfirmations {
  risk: boolean;
  billing: boolean;
}

export interface ButtonRegistryEntry {
  button_id: string;
  spell_id: string;
  version: string;
  defaults: Record<string, unknown>;
  required_confirmations: ButtonRequiredConfirmations;
  allowed_roles: string[];
  label?: string;
  description?: string;
}

export interface ButtonRegistryV1 {
  version: "v1";
  buttons: ButtonRegistryEntry[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

const registrySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "buttons"],
  properties: {
    version: { const: "v1" },
    buttons: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "button_id",
          "spell_id",
          "version",
          "defaults",
          "required_confirmations",
          "allowed_roles"
        ],
        properties: {
          button_id: { type: "string", minLength: 1 },
          spell_id: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          defaults: { type: "object" },
          required_confirmations: {
            type: "object",
            additionalProperties: false,
            required: ["risk", "billing"],
            properties: {
              risk: { type: "boolean" },
              billing: { type: "boolean" }
            }
          },
          allowed_roles: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 }
          },
          label: { type: "string" },
          description: { type: "string" }
        }
      }
    }
  }
} as const;

const validateRegistry = ajv.compile(registrySchema as AnySchema);

export async function loadButtonRegistryFromFile(filePath: string): Promise<ButtonRegistryV1> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new SpellError(`button registry file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`failed to parse button registry JSON: ${(error as Error).message}`);
  }

  const ok = validateRegistry(parsed);
  if (!ok) {
    const details = (validateRegistry.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message}`.trim())
      .join("; ");
    throw new SpellError(`button registry validation failed: ${details}`);
  }

  const registry = parsed as ButtonRegistryV1;
  assertUniqueButtonIds(registry.buttons);

  return registry;
}

export function resolveButtonEntry(registry: ButtonRegistryV1, buttonId: string): ButtonRegistryEntry {
  const found = registry.buttons.find((entry) => entry.button_id === buttonId);
  if (!found) {
    throw new SpellError(`unknown button_id: ${buttonId}`);
  }
  return found;
}

function assertUniqueButtonIds(buttons: ButtonRegistryEntry[]): void {
  const seen = new Set<string>();

  for (const entry of buttons) {
    if (seen.has(entry.button_id)) {
      throw new SpellError(`duplicate button_id in registry: ${entry.button_id}`);
    }
    seen.add(entry.button_id);
  }
}
