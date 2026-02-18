import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpellBilling } from "../types";
import { SpellError } from "../util/errors";
import { licensesRoot } from "../util/paths";
import {
  EntitlementClaims,
  EntitlementTokenMetadata,
  isEntitlementWithinTimeWindow,
  parseEntitlementClaims,
  parseEntitlementToken,
  verifyEntitlementToken
} from "./entitlement";

interface LicenseRecordV1 {
  version: "v1";
  name: string;
  token: string;
  created_at: string;
  updated_at: string;
}

interface LicenseRecordV2 {
  version: "v2";
  name: string;
  token: string;
  token_metadata: EntitlementTokenMetadata;
  entitlement: EntitlementClaims;
  created_at: string;
  updated_at: string;
}

interface ParsedLicenseRecord {
  version: "v1" | "v2";
  name: string;
  token: string;
  created_at?: string;
  updated_at?: string;
  token_metadata?: EntitlementTokenMetadata;
  entitlement?: EntitlementClaims;
}

export interface StoredLicense {
  name: string;
  hasToken: boolean;
  created_at?: string;
  updated_at?: string;
  entitlement?: EntitlementClaims;
}

export function toLicenseKey(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

export function licenseFilePath(name: string): string {
  return path.join(licensesRoot(), `${toLicenseKey(name)}.json`);
}

export async function upsertLicense(name: string, token: string): Promise<void> {
  const normalizedName = normalizeName(name);
  const normalizedToken = normalizeToken(token);
  const verifiedToken = await verifyEntitlementToken(normalizedToken);
  await mkdir(licensesRoot(), { recursive: true });

  const now = new Date().toISOString();
  const existing = await loadLicenseRecord(normalizedName);
  const payload: LicenseRecordV2 = {
    version: "v2",
    name: normalizedName,
    token: verifiedToken.rawToken,
    token_metadata: verifiedToken.metadata,
    entitlement: verifiedToken.claims,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };

  const filePath = licenseFilePath(normalizedName);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function removeLicense(name: string): Promise<boolean> {
  const normalizedName = normalizeName(name);
  const filePath = licenseFilePath(normalizedName);
  const existed = await access(filePath).then(() => true).catch(() => false);
  if (!existed) return false;
  await rm(filePath, { force: true });
  return true;
}

export async function listLicenses(): Promise<StoredLicense[]> {
  const entries = await readdir(licensesRoot()).catch(() => []);
  const licenses: StoredLicense[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = path.join(licensesRoot(), entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }

    const record = parseLicenseRecord(parsed, { strict: false, filePath });
    if (!record) continue;

    licenses.push({
      name: record.name,
      hasToken: record.token.trim().length > 0,
      created_at: record.created_at,
      updated_at: record.updated_at,
      entitlement: record.entitlement
    });
  }

  licenses.sort((a, b) => a.name.localeCompare(b.name));
  return licenses;
}

export async function findFirstUsableLicense(): Promise<StoredLicense | null> {
  const licenses = await listLicenses();
  return licenses.find((entry) => entry.hasToken) ?? null;
}

export async function findMatchingLicenseForBilling(
  billing: SpellBilling,
  now: Date = new Date()
): Promise<StoredLicense | null> {
  const licenses = await listLicenses();
  const targetCurrency = billing.currency.trim().toLowerCase();

  for (const entry of licenses) {
    if (!entry.entitlement) continue;

    const entitlement = entry.entitlement;
    if (!isEntitlementWithinTimeWindow(entitlement, now)) continue;
    if (entitlement.mode !== billing.mode) continue;
    if (entitlement.currency.trim().toLowerCase() !== targetCurrency) continue;
    if (entitlement.max_amount < billing.max_amount) continue;

    return entry;
  }

  return null;
}

async function loadLicenseRecord(name: string): Promise<ParsedLicenseRecord | null> {
  const filePath = licenseFilePath(name);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SpellError(`failed to parse license file: ${filePath}`);
  }

  const record = parseLicenseRecord(parsed, { strict: true, filePath, expectedName: name });
  if (!record) {
    throw new SpellError(`failed to load license file: ${filePath}`);
  }
  return record;
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new SpellError("license name must be non-empty");
  }
  return trimmed;
}

function normalizeToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new SpellError("license token must be non-empty");
  }
  return trimmed;
}

