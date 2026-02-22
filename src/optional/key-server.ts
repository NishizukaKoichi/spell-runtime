import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import path from "node:path";
import { loadKeyBrokerStore, resolveConnectorToken } from "./keyBroker";
import { spellHome } from "../util/paths";
import { SpellError } from "../util/errors";

const DEFAULT_PORT = 8788;
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;

export async function startKeyBrokerServer(
  port = readIntegerEnv("SPELL_REQUIRES_KEY_PORT", DEFAULT_PORT)
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      writeJson(res, 500, {
        error_code: "INTERNAL_ERROR",
        message: (error as Error).message
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new SpellError("failed to resolve key broker server address");
  }
  return {
    port: address.port,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    writeJson(res, 200, { ok: true, service: "spell-requires-key" });
    return;
  }

  if (method === "POST" && pathname === "/v1/resolve-token") {
    const authError = authorizeRequest(req);
    if (authError) {
      writeJson(res, authError.status, authError.payload);
      return;
    }

    const payload = await readJsonBody(req, DEFAULT_BODY_LIMIT_BYTES);
    const connector = String(payload.connector ?? "").trim();
    const tenantId = String(payload.tenant_id ?? "default").trim() || "default";
    if (!connector) {
      writeJson(res, 400, {
        error_code: "INVALID_REQUEST",
        message: "connector is required"
      });
      return;
    }

    const storePath = keyBrokerStorePath();
    const store = await loadKeyBrokerStore(storePath);
    const resolved = resolveConnectorToken(store, { tenantId, connector });
    if (!resolved) {
      writeJson(res, 404, {
        error_code: "TOKEN_NOT_FOUND",
        message: `token not found for tenant='${tenantId}' connector='${connector}'`
      });
      return;
    }

    writeJson(res, 200, {
      tenant_id: resolved.tenant_id,
      connector: resolved.connector,
      token: resolved.token,
      scopes: resolved.scopes
    });
    return;
  }

  writeJson(res, 404, {
    error_code: "NOT_FOUND",
    message: `route not found: ${method} ${pathname}`
  });
}

function authorizeRequest(
  req: IncomingMessage
): { status: number; payload: Record<string, unknown> } | null {
  const requiredToken = String(process.env.SPELL_REQUIRES_KEY_API_TOKEN ?? "").trim();
  if (!requiredToken) {
    return null;
  }
  const provided = readBearerToken(req);
  if (!provided) {
    return {
      status: 401,
      payload: {
        error_code: "AUTH_REQUIRED",
        message: "authorization token is required"
      }
    };
  }
  if (provided !== requiredToken) {
    return {
      status: 403,
      payload: {
        error_code: "AUTH_INVALID",
        message: "invalid authorization token"
      }
    };
  }
  return null;
}

function readBearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  const matched = /^Bearer\s+(.+)$/.exec(authorization.trim());
  if (!matched) {
    return null;
  }
  return matched[1].trim() || null;
}

async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new SpellError(`request body too large (max ${limitBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });

  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`invalid JSON body: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("invalid JSON body: expected object");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function keyBrokerStorePath(): string {
  const configured = String(process.env.SPELL_REQUIRES_KEY_STORE_PATH ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(spellHome(), "spell-requires-key.v1.json");
}

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new SpellError(`${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const started = await startKeyBrokerServer();
  process.stdout.write(`spell-requires-key listening on http://127.0.0.1:${started.port}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
