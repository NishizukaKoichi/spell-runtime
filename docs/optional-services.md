# Optional Services (Out of Runtime Scope)

This document defines optional sidecars for operators who want to provide platform services around `spell-runtime`.

These components are not required to run `spell` itself.

## 1. Spell requires Key

Local dev:

```bash
npm run optional:key:dev
```

Environment variables:

- `SPELL_REQUIRES_KEY_PORT` (default `8788`)
- `SPELL_REQUIRES_KEY_API_TOKEN` (optional bearer token)
- `SPELL_REQUIRES_KEY_STORE_PATH` (default `~/.spell/spell-requires-key.v1.json`)

Store file format (`v1`):

```json
{
  "version": "v1",
  "tenants": {
    "default": {
      "connectors": {
        "github": { "token": "ghp_xxx", "scopes": ["repo"] }
      }
    },
    "team_a": {
      "connectors": {
        "cloudflare": { "token": "cf_xxx", "scopes": ["workers.write"] }
      }
    }
  }
}
```

API:

- `GET /health`
- `POST /v1/resolve-token`
  - request: `{ "tenant_id": "team_a", "connector": "github" }`
  - response: `{ "tenant_id": "...", "connector": "...", "token": "...", "scopes": [...] }`

Resolution rule:

- first lookup `tenant_id`
- fallback to `default` tenant

## 2. Spell Market

Local dev:

```bash
npm run optional:market:dev
```

Environment variables:

- `SPELL_MARKET_PORT` (default `8789`)
- `SPELL_MARKET_CATALOG_PATH` (default `~/.spell/market/catalog.v1.json`)

Catalog file format (`v1`):

```json
{
  "version": "v1",
  "spells": [
    {
      "id": "samples/call-webhook",
      "version": "1.1.0",
      "name": "Call Webhook",
      "summary": "Send webhook for deploy notification",
      "publisher": "samples",
      "risk": "low",
      "source": "registry:samples/call-webhook@1.1.0",
      "tags": ["webhook", "deploy"]
    }
  ]
}
```

API:

- `GET /health`
- `GET /v1/spells?query=<text>&publisher=<name>&risk=<risk>&tag=<tag>&latest=true&limit=20`
- `GET /v1/spells/<id>/versions`

Notes:

- `latest=true` returns one latest version per spell id
- `limit` range is `1..200`

## 3. Billing Entitlement Issuer

Local dev:

```bash
npm run optional:billing:dev
```

Environment variables:

- `SPELL_BILLING_PORT` (default `8790`)
- `SPELL_BILLING_ISSUER` (required)
- `SPELL_BILLING_KEY_ID` (default `default`)
- `SPELL_BILLING_PRIVATE_KEY_PATH` (default `~/.spell/billing/issuer.private.pem`)
- `SPELL_BILLING_API_TOKEN` (optional bearer token)

API:

- `GET /health`
- `POST /v1/entitlements/issue`
  - request:
    - required: `mode`, `currency`, `max_amount`
    - optional: `ttl_seconds`, `not_before`, `expires_at`
  - response: `{ "token": "ent1....", "claims": { ... } }`

Issue request example:

```json
{
  "mode": "on_success",
  "currency": "USD",
  "max_amount": 25,
  "ttl_seconds": 3600
}
```

The issuer signs `ent1.<payloadBase64url>.<signatureBase64url>` using the configured private key.
