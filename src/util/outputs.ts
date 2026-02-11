import { SpellError } from "./errors";
import { getByDotPath } from "./object";

export function resolveOutputReference(outputs: Record<string, unknown>, ref: string): unknown {
  const match = /^step\.([^.]+)\.(stdout|json)(?:\.(.+))?$/.exec(ref);
  if (!match) {
    throw new SpellError(`invalid output reference: ${ref}`);
  }

  const [, stepName, kind, path] = match;
  const key = `step.${stepName}.${kind}`;
  if (!(key in outputs)) {
    throw new SpellError(`output reference not found: ${ref}`);
  }

  const baseValue = outputs[key];

  if (kind === "stdout") {
    if (path) {
      throw new SpellError(`stdout reference does not support nested path: ${ref}`);
    }
    return baseValue;
  }

  if (!path) {
    return baseValue;
  }

  return getByDotPath(baseValue, path);
}
