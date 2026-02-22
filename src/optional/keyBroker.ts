import { readFile } from "node:fs/promises";
import { SpellError } from "../util/errors";

export interface KeyBrokerConnectorRecord {
  token: string;
  scopes?: string[];
}

export interface KeyBrokerTenantRecord {
  connectors: Record<string, KeyBrokerConnectorRecord>;
}

export interface KeyBrokerStoreV1 {
  version: "v1";
  tenants: Record<string, KeyBrokerTenantRecord>;
}

export interface ResolveConnectorTokenInput {
  tenantId: string;
  connector: string;
}

export interface ResolvedConnectorToken {
  tenant_id: string;
  connector: string;
  token: string;
  scopes: string[];
}

export async function loadKeyBrokerStore(filePath: string): Promise<KeyBrokerStoreV1> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new SpellError(`failed to read key broker store '${filePath}': ${(error as Error).message}`);
  }
  return parseKeyBrokerStore(raw, filePath);
}

export function parseKeyBrokerStore(raw: string, source: string): KeyBrokerStoreV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpellError(`invalid key broker store JSON (${source}): ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpellError("invalid key broker store: expected JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== "v1") {
    throw new SpellError(`invalid key broker store: unsupported version '${String(obj.version ?? "")}'`);
  }
  if (!obj.tenants || typeof obj.tenants !== "object" || Array.isArray(obj.tenants)) {
    throw new SpellError("invalid key broker store: tenants must be an object");
  }

  const tenants = obj.tenants as Record<string, unknown>;
  const normalizedTenants: Record<string, KeyBrokerTenantRecord> = {};

  for (const [tenantIdRaw, tenantRecord] of Object.entries(tenants)) {
    const tenantId = tenantIdRaw.trim();
    if (!tenantId) {
      throw new SpellError("invalid key broker store: tenant id must be non-empty");
    }
    if (!tenantRecord || typeof tenantRecord !== "object" || Array.isArray(tenantRecord)) {
      throw new SpellError(`invalid key broker store: tenant '${tenantId}' must be an object`);
    }

    const connectorsValue = (tenantRecord as Record<string, unknown>).connectors;
    if (!connectorsValue || typeof connectorsValue !== "object" || Array.isArray(connectorsValue)) {
      throw new SpellError(`invalid key broker store: tenant '${tenantId}' connectors must be an object`);
    }

    const connectors: Record<string, KeyBrokerConnectorRecord> = {};
    for (const [connectorRaw, connectorRecord] of Object.entries(connectorsValue as Record<string, unknown>)) {
      const connector = normalizeConnectorName(connectorRaw);
      if (!connectorRecord || typeof connectorRecord !== "object" || Array.isArray(connectorRecord)) {
        throw new SpellError(
          `invalid key broker store: tenant '${tenantId}' connector '${connector}' must be an object`
        );
      }
      const token = String((connectorRecord as Record<string, unknown>).token ?? "").trim();
      if (!token) {
        throw new SpellError(
          `invalid key broker store: tenant '${tenantId}' connector '${connector}' token must be non-empty`
        );
      }
      const scopesValue = (connectorRecord as Record<string, unknown>).scopes;
      let scopes: string[] = [];
      if (scopesValue !== undefined) {
        if (!Array.isArray(scopesValue)) {
          throw new SpellError(
            `invalid key broker store: tenant '${tenantId}' connector '${connector}' scopes must be an array`
          );
        }
        scopes = scopesValue
          .map((scope) => String(scope).trim())
          .filter((scope) => scope.length > 0);
      }

      connectors[connector] = { token, scopes };
    }

    normalizedTenants[tenantId] = { connectors };
  }

  return {
    version: "v1",
    tenants: normalizedTenants
  };
}

export function resolveConnectorToken(
  store: KeyBrokerStoreV1,
  input: ResolveConnectorTokenInput
): ResolvedConnectorToken | null {
  const connector = normalizeConnectorName(input.connector);
  const requestedTenant = input.tenantId.trim() || "default";
  const candidateTenants = [requestedTenant, "default"];

  for (const tenantId of candidateTenants) {
    const tenant = store.tenants[tenantId];
    if (!tenant) {
      continue;
    }
    const record = tenant.connectors[connector];
    if (!record) {
      continue;
    }
    return {
      tenant_id: tenantId,
      connector,
      token: record.token,
      scopes: [...(record.scopes ?? [])]
    };
  }

  return null;
}

function normalizeConnectorName(value: string): string {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    throw new SpellError("connector must be non-empty");
  }
  return normalized;
}
