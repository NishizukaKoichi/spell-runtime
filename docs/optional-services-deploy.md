# Optional Services Deploy Runbook

This runbook covers local/prod-like deployment for optional sidecars:

- Spell requires Key (`8788`)
- Spell Market (`8789`)
- Billing Entitlement Issuer (`8790`)

The core runtime API (`8787`) is included for end-to-end flow.

## 1. Prepare local data

From repo root:

```bash
mkdir -p .local-spell/market .local-spell/billing
cp examples/optional/spell-requires-key.v1.example.json .local-spell/spell-requires-key.v1.json
cp examples/optional/market-catalog.v1.example.json .local-spell/market/catalog.v1.json
```

Generate billing issuer keypair and register trust key for verification:

```bash
spell sign keygen spell-runtime-market --key-id default --out-dir .local-spell/billing
mv .local-spell/billing/spell-runtime-market__default.private.pem .local-spell/billing/issuer.private.pem
spell trust add spell-runtime-market "$(cat .local-spell/billing/spell-runtime-market__default.public.b64url.txt)" --key-id default
```

## 2. Configure environment

```bash
cp env.optional.example .env.optional
```

Set secrets in `.env.optional` if required:

- `SPELL_REQUIRES_KEY_API_TOKEN`
- `SPELL_BILLING_API_TOKEN`

## 3. Start with Docker Compose

```bash
docker compose -f compose.optional-services.yml --env-file .env.optional up --build -d
```

Logs:

```bash
docker compose -f compose.optional-services.yml logs -f
```

Stop:

```bash
docker compose -f compose.optional-services.yml down
```

## 4. Smoke checks

```bash
curl -fsS http://127.0.0.1:8787/ >/dev/null
curl -fsS http://127.0.0.1:8788/health
curl -fsS http://127.0.0.1:8789/health
curl -fsS http://127.0.0.1:8790/health
```

Key resolver:

```bash
curl -sS http://127.0.0.1:8788/v1/resolve-token \
  -H "Authorization: Bearer ${SPELL_REQUIRES_KEY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"team_a","connector":"github"}'
```

Market query:

```bash
curl -sS "http://127.0.0.1:8789/v1/spells?query=deploy&latest=true&limit=10"
```

Billing issue:

```bash
curl -sS http://127.0.0.1:8790/v1/entitlements/issue \
  -H "Authorization: Bearer ${SPELL_BILLING_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"mode":"on_success","currency":"USD","max_amount":25,"ttl_seconds":3600}'
```
