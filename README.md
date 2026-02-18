# Spell Runtime v1

Minimal CLI runtime for SpellBundle v1.

## Setup

- Node.js >= 20
- npm

```bash
npm i
npm run build
npm test
```

Local dev:

```bash
npm run dev -- --help
```

## Install as CLI

Global install:

```bash
npm i -g spell-runtime
spell --help
```

Run with npx:

```bash
npx --yes --package spell-runtime spell --help
```

Local package smoke checks:

```bash
npm run smoke:link
npm run smoke:npx
```

## Commands

- `spell install <local-path>`
- `spell list`
- `spell inspect <id> [--version x.y.z]`
- `spell cast <id> [--version x.y.z] [-p key=value ...] [--input input.json] [--dry-run] [--yes] [--allow-billing] [--allow-unsigned] [--require-signature] [--verbose] [--profile <name>]`
- `spell license add <name> <token>`
- `spell license list`
- `spell license remove <name>`
- `spell sign keygen <publisher> [--key-id default] [--out-dir .spell-keys]`
- `spell sign bundle <local-path> --private-key <file> [--key-id default] [--publisher <name>]`
- `spell trust add <publisher> <public-key> [--key-id default]`
- `spell trust list`
- `spell trust remove <publisher>`
- `spell log <execution-id>`

## Install Sources

`spell install <local-path>` keeps the same CLI interface and now accepts:

- local bundle paths (existing behavior)
- git URLs:
  - `https://...`
  - `ssh://...`
  - `git@...`

When a git URL is provided, runtime performs a shallow clone (`git clone --depth 1`) into a temporary directory and installs from the cloned repository root.

Limitations:

- `git` must be installed and available on `PATH`.
- clone/auth/network behavior is delegated to your local `git` configuration.
- `spell.yaml` must exist at the cloned repository root (subdirectory installs are not supported).

## Storage Layout

- Spells: `~/.spell/spells/<id_key>/<version>/`
- ID index: `~/.spell/spells/<id_key>/spell.id.txt`
- Logs: `~/.spell/logs/<timestamp>_<id>_<version>.json`
- Billing license tokens: `~/.spell/licenses/*.json`

`id_key` is fixed as `base64url(utf8(id))`.

- `id` is the logical identifier (display, package identity).
- `id_key` is only for safe filesystem storage.

Consistency rule:

- `install` checks `spell.yaml` id against `spell.id.txt` when `spell.id.txt` already exists.
- mismatch is treated as an error.

## Cast Preflight

`cast` performs these checks before execution:

- bundle resolution by id (and optional version)
- input assembly (`--input` + `-p` overrides)
- JSON Schema validation by Ajv
- signature verification (default on; bypass only with `--allow-unsigned`)
- platform guard
- risk guard (`high`/`critical` requires `--yes`)
- billing guard (`billing.enabled` requires `--allow-billing`)
- billing license guard (`billing.enabled` + `--allow-billing` requires a local token from `spell license add ...`)
- connector token guard (`CONNECTOR_<NAME>_TOKEN`)
- execution summary output

If `--dry-run` is set, command exits after summary and validation.

## Runtime Safety Limits (v2 isolation)

`cast` enforces these runtime limits (used by direct CLI casts and API-triggered casts because the API invokes `spell cast`):

- `SPELL_RUNTIME_INPUT_MAX_BYTES` (default `65536`): max bytes for merged cast input (`--input` + `-p` overrides).
- `SPELL_RUNTIME_STEP_TIMEOUT_MS` (default `60000`): max runtime per `shell` step. On timeout, the runtime kills the step process and fails with the step name + timeout ms.
- `SPELL_RUNTIME_EXECUTION_TIMEOUT_MS` (default disabled): max total cast runtime across host/docker paths when set to an integer `> 0`.

## Runtime Model

v1 supports:

- host: steps run in order, shell/http supported.
- docker: steps run in a linux container via "runner-in-image".

Docker mode (v1) details:

- `runtime.execution=docker` requires `runtime.docker_image`.
- the image must provide `spell-runner` on `PATH` (this repo publishes it as a second npm bin).
- the bundle is mounted read-only at `/spell`; the runner copies it into a writable temp workdir before executing steps.
- environment variables passed from host -> container are restricted to connector tokens only (`CONNECTOR_<NAME>_TOKEN`). If your spell needs `{{ENV.*}}` for other values, provide them inside the image (or extend the runtime later).

## Windows Policy

- host mode does not assume bash/sh.
- shell step expects executable files (`.js`/`.exe`/`.cmd`/`.ps1` etc).
- process spawn uses `shell=false`.
- for strict cross-OS reproducibility, docker mode is the long-term recommended path.

## Effects Vocabulary (Recommended)

Use these `effect.type` words where possible:

- `create`
- `update`
- `delete`
- `deploy`
- `notify`

## v1 Limitations (Intentionally Not Implemented)

- name search or ambiguous resolution (id only)
- registry/marketplace/license verification
- real billing execution (Stripe)
- DAG/parallel/rollback/self-healing
- advanced templating language (only `{{INPUT.*}}` and `{{ENV.*}}`)
- docker env passthrough beyond connector tokens

## Signature (Sign + Verify)

`spell cast` requires signature verification by default. To bypass this for unsigned bundle workflows, use:

```bash
spell cast <id> --allow-unsigned ...
```

`--require-signature` remains accepted for backward compatibility.

Signing flow:

```bash
spell sign keygen samples --key-id default --out-dir .spell-keys
spell trust add samples <public_key_base64url> --key-id default
spell sign bundle ./examples/spells/call-webhook --private-key .spell-keys/samples__default.private.pem --key-id default
```

Trust store:

- `spell trust add <publisher> <public-key>`
- `spell trust list`
- `spell trust remove <publisher>`

Notes:

- publisher is derived from the spell id prefix before the first `/` (example: `samples/call-webhook` -> `samples`).
- public key format is ed25519 `spki` DER encoded as base64url.

## Example Flow

```bash
spell install ./fixtures/spells/hello-host
spell list
spell inspect fixtures/hello-host
spell cast fixtures/hello-host --dry-run -p name=world
spell cast fixtures/hello-host -p name=world
spell log <execution-id>
```

## Real-Use Sample Spells

These are product-facing examples (separate from test fixtures):

- `/Users/koichinishizuka/spell-runtime/examples/spells/call-webhook`
- `/Users/koichinishizuka/spell-runtime/examples/spells/repo-ops`
- `/Users/koichinishizuka/spell-runtime/examples/spells/publish-site`

Quick try:

```bash
spell install ./examples/spells/call-webhook
spell inspect samples/call-webhook
spell cast samples/call-webhook --dry-run -p event=deploy -p source=manual -p payload='{"service":"web"}'
```

## UI Connection Spec

- Decision-complete button integration spec:
  - `/Users/koichinishizuka/spell-runtime/docs/ui-connection-spec-v1.md`
- Sample button registry:
  - `/Users/koichinishizuka/spell-runtime/examples/button-registry.v1.json`
- Button registry schema:
  - `/Users/koichinishizuka/spell-runtime/examples/button-registry.v1.schema.json`
- Registry optional policy:
  - `require_signature`:
    - `true`: Execution API enforces signature (`--require-signature`)
    - `false`/omitted: Execution API opts into unsigned path (`--allow-unsigned`)

## Runtime Decision Log

- `/Users/koichinishizuka/spell-runtime/docs/runtime-decisions-v1.md`

## Execution API (Async)

Start API server:

```bash
npm run api:dev
```

By default it listens on `:8787` and reads:
- button registry: `./examples/button-registry.v1.json`
- limits:
  - request body: `64KB`
  - execution timeout: `60s`
  - in-flight executions: `4`
- execution index persistence: `~/.spell/logs/index.json`
- routes:
  - `GET /` (minimal Receipts UI)
  - `GET /ui/app.js` (UI client script)
  - `GET /api/buttons`
  - `GET /api/spell-executions` (`status`, `button_id`, `limit` query supported)
  - `POST /api/spell-executions`
  - `GET /api/spell-executions/:execution_id`

Optional environment variables:
- `SPELL_API_PORT`
- `SPELL_BUTTON_REGISTRY_PATH`
- `SPELL_API_AUTH_KEYS` (comma-separated `role=token` entries; when set, `/api/*` requires auth and derives `actor_role` from token)
- `SPELL_API_AUTH_TOKENS` (legacy: comma-separated tokens; when set, `/api/*` requires auth but does not bind role)
- `SPELL_API_BODY_LIMIT_BYTES`
- `SPELL_API_EXECUTION_TIMEOUT_MS`
- `SPELL_API_RATE_LIMIT_WINDOW_MS`
- `SPELL_API_RATE_LIMIT_MAX_REQUESTS`
- `SPELL_API_MAX_CONCURRENT_EXECUTIONS`
- `SPELL_API_LOG_RETENTION_DAYS` (default `14`, `0` disables age-based pruning)
- `SPELL_API_LOG_MAX_FILES` (default `500`, `0` disables count-based pruning)

Security note:
- execution logs redact secret-like keys (`token`, `authorization`, `apiKey`, etc.)
- environment-derived secret values are masked in persisted logs
- when auth is enabled, pass `Authorization: Bearer <token>` (or `x-api-key`) for `/api` routes
- do not set both `SPELL_API_AUTH_KEYS` and `SPELL_API_AUTH_TOKENS` at the same time
