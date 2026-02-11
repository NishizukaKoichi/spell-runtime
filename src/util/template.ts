import { SpellError } from "./errors";
import { getByDotPath } from "./object";

const TEMPLATE_PATTERN = /{{\s*(INPUT|ENV)\.([A-Za-z0-9_.-]+)\s*}}/g;
const UNRESOLVED_PATTERN = /{{\s*[^}]+\s*}}/;

export function applyTemplate(value: unknown, input: Record<string, unknown>, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return resolveStringTemplate(value, input, env);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => applyTemplate(entry, input, env));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyTemplate(v, input, env);
    }
    return out;
  }

  return value;
}

function resolveStringTemplate(template: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv): unknown {
  const matches = [...template.matchAll(TEMPLATE_PATTERN)];
  if (matches.length === 0) {
    if (UNRESOLVED_PATTERN.test(template)) {
      throw new SpellError(`unresolved template: ${template}`);
    }
    return template;
  }

  if (matches.length === 1 && matches[0][0] === template) {
    const resolved = resolveToken(matches[0][1], matches[0][2], input, env);
    return resolved;
  }

  let replaced = template;
  for (const match of matches) {
    const resolved = resolveToken(match[1], match[2], input, env);
    const replacement = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    replaced = replaced.replace(match[0], replacement);
  }

  if (UNRESOLVED_PATTERN.test(replaced)) {
    throw new SpellError(`unresolved template: ${replaced}`);
  }

  return replaced;
}

function resolveToken(source: string, path: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv): unknown {
  if (source === "INPUT") {
    const value = getByDotPath(input, path);
    if (value === undefined) {
      throw new SpellError(`unresolved template: {{INPUT.${path}}}`);
    }
    return value;
  }

  const value = env[path];
  if (value === undefined) {
    throw new SpellError(`unresolved template: {{ENV.${path}}}`);
  }

  return value;
}
