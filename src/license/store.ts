import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpellError } from "../util/errors";
import { licensesRoot } from "../util/paths";

interface LicenseRecordV1 {
  version: "v1";
  name: string;
  token: string;
  created_at: string;
  updated_at: string;
}

export interface StoredLicense {
  name: string;
  hasToken: boolean;
  created_at?: string;
  updated_at?: string;
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
  await mkdir(licensesRoot(), { recursive: true });

  const now = new Date().toISOString();
  const existing = await loadLicenseRecord(normalizedName);
  const payload: LicenseRecordV1 = {
    version: "v1",
    name: normalizedName,
    token: normalizedToken,
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

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const obj = parsed as Record<string, unknown>;
    if (obj.version !== "v1") continue;
    if (typeof obj.name !== "string" || !obj.name.trim()) continue;
    if (typeof obj.token !== "string") continue;

    licenses.push({
      name: obj.name.trim(),
      hasToken: obj.token.trim().length > 0,
      created_at: typeof obj.created_at === "string" ? obj.created_at : undefined,
      updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined
    });
  }

  licenses.sort((a, b) => a.name.localeCompare(b.name));
  return licenses;
}

export async function findFirstUsableLicense(): Promise<StoredLicense | null> {
  const licenses = await listLicenses();
  return licenses.find((entry) => entry.hasToken) ?? null;
}

async function loadLicenseRecord(name: string): Promise<LicenseRecordV1 | null> {
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

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError(`license file must be a JSON object: ${filePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const version = readRequiredString(obj, "version");
  if (version !== "v1") {
    throw new SpellError(`unsupported license file version: ${version}`);
  }

  const parsedName = readRequiredString(obj, "name");
  if (parsedName !== name) {
    throw new SpellError(`license file name mismatch: expected '${name}', got '${parsedName}'`);
  }

  return {
    version: "v1",
    name: parsedName,
    token: readRequiredString(obj, "token"),
    created_at: readRequiredString(obj, "created_at"),
    updated_at: readRequiredString(obj, "updated_at")
  };
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

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SpellError(`missing '${key}' string`);
  }
  return value.trim();
}
