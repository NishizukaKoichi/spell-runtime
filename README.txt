Spell Runtime v1

Minimal CLI runtime for SpellBundle v1.

1. Setup
- Node.js >= 20
- pnpm (recommended)
- npm (supported)

Install dependencies:
  pnpm install

Build:
  pnpm run build

Test:
  pnpm test

Local dev:
  pnpm run dev -- --help

Binary smoke checks:
  npm run smoke:link
  npm run smoke:npx

Manual link:
  npm link
  spell --help

Manual npx (local package):
  npx --yes --package file:. spell --help

2. CLI commands
- spell install <source>
- spell registry set <url>
- spell registry show
- spell registry add <name> <url>
- spell registry remove <name>
- spell registry validate [--name <name>]
- spell policy show
- spell policy validate --file <path>
- spell policy set --file <path>
- spell list
- spell inspect <id> [--version x.y.z]
- spell cast <id> [--version x.y.z] [-p key=value ...] [--input input.json] [--dry-run] [--yes] [--allow-billing] [--allow-unsigned] [--require-signature] [--verbose] [--profile <name>]
- spell license add <name> <entitlement-token>
- spell license list
- spell license inspect <name>
- spell license revoke <name> [--reason <text>]
- spell license restore <name>
- spell license remove <name>
- spell sign keygen <publisher> [--key-id default] [--out-dir .spell-keys]
- spell sign bundle <local-path> --private-key <file> [--key-id default] [--publisher <name>]
- spell trust add <publisher> <public-key> [--key-id default]
- spell trust list
- spell trust inspect <publisher>
- spell trust revoke-key <publisher> --key-id <id> [--reason <text>]
- spell trust restore-key <publisher> --key-id <id>
- spell trust remove-key <publisher> --key-id <id>
- spell trust remove <publisher>
- spell log <execution-id>

2.1 Install sources
- spell install <source> accepts:
  - local bundle paths (existing behavior)
  - registry locators with explicit id+version:
    - registry:<id>@<version>
  - pinned git URLs with explicit refs:
    - https://...#<ref>
    - ssh://...#<ref>
    - git@...#<ref>

