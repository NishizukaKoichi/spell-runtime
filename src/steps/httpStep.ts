import { readFile } from "node:fs/promises";
import { SpellStep, StepResult } from "../types";
import { SpellError } from "../util/errors";
import { fetchHttp } from "../util/http";
import { applyTemplate } from "../util/template";

interface HttpStepDefinition {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpStepExecution {
  stepResult: StepResult;
  responseBody: unknown;
  status: number;
}

export async function runHttpStep(
  step: SpellStep,
  runPath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): Promise<HttpStepExecution> {
  const started = new Date().toISOString();

  const raw = await readFile(runPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`failed to parse http step '${step.name}' JSON: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError(`http step '${step.name}' definition must be an object`);
  }

  const def = parsed as Record<string, unknown>;
  const method = readRequiredString(def, "method");
  const urlValue = readRequiredString(def, "url");
  const headersValue = def.headers;
  const bodyValue = def.body;

  const resolvedMethod = String(applyTemplate(method, input, env)).toUpperCase();
  const resolvedUrl = applyTemplate(urlValue, input, env);
  if (typeof resolvedUrl !== "string") {
    throw new SpellError(`http step '${step.name}' url must resolve to string`);
  }

  const resolvedHeaders = applyTemplate(headersValue, input, env);
  const headers = normalizeHeaders(resolvedHeaders);
  const resolvedBody = applyTemplate(bodyValue, input, env);

  let body: string | undefined;
  if (resolvedBody !== undefined) {
    if (typeof resolvedBody === "string") {
      body = resolvedBody;
    } else {
      body = JSON.stringify(resolvedBody);
      if (!hasHeader(headers, "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
  }

  const response = await fetchHttp(resolvedUrl, {
    method: resolvedMethod,
    headers,
    body
  });

  const responseText = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText) as unknown;
  } catch {
    responseBody = responseText;
  }

  const finished = new Date().toISOString();

  const stepResult: StepResult = {
    stepName: step.name,
    uses: step.uses,
    started_at: started,
    finished_at: finished,
    success: true,
    message: `http ${resolvedMethod} ${resolvedUrl} -> ${response.status}`
  };

  return {
    stepResult,
    responseBody,
    status: response.status
  };
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`http step definition missing '${key}' string`);
  }
  return value;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpellError("http step headers must resolve to an object");
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new SpellError(`http step header '${k}' must be string`);
    }
    out[k.toLowerCase()] = v;
  }

  return out;
}

function hasHeader(headers: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(headers, key.toLowerCase());
}
