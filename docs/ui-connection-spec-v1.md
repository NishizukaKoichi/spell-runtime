# Spell Runtime v1 UI Connection Spec

## 1. Objective
Define a decision-complete integration contract that binds a UI button to a reproducible `spell cast` execution.

This spec is for the integration layer around the existing CLI runtime.

## 2. Non-goals
- Add new runtime features to `spell` CLI.
- Introduce registry, signature enforcement, or billing execution.
- Implement Docker execution in v1.

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
5. UI shows result and can fetch detailed log via API.

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

See sample:
- `/Users/koichinishizuka/spell-runtime/examples/button-registry.v1.json`

## 6. Execution API Contract
## 6.0 Discovery and UI endpoints
- `GET /api/buttons`
- `GET /api/spell-executions` (query: `status`, `button_id`, `limit`)
- `GET /api/spell-executions/:execution_id`
- `GET /` (minimal receipts UI)
- `GET /ui/app.js` (UI client script)

## 6.1 POST /api/spell-executions
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

Execution list state is persisted at `~/.spell/logs/index.json` so lists survive API restarts.
When API auth is enabled, all `/api/*` endpoints require `Authorization: Bearer <token>` (or `x-api-key`).

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
- `missing connector token ...` -> `CONNECTOR_TOKEN_MISSING`
- `platform mismatch: ...` -> `PLATFORM_UNSUPPORTED`
- `spell not installed: ...` -> `SPELL_NOT_INSTALLED`
- `version not installed ...` -> `SPELL_VERSION_NOT_INSTALLED`
- `input does not match schema ...` -> `INPUT_SCHEMA_INVALID`

## 10. UI/UX Minimum
- Button click opens confirmation dialog when guard flags apply.
- Show execution summary before final confirm (spell id/version, risk, billing, effects).
- On success, show `execution_id` and link to detail view.
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
- Add workflow status stream (SSE/WebSocket).
- Add runtime host pool routing by platform.
- Add signed spell bundles when v2 policy is ready.