interface ParseLicenseRecordOptions {
  strict: boolean;
  filePath: string;
  expectedName?: string;
}

function parseLicenseRecord(
  parsed: unknown,
  options: ParseLicenseRecordOptions
): ParsedLicenseRecord | null {
  const fail = (message: string): null => {
    if (options.strict) {
      throw new SpellError(message);
    }
    return null;
  };

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(`license file must be a JSON object: ${options.filePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const version = readOptionalString(obj, "version");
  if (!version) {
    return fail("missing 'version' string");
  }
  if (version !== "v1" && version !== "v2") {
    return fail(`unsupported license file version: ${version}`);
  }

  const name = readOptionalString(obj, "name");
  if (!name) {
    return fail("missing 'name' string");
  }
  if (options.expectedName && name !== options.expectedName) {
    return fail(`license file name mismatch: expected '${options.expectedName}', got '${name}'`);
  }

  const token = readOptionalString(obj, "token");
  if (!token) {
    return fail("missing 'token' string");
  }

  const createdAt = readOptionalString(obj, "created_at");
  const updatedAt = readOptionalString(obj, "updated_at");
  if (options.strict && !createdAt) {
    return fail("missing 'created_at' string");
  }
  if (options.strict && !updatedAt) {
    return fail("missing 'updated_at' string");
  }

  if (version === "v1") {
    const record: ParsedLicenseRecord = {
      version: "v1",
      name,
      token,
      created_at: createdAt,
      updated_at: updatedAt
    };
    return record;
  }

  const tokenMetadata = parseTokenMetadata(obj.token_metadata, options, fail);
  if (!tokenMetadata) {
    return null;
  }

  let entitlement: EntitlementClaims;
  try {
    entitlement = parseEntitlementClaims(obj.entitlement);
  } catch (error) {
    return fail((error as Error).message);
  }

  let tokenClaims: EntitlementClaims;
  let tokenMetadataFromToken: EntitlementTokenMetadata;
  try {
    const parsedToken = parseEntitlementToken(token);
    tokenClaims = parsedToken.claims;
    tokenMetadataFromToken = parsedToken.metadata;
  } catch (error) {
    return fail(`invalid stored entitlement token: ${(error as Error).message}`);
  }

  if (
    tokenMetadataFromToken.payload_base64url !== tokenMetadata.payload_base64url ||
    tokenMetadataFromToken.signature_base64url !== tokenMetadata.signature_base64url
  ) {
    return fail("stored entitlement token metadata does not match token segments");
  }

  if (!entitlementsEqual(tokenClaims, entitlement)) {
    return fail("stored entitlement claims do not match token payload claims");
  }

  return {
    version: "v2",
    name,
    token,
    created_at: createdAt,
    updated_at: updatedAt,
    token_metadata: tokenMetadata,
    entitlement
  };
}

function parseTokenMetadata(
  input: unknown,
  options: ParseLicenseRecordOptions,
  fail: (message: string) => null
): EntitlementTokenMetadata | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail(`license token_metadata must be an object: ${options.filePath}`);
  }

  const metadataObj = input as Record<string, unknown>;
  const format = readOptionalString(metadataObj, "format");
  if (format !== "ent1") {
    return fail("license token_metadata.format must be 'ent1'");
  }

  const payloadBase64Url = readOptionalString(metadataObj, "payload_base64url");
  if (!payloadBase64Url || !/^[A-Za-z0-9_-]+$/.test(payloadBase64Url)) {
    return fail("license token_metadata.payload_base64url must be base64url");
  }

  const signatureBase64Url = readOptionalString(metadataObj, "signature_base64url");
  if (!signatureBase64Url || !/^[A-Za-z0-9_-]+$/.test(signatureBase64Url)) {
    return fail("license token_metadata.signature_base64url must be base64url");
  }

  return {
    format: "ent1",
    payload_base64url: payloadBase64Url,
    signature_base64url: signatureBase64Url
  };
}

function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function entitlementsEqual(left: EntitlementClaims, right: EntitlementClaims): boolean {
  return left.version === right.version &&
    left.issuer === right.issuer &&
    left.key_id === right.key_id &&
    left.mode === right.mode &&
    left.currency === right.currency &&
    left.max_amount === right.max_amount &&
    left.not_before === right.not_before &&
    left.expires_at === right.expires_at;
}
