# Spell Runtime v1 UI Connection Spec

## 1. Objective
Define a decision-complete integration contract that binds a UI button to a reproducible `spell cast` execution.

This spec is for the integration layer around the existing CLI runtime.

## 2. Non-goals
- Add new runtime features to `spell` CLI.
- Introduce billing execution.
- Add Docker-specific orchestration policy in the UI layer.

## 3. Done Definition (Integration)
A button can safely execute a registered spell with the following behavior:
- deterministic mapping: `button_id -> spell id/version`
- input assembly and schema validation via `spell cast`
- guard policies are explicit (`risk`, `billing`, `permissions`, `platform`)
- execution result and logs can be shown in UI
- failures return actionable error messages

## 4. Architecture
1. User clicks a button in UI.
2. Backend resolves `button_id` from registry.
3. Backend constructs and runs `spell cast ...`.
4. Backend parses `execution_id` and log file path from stdout.
5. UI shows result and subscribes to execution events for live status updates.

Recommended boundary:
- UI: intent + confirmation UX
- Backend: authorization + guard decisions + command execution
- Spell runtime: bundle validation + execution + logging

## 5. Button Registry Contract
Store a static allowlist in backend (JSON, DB, or config service).

Required fields:
- `button_id`: unique key used by UI
- `spell_id`: logical spell id (`publisher/spell` style is allowed)
- `version`: pinned spell version
- `defaults`: default input object
- `required_confirmations`: object with booleans:
  - `risk`: if true, request must include risk confirmation
  - `billing`: if true, request must include billing confirmation
- `allowed_roles`: array of role names

Optional fields:
- `label`: display text
- `description`
- `owners`
- `require_signature`: boolean, when true backend adds `--require-signature`
  - when false/omitted backend can opt into `--allow-unsigned`
  - if backend sets `SPELL_API_FORCE_REQUIRE_SIGNATURE=true`, this field is ignored and signature is always required
- `allowed_tenants`: tenant id allowlist for this button
  - when present, backend only accepts requests from those auth-derived tenant ids
  - when omitted, button is available to all tenants

See sample:
- `/Users/koichinishizuka/spell-runtime/examples/button-registry.v1.json`

## 6. Execution API Contract
## 6.0 Discovery and UI endpoints
- `GET /api/buttons`
- `GET /api/spell-executions` (query: `status`, `button_id`, `spell_id`, `tenant_id`, `limit`, `from`, `to`)
- `GET /api/spell-executions/events` (SSE list stream with same query filters)
- `GET /api/spell-executions/:execution_id`
- `GET /api/spell-executions/:execution_id/events` (SSE stream: `snapshot`/`execution`/`terminal`)
- `GET /api/spell-executions/:execution_id/output?path=step.<name>.(stdout|json[.dot.path])`
- `POST /api/spell-executions/:execution_id/cancel`
- `POST /api/spell-executions/:execution_id/retry`
- `GET /` (minimal receipts UI)
- `GET /ui/app.js` (UI client script)

## 6.1 POST /api/spell-executions
Headers:
- Optional `Idempotency-Key` (case-insensitive)
  - server trims value
  - must be printable ASCII
  - trimmed length must be `1..128`

Request body:
```json
{
  "button_id": "publish_site_high_risk",
  "dry_run": false,
  "input": {
    "site_name": "demo"
  },
  "actor_role": "admin",
  "confirmation": {
    "risk_acknowledged": true,
    "billing_acknowledged": false
  }
}
```

Response (accepted, async):
```json
{
  "ok": true,
  "execution_id": "exec_1739320000000_ab12cd34",
  "status": "queued"
}
```

Response (accepted, idempotent replay):
```json
{
  "ok": true,
  "execution_id": "exec_1739320000000_ab12cd34",
  "status": "running",
  "idempotent_replay": true
}
```

Response (idempotency conflict):
```json
{
  "ok": false,
  "error_code": "IDEMPOTENCY_CONFLICT",
  "message": "idempotency key already used with a different request"
}
```

Response (failure):
```json
{
  "ok": false,
  "error_code": "RISK_CONFIRMATION_REQUIRED",
  "message": "risk high requires --yes"
}
```

## 6.2 GET /api/spell-executions/:execution_id
Returns execution summary and sanitized receipt (no raw stdout/stderr).
Execution summary includes retry linkage fields:
- `retry_of` (set on retried executions)
- `retried_by` (set on source execution to newest retry id)