Git sources must include #<ref>. If omitted, install fails with:
  git source requires explicit ref (#<ref>)

When a git source is provided, runtime clones the repository, checks out the requested ref, resolves the checked-out commit SHA (git rev-parse HEAD), and installs from that checkout.

For registry installs, each index entry may include pins:
- commit (40-char SHA-1): compares cloned HEAD commit (case-insensitive).
- digest (sha256:<64-hex>): compares canonical bundle digest from the resolved source root (case-insensitive).

Required pin policy is controlled by SPELL_REGISTRY_REQUIRED_PINS:
- none: do not require commit/digest presence.
- commit: require commit.
- digest: require digest.
- both: require both commit and digest (default).

When a required pin is missing, install fails with:
  registry entry missing required commit pin for <id>@<version>
  registry entry missing required digest pin for <id>@<version>

When present, mismatch still fails with:
  registry commit mismatch: expected <expected>, got <actual>
  registry digest mismatch: expected <expected>, got <actual>

Registry setup example:
  spell registry set https://registry.example.test/spell-index.v1.json
  spell registry add mirror https://registry-mirror.example.test/spell-index.v1.json
  spell registry show
  spell registry validate
  spell registry validate --name mirror
  spell install registry:fixtures/hello-host@1.0.0

Registry index management rules:
- index name must be non-empty after trimming and unique.
- spell registry remove default is rejected; default index removal is intentionally blocked.
- spell registry validate fetches configured indexes and prints one success line per index:
  <name>\t<url>\t<spell-count>
- validation failures exit non-zero with a clear reason.

Registry config file (~/.spell/registry.json):
{
  "version": "v1",
  "indexes": [{ "name": "default", "url": "https://registry.example.test/spell-index.v1.json" }]
}

Minimal registry index schema:
{
  "version": "v1",
  "spells": [
    {
      "id": "fixtures/hello-host",
      "version": "1.0.0",
      "source": "https://spell.test/hello-host.git#main",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}

Limitations:
- git must be installed and available on PATH.
- clone/auth/network behavior is delegated to your local git configuration.
- spell.yaml must exist at the cloned repository root (subdirectory installs are not supported).

3. Storage layout
- Spells: ~/.spell/spells/<id_key>/<version>/
- ID index: ~/.spell/spells/<id_key>/spell.id.txt
- Install provenance: ~/.spell/spells/<id_key>/<version>/source.json
- Logs: ~/.spell/logs/<timestamp>_<id>_<version>.json
- Billing entitlement records: ~/.spell/licenses/*.json

source.json captures install provenance:
- type: local or git
- source: original install input
- ref: requested git ref (git installs only)
- commit: resolved git commit SHA (git installs only)
- installed_at: install timestamp (ISO-8601)

id_key is fixed as base64url(utf8(id)).
- id is the logical identifier (display, package identity).
- id_key is only for safe filesystem storage.

Consistency rule:
- install checks spell.yaml id against spell.id.txt when spell.id.txt already exists.
- mismatch is treated as an error.

4. Cast preflight (always)
Cast performs these checks before execution:
- Bundle resolution by id (and optional version)
- Input assembly (--input + -p overrides)
- JSON Schema validation by Ajv
- Signature verification (default on; bypass only with --allow-unsigned)
- Runtime policy guard (~/.spell/policy.json)
- Platform guard
- Risk guard (high/critical requires --yes)
- Billing guard (billing.enabled requires --allow-billing)
- Billing entitlement guard (billing.enabled + --allow-billing requires a matching valid, non-revoked entitlement from spell license add ...)
- Connector token guard (CONNECTOR_<NAME>_TOKEN)
- Execution summary output

If --dry-run is set, command exits after summary and validation.

Policy file format (~/.spell/policy.json):
{
  "version": "v1",
  "default": "allow",
  "publishers": { "allow": ["samples"], "deny": ["blocked"] },
  "max_risk": "high",
  "runtime": { "allow_execution": ["host", "docker"] },
  "effects": {
    "allow_types": ["notify", "deploy"],
    "deny_types": ["delete"],
    "deny_mutations": false
  }
}

Notes:
- missing policy file => allow by default
- invalid policy file => invalid policy: ...
- policy rejection => policy denied: <reason>
- effects.deny_mutations=true denies any spell effect with mutates=true
- effects.allow_types denies any spell effect type not listed
- effects.deny_types denies listed effect types and takes precedence over effects.allow_types

Policy management commands:
- spell policy show prints current policy JSON; if missing, it prints a clear message and exits 0.
- spell policy validate --file <path> validates a candidate file and prints policy valid on success.
- spell policy set --file <path> validates and writes normalized JSON to ~/.spell/policy.json.

4.1 Runtime safety limits (v2 isolation)
cast enforces these runtime limits (for direct CLI casts and API-triggered casts, because the API invokes spell cast):
- SPELL_RUNTIME_INPUT_MAX_BYTES (default 65536): max bytes for merged cast input (--input + -p overrides)
- SPELL_RUNTIME_STEP_TIMEOUT_MS (default 60000): max runtime per shell step; timed out step process is killed and cast fails with step name + timeout ms
- SPELL_RUNTIME_EXECUTION_TIMEOUT_MS (default disabled): max total cast runtime when set to an integer > 0 (enforced in host and docker paths)

5. Runtime model
v1 supports:
- host: steps run in order, shell/http supported.
- docker: steps run in a linux container via "runner-in-image".

Docker mode (v1) details:
- runtime.execution=docker requires runtime.docker_image.
- the image must provide spell-runner on PATH (this repo publishes it as a second npm bin).
- the bundle is mounted read-only at /spell; the runner copies it into a writable temp workdir before executing steps.
- hardened docker run defaults:
  - --network none
  - --cap-drop ALL
  - --security-opt no-new-privileges
  - --read-only
  - --user 65532:65532
  - --pids-limit 256
  - --tmpfs /tmp:rw,noexec,nosuid,size=64m
- hardening env overrides (all optional):
  - SPELL_DOCKER_NETWORK (none|bridge|host, default none)
  - SPELL_DOCKER_USER (default 65532:65532; set empty to disable --user)
  - SPELL_DOCKER_READ_ONLY (1 default; set 0 to disable --read-only)
  - SPELL_DOCKER_PIDS_LIMIT (256 default; set 0 to disable --pids-limit)
  - SPELL_DOCKER_MEMORY (default empty; when set adds --memory)
  - SPELL_DOCKER_CPUS (default empty; when set adds --cpus)
- env vars passed from host -> container are restricted to connector tokens (CONNECTOR_<NAME>_TOKEN) plus SPELL_RUNTIME_STEP_TIMEOUT_MS.

6. Windows policy
- host mode does not assume bash/sh.
- shell step expects executable files (.js/.exe/.cmd/.ps1 etc).
- process spawn uses shell=false.
- for strict cross-OS reproducibility, docker mode is the long-term recommended path.

7. Effects vocabulary (recommended)
Use these effect.type words where possible:
- create
- update
- delete
- deploy
- notify

8. v1 limitations (intentionally not implemented)
- name search or ambiguous resolution (id only)
- registry discovery/marketplace UX integration
- real billing execution (Stripe)
- DAG/parallel/rollback/self-healing
- advanced templating language (only {{INPUT.*}} and {{ENV.*}})
- docker env passthrough beyond connector tokens and SPELL_RUNTIME_STEP_TIMEOUT_MS

8.1 Signature (sign + verify)
spell cast requires signature verification by default. To bypass this for unsigned bundle workflows:
  spell cast <id> --allow-unsigned ...

--require-signature remains accepted for backward compatibility.

Signing flow:
  spell sign keygen samples --key-id default --out-dir .spell-keys
  spell trust add samples <public_key_base64url> --key-id default
  spell sign bundle ./examples/spells/call-webhook --private-key .spell-keys/samples__default.private.pem --key-id default

Trust store:
- spell trust add <publisher> <public-key>
- spell trust list
- spell trust inspect <publisher>
- spell trust revoke-key <publisher> --key-id <id> [--reason <text>]
- spell trust restore-key <publisher> --key-id <id>
- spell trust remove-key <publisher> --key-id <id>
- spell trust remove <publisher>

Notes:
- publisher is derived from the spell id prefix before the first / (example: samples/call-webhook -> samples).
- public key format is ed25519 spki DER encoded as base64url.
- spell trust inspect prints one row per key with key_id, status, algorithm, and a shortened public key fingerprint.
- spell trust list prints one row per key with status (active or revoked).
- spell trust remove-key removes only one key; if it removes the publisher's last key, the publisher trust file is deleted.
- revoked keys remain in the trust record and are ignored by signature verification until restored.

8.2 Entitlement tokens (billing)
spell license add <name> <token> now validates and stores signed entitlement tokens.
Each successful validation writes last_validated_at for audit tracking.

Lifecycle operations:
- spell license inspect <name> prints issuer/mode/currency/max_amount/window/revoked
- spell license revoke <name> [--reason <text>] sets revoked=true for that record
- spell license restore <name> clears revocation and allows matching again

Token format:
- ent1.<payloadBase64url>.<signatureBase64url>

Payload JSON required fields:
- version ("v1")
- issuer (string)
- key_id (string)
- mode ("upfront" | "on_success" | "subscription")
- currency (string)
- max_amount (number)
- not_before (ISO string)
- expires_at (ISO string)

Verification rules:
- signature algorithm: ed25519
- signed message: raw payload segment bytes (exact payload base64url segment string bytes)
- trust source: publisher trust store (spell trust add ...) keyed by issuer + key_id
- token must be within not_before <= now <= expires_at

Billing-enabled cast requires a matching currently-valid entitlement:
- entitlement record is not revoked
- entitlement mode equals manifest.billing.mode
- entitlement currency equals manifest.billing.currency (case-insensitive)
- entitlement max_amount >= manifest.billing.max_amount

spell license list prints entitlement summary columns (issuer/mode/currency/max_amount/expires_at/revoked) and does not print raw tokens.

9. Example flow
1) Install a local fixture
  spell install ./fixtures/spells/hello-host

2) List installed spells
  spell list

3) Inspect by id
  spell inspect fixtures/hello-host

4) Dry run cast
  spell cast fixtures/hello-host --dry-run -p name=world

5) Execute cast
  spell cast fixtures/hello-host -p name=world

6) Show execution log
  spell log <execution-id>

9.1 OSS release (pnpm + GitHub Actions)
Automation file:
  .github/workflows/release.yml

Prerequisites:
- npm account with 2FA enabled
- GitHub repository secret NPM_TOKEN (publish-capable npm token)

Local release checks:
  pnpm install
  pnpm run typecheck
  pnpm run lint
  pnpm run build
  pnpm test
  pnpm run pack:check

Tag-based release flow:
  npm version patch
  git push --follow-tags

Tag push vX.Y.Z triggers GitHub Actions release and runs npm publish.
The workflow verifies that tag version matches package.json.

10. UI connection spec
- Decision-complete button integration spec:
  /Users/koichinishizuka/spell-runtime/docs/ui-connection-spec-v1.md
- Sample button registry:
  /Users/koichinishizuka/spell-runtime/examples/button-registry.v1.json
- Button registry schema:
  /Users/koichinishizuka/spell-runtime/examples/button-registry.v1.schema.json
- Registry optional policy:
  require_signature=true: Execution API enforces signature (--require-signature)
  require_signature=false or omitted: Execution API opts into unsigned path (--allow-unsigned)
  SPELL_API_FORCE_REQUIRE_SIGNATURE=true overrides per-button policy and enforces signature for all API executions
  allowed_tenants: optional tenant id allowlist per button
  when allowed_tenants is set, POST /api/spell-executions returns 403 TENANT_NOT_ALLOWED for non-listed tenants

11. Install from npm
Global install:
  npm i -g spell-runtime
  spell --help

Run with npx:
  npx --yes --package spell-runtime spell --help

12. Real-use sample spells
- /Users/koichinishizuka/spell-runtime/examples/spells/call-webhook
- /Users/koichinishizuka/spell-runtime/examples/spells/repo-ops
- /Users/koichinishizuka/spell-runtime/examples/spells/publish-site

Quick try:
  spell install ./examples/spells/call-webhook
  spell inspect samples/call-webhook
  spell cast samples/call-webhook --dry-run -p event=deploy -p source=manual -p payload='{"service":"web"}'

13. Runtime decision log
- /Users/koichinishizuka/spell-runtime/docs/runtime-decisions-v1.md

13.1 Repository policies
- /Users/koichinishizuka/spell-runtime/CONTRIBUTING.md
- /Users/koichinishizuka/spell-runtime/CODE_OF_CONDUCT.md
- /Users/koichinishizuka/spell-runtime/SECURITY.md

14. Execution API (async)
Start:
  npm run api:dev

Defaults:
- listens on :8787
- reads registry: ./examples/button-registry.v1.json
- limits:
  - request body: 64KB
  - execution timeout: 60s
  - tenant POST rate: 20/60s
  - in-flight executions: 4
  - in-flight executions per tenant: 2
- execution index persistence: ~/.spell/logs/index.json
- tenant audit log: ~/.spell/logs/tenant-audit.jsonl
- routes:
  GET /
  GET /ui/app.js
  GET /api/buttons (includes allowed_tenants for each button; null when unrestricted)
  GET /api/spell-executions (status/button_id/tenant_id/limit query supported)
  POST /api/spell-executions (supports optional Idempotency-Key header)
  GET /api/spell-executions/:execution_id
  POST /api/spell-executions/:execution_id/cancel
  POST /api/spell-executions/:execution_id/retry
  GET /api/tenants/:tenant_id/usage

Optional environment variables:
- SPELL_API_PORT
- SPELL_BUTTON_REGISTRY_PATH
- SPELL_API_AUTH_KEYS (comma-separated role=token or tenant:role=token entries; when set, /api/* requires auth and derives actor_role + tenant_id from token)
- SPELL_API_AUTH_TOKENS (legacy: comma-separated tokens; when set, /api/* requires auth but does not bind role)
- SPELL_API_FORCE_REQUIRE_SIGNATURE (default false; when true, API ignores per-button unsigned policy and always appends --require-signature)
- SPELL_API_BODY_LIMIT_BYTES
- SPELL_API_EXECUTION_TIMEOUT_MS
- SPELL_API_RATE_LIMIT_WINDOW_MS
- SPELL_API_RATE_LIMIT_MAX_REQUESTS
- SPELL_API_TENANT_RATE_LIMIT_WINDOW_MS (default 60000)
- SPELL_API_TENANT_RATE_LIMIT_MAX_REQUESTS (default 20)
- SPELL_API_MAX_CONCURRENT_EXECUTIONS
- SPELL_API_TENANT_MAX_CONCURRENT_EXECUTIONS (default 2)
- SPELL_API_LOG_RETENTION_DAYS (default 14, 0 disables age-based pruning)
- SPELL_API_LOG_MAX_FILES (default 500, 0 disables count-based pruning)

Security note:
- execution logs redact secret-like keys (token, authorization, apiKey, etc.)
- environment-derived secret values are masked in persisted logs
- tenant audit events (queued/running/succeeded/failed/timeout/canceled) are appended as JSONL records to ~/.spell/logs/tenant-audit.jsonl
- POST /api/spell-executions accepts optional Idempotency-Key (printable ASCII, trimmed length 1..128)
- idempotency scope is tenant_id + idempotency_key; replay with same effective request returns existing execution with idempotent_replay: true
- reuse of the same idempotency key with a different effective request returns 409 IDEMPOTENCY_CONFLICT
- POST /api/spell-executions/:execution_id/cancel marks queued/running jobs as canceled; terminal states (succeeded/failed/timeout/canceled) return 409 ALREADY_TERMINAL
- POST /api/spell-executions/:execution_id/retry allows retrying only failed/timeout/canceled executions; other states return 409 NOT_RETRYABLE
- retry creates a new execution_id and links executions via retry_of (new execution) and retried_by (source execution); list/detail payloads include both fields
- when auth is enabled, pass Authorization: Bearer <token> (or x-api-key) for /api routes
- with SPELL_API_AUTH_KEYS, non-admin list requests are restricted to their own tenant and cross-tenant tenant_id filters return 403 (TENANT_FORBIDDEN)
- with SPELL_API_AUTH_KEYS, non-admin cancel requests are restricted to their own tenant (403 TENANT_FORBIDDEN for cross-tenant)
- with SPELL_API_AUTH_KEYS, non-admin retry requests are restricted to their own tenant (403 TENANT_FORBIDDEN for cross-tenant)
- with SPELL_API_AUTH_KEYS, GET /api/tenants/:tenant_id/usage requires an admin key
- do not set both SPELL_API_AUTH_KEYS and SPELL_API_AUTH_TOKENS at the same time
