import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import path from "node:path";
import { listSpellVersions, loadMarketCatalog, searchMarketCatalog, type MarketRisk } from "./marketCatalog";
import { spellHome } from "../util/paths";
import { SpellError } from "../util/errors";

const DEFAULT_PORT = 8789;

export async function startMarketServer(
  port = readIntegerEnv("SPELL_MARKET_PORT", DEFAULT_PORT)
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
    throw new SpellError("failed to resolve market server address");
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
    writeJson(res, 200, { ok: true, service: "spell-market" });
    return;
  }

  if (method === "GET" && pathname === "/v1/spells") {
    const catalog = await loadMarketCatalog(marketCatalogPath());
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
    const latestOnlyRaw = String(url.searchParams.get("latest") ?? "").toLowerCase();
    const latestOnly = latestOnlyRaw === "1" || latestOnlyRaw === "true";
    const query = url.searchParams.get("query") ?? undefined;
    const publisher = url.searchParams.get("publisher") ?? undefined;
    const tag = url.searchParams.get("tag") ?? undefined;
    const riskRaw = url.searchParams.get("risk");
    const risk = riskRaw ? (riskRaw as MarketRisk) : undefined;

    const spells = searchMarketCatalog(catalog, {
      query,
      publisher,
      tag,
      risk,
      latestOnly,
      limit
    });
    writeJson(res, 200, {
      filters: {
        query: query ?? null,
        publisher: publisher ?? null,
        tag: tag ?? null,
        risk: risk ?? null,
        latest: latestOnly,
        limit: limit ?? 20
      },
      count: spells.length,
      spells
    });
    return;
  }

  if (method === "GET" && pathname.startsWith("/v1/spells/") && pathname.endsWith("/versions")) {
    const matched = /^\/v1\/spells\/(.+)\/versions$/.exec(pathname);
    const encodedId = matched?.[1] ?? "";
    const id = decodeURIComponent(encodedId);
    const catalog = await loadMarketCatalog(marketCatalogPath());
    const versions = listSpellVersions(catalog, id);
    if (versions.length === 0) {
      writeJson(res, 404, {
        error_code: "NOT_FOUND",
        message: `spell not found: ${id}`
      });
      return;
    }
    writeJson(res, 200, {
      id,
      count: versions.length,
      versions
    });
    return;
  }

  writeJson(res, 404, {
    error_code: "NOT_FOUND",
    message: `route not found: ${method} ${pathname}`
  });
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

function marketCatalogPath(): string {
  const configured = String(process.env.SPELL_MARKET_CATALOG_PATH ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(spellHome(), "market", "catalog.v1.json");
}

async function main(): Promise<void> {
  const started = await startMarketServer();
  process.stdout.write(`spell-market listening on http://127.0.0.1:${started.port}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