Execution status values:
- `queued`
- `running`
- `succeeded`
- `failed`
- `timeout`
- `canceled`

## 6.2.0 GET /api/spell-executions/events
Streams execution list updates as server-sent events using the same filters as `GET /api/spell-executions`.

Event sequence:
- `snapshot`: initial list payload
- `executions`: changed list payloads

Tenant/auth behavior:
- follows same auth and tenant scoping policy as list API
- with auth keys, non-admin cross-tenant filters return `403 TENANT_FORBIDDEN`

## 6.2.1 GET /api/spell-executions/:execution_id/events
Streams execution updates as server-sent events.

Event sequence:
- `snapshot`: immediate current state
- `execution`: sent when status/receipt changes
- `terminal`: sent on terminal status, then connection closes

UI usage guideline:
- open the stream when viewing `queued`/`running` executions
- update detail panel from streamed payloads
- stop stream on `terminal` event or when user changes selected execution

Tenant/auth behavior:
- follows same auth policy as other `/api` routes
- with auth keys, non-admin cross-tenant stream requests return `403 TENANT_FORBIDDEN`

## 6.2.2 GET /api/spell-executions/:execution_id/output
Returns one resolved output value from the runtime log.

Query:
- `path` (required): output reference
  - `step.<stepName>.stdout`
  - `step.<stepName>.json`
  - `step.<stepName>.json.<dot.path>`

Errors:
- `400 INVALID_QUERY` when `path` is missing
- `400 INVALID_OUTPUT_PATH` when `path` format is invalid
- `404 OUTPUT_NOT_FOUND` when output/path is not present
- `404 EXECUTION_NOT_FOUND` when execution does not exist
- `409 EXECUTION_NOT_READY` when execution has no runtime log yet
- `403 TENANT_FORBIDDEN` for cross-tenant access when auth keys are enabled

## 6.3 POST /api/spell-executions/:execution_id/cancel
Cancels queued/running executions.

Behavior:
- unknown `execution_id`: `404 EXECUTION_NOT_FOUND`
- queued: mark execution `canceled` immediately
- running: terminate child process and mark execution `canceled`
- already terminal (`succeeded`/`failed`/`timeout`/`canceled`): `409 ALREADY_TERMINAL`
- when auth keys are enabled, non-admin keys cannot cancel other tenant jobs (`403 TENANT_FORBIDDEN`)

## 6.4 POST /api/spell-executions/:execution_id/retry
Retries terminal executions in retryable states.

Behavior:
- unknown `execution_id`: `404 EXECUTION_NOT_FOUND`
- allowed source states: `failed` / `timeout` / `canceled`
- non-retryable source states (`queued` / `running` / `succeeded`): `409 NOT_RETRYABLE`
- creates a new execution with a new `execution_id` using the original button/input/flags/tenant/role semantics
- writes retry linkage:
  - new execution: `retry_of=<source_execution_id>`
  - source execution: `retried_by=<new_execution_id>` (latest retry wins)
- when auth keys are enabled, non-admin keys cannot retry other tenant jobs (`403 TENANT_FORBIDDEN`)

Execution list state is persisted at `~/.spell/logs/index.json` so lists survive API restarts.
Idempotency key mappings for executions are persisted in that same index file and survive API restarts.
Retry linkage (`retry_of`, `retried_by`) is persisted in the same index and restored on restart.
When API auth is enabled, all `/api/*` endpoints require `Authorization: Bearer <token>` (or `x-api-key`).
Recommended auth configuration uses `SPELL_API_AUTH_KEYS` (role-bound keys) so UI cannot self-assert `actor_role`.

## 7. Command Construction Rules
Given registry entry and request:
1. Resolve spell id/version from `button_id`.
   - reject unknown `button_id`
   - ignore client-provided `spell_id`
2. Build merged input: `merged = deepMerge(defaults, request.input)`.
3. Write merged input to temp JSON file.
4. Build command:
   - base: `spell cast <spell_id> --version <version> --input <temp.json>`
   - add `--dry-run` when request asks dry run
   - add `--yes` only when policy and confirmation are satisfied
   - add `--allow-billing` only when policy and confirmation are satisfied
   - add `--require-signature` when `require_signature=true`
   - if `SPELL_API_FORCE_REQUIRE_SIGNATURE=true`, always add `--require-signature`
   - otherwise add `--allow-unsigned` only when registry policy allows unsigned path
