import { readFile } from "node:fs/promises";
import { SpellError } from "../util/errors";
import { compareVersionDesc } from "../util/version";

export type MarketRisk = "low" | "medium" | "high" | "critical";

export interface MarketSpellEntry {
  id: string;
  version: string;
  name: string;
  summary: string;
  publisher: string;
  risk: MarketRisk;
  source: string;
  tags: string[];
}

export interface MarketCatalogV1 {
  version: "v1";
  spells: MarketSpellEntry[];
}

export interface MarketSearchQuery {
  query?: string;
  publisher?: string;
  risk?: MarketRisk;
  tag?: string;
  latestOnly?: boolean;
  limit?: number;
}

const MARKET_RISKS = new Set<MarketRisk>(["low", "medium", "high", "critical"]);

export async function loadMarketCatalog(filePath: string): Promise<MarketCatalogV1> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new SpellError(`failed to read market catalog '${filePath}': ${(error as Error).message}`);
  }
  return parseMarketCatalog(raw, filePath);
}

export function parseMarketCatalog(raw: string, source: string): MarketCatalogV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`invalid market catalog JSON (${source}): ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("invalid market catalog: expected JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== "v1") {
    throw new SpellError(`invalid market catalog: unsupported version '${String(obj.version ?? "")}'`);
  }
  if (!Array.isArray(obj.spells)) {
    throw new SpellError("invalid market catalog: spells must be an array");
  }

  const spells = obj.spells.map((item, index) => normalizeSpellEntry(item, index));
  return {
    version: "v1",
    spells
  };
}

export function searchMarketCatalog(catalog: MarketCatalogV1, query: MarketSearchQuery): MarketSpellEntry[] {
  const limit = normalizeLimit(query.limit);
  const queryText = String(query.query ?? "").trim().toLowerCase();
  const publisherFilter = String(query.publisher ?? "").trim().toLowerCase();
  const riskFilter = String(query.risk ?? "").trim().toLowerCase();
  const tagFilter = String(query.tag ?? "").trim().toLowerCase();
  if (riskFilter && !MARKET_RISKS.has(riskFilter as MarketRisk)) {
    throw new SpellError(`invalid risk filter '${riskFilter}'`);
  }

  const scored = catalog.spells
    .filter((entry) => {
      if (publisherFilter && entry.publisher.toLowerCase() !== publisherFilter) {
        return false;
      }
      if (riskFilter && entry.risk !== (riskFilter as MarketRisk)) {
        return false;
      }
      if (tagFilter && !entry.tags.some((tag) => tag.toLowerCase() === tagFilter)) {
        return false;
      }
      return true;
    })
    .map((entry) => ({ entry, score: computeScore(entry, queryText) }))
    .filter((row) => (queryText ? row.score > 0 : true))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      const idOrder = left.entry.id.localeCompare(right.entry.id);
      if (idOrder !== 0) {
        return idOrder;
      }
      return compareVersionDesc(left.entry.version, right.entry.version);
    })
    .map((row) => row.entry);

  const latestSeenIds = new Set<string>();
  const maybeLatestOnly =
    query.latestOnly === true
      ? scored.filter((entry) => {
          const key = `${entry.id}`;
          if (latestSeenIds.has(key)) {
            return false;
          }
          latestSeenIds.add(key);
          return true;
        })
      : scored;

  return maybeLatestOnly.slice(0, limit);
}

export function listSpellVersions(catalog: MarketCatalogV1, id: string): MarketSpellEntry[] {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new SpellError("spell id is required");
  }
  return catalog.spells
    .filter((entry) => entry.id === normalizedId)
    .sort((a, b) => compareVersionDesc(a.version, b.version));
}

function normalizeSpellEntry(item: unknown, index: number): MarketSpellEntry {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new SpellError(`invalid market catalog: spells[${index}] must be an object`);
  }
  const row = item as Record<string, unknown>;
  const id = readRequiredString(row, "id", index);
  const version = readRequiredString(row, "version", index);
  const name = readRequiredString(row, "name", index);
  const summary = readRequiredString(row, "summary", index);
  const publisher = readRequiredString(row, "publisher", index);
  const source = readRequiredString(row, "source", index);
  const riskRaw = readRequiredString(row, "risk", index).toLowerCase();
  if (!MARKET_RISKS.has(riskRaw as MarketRisk)) {
    throw new SpellError(`invalid market catalog: spells[${index}] risk must be one of low|medium|high|critical`);
  }

  const tagsRaw = row.tags;
  let tags: string[] = [];
  if (tagsRaw !== undefined) {
    if (!Array.isArray(tagsRaw)) {
      throw new SpellError(`invalid market catalog: spells[${index}] tags must be an array`);
    }
    tags = tagsRaw
      .map((tag) => String(tag).trim())
      .filter((tag) => tag.length > 0);
  }

  return {
    id,
    version,
    name,
    summary,
    publisher,
    risk: riskRaw as MarketRisk,
    source,
    tags
  };
}

function computeScore(entry: MarketSpellEntry, query: string): number {
  if (!query) {
    return 0;
  }
  let score = 0;
  if (entry.id.toLowerCase().includes(query)) {
    score += 5;
  }
  if (entry.name.toLowerCase().includes(query)) {
    score += 4;
  }
  if (entry.summary.toLowerCase().includes(query)) {
    score += 3;
  }
  if (entry.publisher.toLowerCase().includes(query)) {
    score += 2;
  }
  if (entry.tags.some((tag) => tag.toLowerCase().includes(query))) {
    score += 1;
  }
  return score;
}

function readRequiredString(row: Record<string, unknown>, key: string, index: number): string {
  const value = String(row[key] ?? "").trim();
  if (!value) {
    throw new SpellError(`invalid market catalog: spells[${index}] ${key} must be a non-empty string`);
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 200) {
    throw new SpellError("limit must be an integer between 1 and 200");
  }
  return value;
}
