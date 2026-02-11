import { access } from "node:fs/promises";
import path from "node:path";
import { CheckResult, SpellCheck } from "../types";
import { SpellError } from "../util/errors";
import { getByDotPath } from "../util/object";
import { resolveOutputReference } from "../util/outputs";
import { fetchHttp } from "../util/http";

export async function evaluateChecks(
  checks: SpellCheck[],
  bundlePath: string,
  outputs: Record<string, unknown>,
  stepsSucceeded: boolean
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    if (check.type === "exit_code") {
      results.push({
        type: check.type,
        success: stepsSucceeded,
        message: stepsSucceeded ? "all steps succeeded" : "some step failed"
      });
      continue;
    }

    if (check.type === "file_exists") {
      const p = readRequiredString(check.params, "path", "file_exists.params.path");
      const target = path.isAbsolute(p) ? p : path.resolve(bundlePath, p);

      const exists = await access(target)
        .then(() => true)
        .catch(() => false);

      results.push({
        type: check.type,
        success: exists,
        message: exists ? `file exists: ${target}` : `file missing: ${target}`
      });
      continue;
    }

    if (check.type === "http_status") {
      const expect = readRequiredNumber(check.params, "expect", "http_status.params.expect");
      const explicitUrl = readOptionalString(check.params, "url");
      const ref = readOptionalString(check.params, "url_from_output");

      const resolvedUrl = explicitUrl ?? (ref ? resolveHttpUrlFromOutput(outputs, ref) : undefined);
      if (!resolvedUrl) {
        throw new SpellError("http_status check needs params.url or params.url_from_output");
      }

      const response = await fetchHttp(resolvedUrl);
      const ok = response.status === expect;

      results.push({
        type: check.type,
        success: ok,
        message: ok
          ? `http status matched: ${response.status}`
          : `http status mismatch: got ${response.status}, expected ${expect}`
      });
      continue;
    }

    if (check.type === "jsonpath_equals") {
      const fromOutput = readRequiredString(check.params, "from_output", "jsonpath_equals.params.from_output");
      const pathValue = readRequiredString(check.params, "path", "jsonpath_equals.params.path");
      const expected = check.params.expected;

      const source = resolveOutputReference(outputs, fromOutput);
      const actual = getByDotPath(source, pathValue);
      const ok = actual === expected;

      results.push({
        type: check.type,
        success: ok,
        message: ok
          ? `jsonpath matched: ${pathValue}`
          : `jsonpath mismatch at ${pathValue}: expected ${String(expected)}, got ${String(actual)}`
      });
      continue;
    }

    throw new SpellError(`unsupported check type: ${check.type}`);
  }

  return results;
}

function resolveHttpUrlFromOutput(outputs: Record<string, unknown>, ref: string): string {
  const resolved = resolveOutputReference(outputs, ref);
  if (typeof resolved !== "string") {
    throw new SpellError(`http_status url_from_output must resolve to string: ${ref}`);
  }
  return resolved;
}

function readRequiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`missing required string: ${label}`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`invalid string for ${key}`);
  }
  return value;
}

function readRequiredNumber(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SpellError(`missing required number: ${label}`);
  }
  return value;
}