5. Execute with `shell=false`.
6. Parse stdout lines:
   - `execution_id: ...`
   - `log: ...`
7. Map runtime output to execution summary and sanitized receipt.

## 8. Guard Policy Mapping
### 8.1 risk guard
- If spell risk is `high` or `critical`, UI must require explicit confirmation.
- Backend appends `--yes` only after confirmation.

### 8.2 billing guard
- If billing-enabled spell is allowed by product policy, show confirmation with amount/currency context.
- Backend appends `--allow-billing` only after confirmation.

### 8.3 permissions guard
- Runtime requires `CONNECTOR_<NAME>_TOKEN` env vars.
- Integration must inject connector tokens in backend process environment.
- Never expose token values to UI or logs.

### 8.4 platform guard
- Runtime enforces host platform support.
- Integration should pre-check known platform and hide unsupported buttons where possible.

## 9. Error Mapping (Backend -> UI)
Map common stderr messages from runtime to stable API error codes:
- `risk high requires --yes` -> `RISK_CONFIRMATION_REQUIRED`
- `billing enabled requires --allow-billing` -> `BILLING_CONFIRMATION_REQUIRED`
- tenant is not in button allowlist -> `TENANT_NOT_ALLOWED`
- `signature required: ...` -> `SIGNATURE_REQUIRED`
- `missing connector token ...` -> `CONNECTOR_TOKEN_MISSING`
- `platform mismatch: ...` -> `PLATFORM_UNSUPPORTED`
- `spell not installed: ...` -> `SPELL_NOT_INSTALLED`
- `version not installed ...` -> `SPELL_VERSION_NOT_INSTALLED`
- `input does not match schema ...` -> `INPUT_SCHEMA_INVALID`
- `manual recovery required: compensation state=...` -> `COMPENSATION_INCOMPLETE`

## 10. UI/UX Minimum
- Button click opens confirmation dialog when guard flags apply.
- Show execution summary before final confirm (spell id/version, risk, billing, effects).
- On success, show `execution_id` and link to detail view.
- For `failed`/`timeout`/`canceled` executions, show a Retry action that calls `POST /api/spell-executions/:execution_id/retry`.
- In detail view, show retry linkage (`retry_of` / `retried_by`) as navigable links.
- On failure, show mapped message and a troubleshooting hint.

## 11. Operational Checklist
Before enabling a button in production:
1. `spell install` done on target host.
2. `spell inspect <id> --version <v>` reviewed.
3. `spell cast ... --dry-run` verified.
4. Required connector tokens provisioned.
5. Audit logging retention policy defined.

## 12. Minimal Backend Pseudocode
```ts
const entry = registry[button_id];
if (!entry) throw ApiError("BUTTON_NOT_FOUND");

const input = deepMerge(entry.defaults, request.input ?? {});
const inputFile = await writeTempJson(input);

const args = [
  "cast",
  entry.spell_id,
  "--version", entry.version,
  "--input", inputFile
];

if (request.dry_run) args.push("--dry-run");
if (entry.required_confirmations.risk && request.confirmation?.risk_acknowledged) args.push("--yes");
if (entry.required_confirmations.billing && request.confirmation?.billing_acknowledged) args.push("--allow-billing");
if (entry.require_signature) args.push("--require-signature");

const { code, stdout, stderr } = await runSpellCli(args);
if (code !== 0) return mapRuntimeError(stderr);

return parseExecution(stdout);
```

## 13. Security Constraints
- Never allow arbitrary `spell_id` from client without registry lookup.
- Never pass untrusted shell fragments to command line.
- Limit input payload size (v1 default: 64KB) and validate JSON type before writing temp file.
- Limit execution runtime (v1 default: 60s).
- Limit in-flight executions (v1 default: 4).
- Apply POST rate limiting (v1 minimal fixed-window limiter).
- Use per-request temp file and delete after execution when possible.
- Ensure backend logs redact secret keys and env-derived sensitive values.
- Apply retention policy to audit logs (age-based and/or max-files based).

## 14. Future Extension Hooks
- Add queue/async job mode for long-running spells.
- Add workflow status stream over WebSocket (SSE route is available).
- Add runtime host pool routing by platform.
- Add trust/sign key management UI flows for operator onboarding.
