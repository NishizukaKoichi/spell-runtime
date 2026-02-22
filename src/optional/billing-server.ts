import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { issueEntitlementToken, loadPrivateKeyPem } from "./entitlementIssuer";
import { spellHome } from "../util/paths";
import { SpellError } from "../util/errors";

const DEFAULT_PORT = 8790;
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;

export async function startBillingIssuerServer(
  port = readIntegerEnv("SPELL_BILLING_PORT", DEFAULT_PORT)
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
    throw new SpellError("failed to resolve billing issuer server address");
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
  const route = req.url?.split("?")[0] ?? "/";

  if (method === "GET" && route === "/health") {
    writeJson(res, 200, { ok: true, service: "spell-billing-issuer" });
    return;
  }

  if (method === "POST" && route === "/v1/entitlements/issue") {
    const authError = authorizeRequest(req);
    if (authError) {
      writeJson(res, authError.status, authError.payload);
      return;
    }

    const payload = await readJsonBody(req, DEFAULT_BODY_LIMIT_BYTES);
    const mode = String(payload.mode ?? "").trim();
    const currency = String(payload.currency ?? "").trim();
    const maxAmount = Number(payload.max_amount);
    const notBefore = payload.not_before === undefined ? undefined : String(payload.not_before);
    const expiresAt = payload.expires_at === undefined ? undefined : String(payload.expires_at);
    const ttlSecondsRaw = payload.ttl_seconds;
    const ttlSeconds = ttlSecondsRaw === undefined ? undefined : Number(ttlSecondsRaw);

    const privateKeyPem = await loadPrivateKeyPem(billingPrivateKeyPath());
    const issued = issueEntitlementToken(
      {
        issuer: billingIssuer(),
        keyId: billingKeyId(),
        privateKeyPem
      },
      {
        mode: mode as "upfront" | "on_success" | "subscription",
        currency,
        maxAmount,
        notBefore,
        expiresAt,
        ttlSeconds
      }
    );

    writeJson(res, 200, {
      token: issued.token,
      claims: issued.claims
    });
    return;
  }

  writeJson(res, 404, {
    error_code: "NOT_FOUND",
    message: `route not found: ${method} ${route}`
  });
}

function authorizeRequest(
  req: IncomingMessage
): { status: number; payload: Record<string, unknown> } | null {
  const requiredToken = String(process.env.SPELL_BILLING_API_TOKEN ?? "").trim();
  if (!requiredToken) {
    return null;
  }

  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") {
    return {
      status: 401,
      payload: {
        error_code: "AUTH_REQUIRED",
        message: "authorization token is required"
      }
    };
  }
  const matched = /^Bearer\s+(.+)$/.exec(authorization.trim());
  const provided = matched?.[1]?.trim();
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

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
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

function billingPrivateKeyPath(): string {
  const configured = String(process.env.SPELL_BILLING_PRIVATE_KEY_PATH ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(spellHome(), "billing", "issuer.private.pem");
}

function billingIssuer(): string {
  const issuer = String(process.env.SPELL_BILLING_ISSUER ?? "").trim();
  if (!issuer) {
    throw new SpellError("SPELL_BILLING_ISSUER is required");
  }
  return issuer;
}

function billingKeyId(): string {
  return String(process.env.SPELL_BILLING_KEY_ID ?? "default").trim() || "default";
}

async function main(): Promise<void> {
  const started = await startBillingIssuerServer();
  process.stdout.write(`spell-billing-issuer listening on http://127.0.0.1:${started.port}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
