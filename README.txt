Spell Runtime v1

Minimal CLI runtime for SpellBundle v1.

1. Setup
- Node.js >= 20
- npm

Install dependencies:
  npm i

Build:
  npm run build

Test:
  npm test

Local dev:
  npm run dev -- --help

Binary smoke checks:
  npm run smoke:link
  npm run smoke:npx

Manual link:
  npm link
  spell --help

Manual npx (local package):
  npx --yes --package file:. spell --help

2. CLI commands
- spell install <local-path>
- spell list
- spell inspect <id> [--version x.y.z]
- spell cast <id> [--version x.y.z] [-p key=value ...] [--input input.json] [--dry-run] [--yes] [--allow-billing] [--require-signature] [--verbose] [--profile <name>]
- spell license add <name> <token>
- spell license list
- spell license remove <name>
- spell sign keygen <publisher> [--key-id default] [--out-dir .spell-keys]
- spell sign bundle <local-path> --private-key <file> [--key-id default] [--publisher <name>]
- spell trust add <publisher> <public-key> [--key-id default]
- spell trust list
- spell trust remove <publisher>
- spell log <execution-id>

2.1 Install sources
- spell install <local-path> keeps the same CLI interface and now accepts:
  - local bundle paths (existing behavior)
  - git URLs:
    - https://...
    - ssh://...
    - git@...

When a git URL is provided, runtime performs a shallow clone (git clone --depth 1) into a temporary directory and installs from the cloned repository root.

Limitations:
- git must be installed and available on PATH.
- clone/auth/network behavior is delegated to your local git configuration.
- spell.yaml must exist at the cloned repository root (subdirectory installs are not supported).

3. Storage layout
- Spells: ~/.spell/spells/<id_key>/<version>/
- ID index: ~/.spell/spells/<id_key>/spell.id.txt
- Logs: ~/.spell/logs/<timestamp>_<id>_<version>.json
- Billing license tokens: ~/.spell/licenses/*.json

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
- Optional signature verification (--require-signature)
- Platform guard
- Risk guard (high/critical requires --yes)
- Billing guard (billing.enabled requires --allow-billing)
- Billing license guard (billing.enabled + --allow-billing requires a local token from spell license add ...)
- Connector token guard (CONNECTOR_<NAME>_TOKEN)
- Execution summary output

If --dry-run is set, command exits after summary and validation.

5. Runtime model
v1 supports:
- host: steps run in order, shell/http supported.
- docker: steps run in a linux container via "runner-in-image".

Docker mode (v1) details:
- runtime.execution=docker requires runtime.docker_image.
- the image must provide spell-runner on PATH (this repo publishes it as a second npm bin).
- the bundle is mounted read-only at /spell; the runner copies it into a writable temp workdir before executing steps.
- env vars passed from host -> container are restricted to connector tokens only (CONNECTOR_<NAME>_TOKEN). If your spell needs {{ENV.*}} for other values, provide them inside the image (or extend the runtime later).

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
- registry/marketplace/license verification
- real billing execution (Stripe)
- DAG/parallel/rollback/self-healing
- advanced templating language (only {{INPUT.*}} and {{ENV.*}})
- docker env passthrough beyond connector tokens

8.1 Signature (sign + verify)
If a bundle contains spell.sig.json, you can require signature verification at execution time:
  spell cast <id> --require-signature ...

Signing flow:
  spell sign keygen samples --key-id default --out-dir .spell-keys
  spell trust add samples <public_key_base64url> --key-id default
  spell sign bundle ./examples/spells/call-webhook --private-key .spell-keys/samples__default.private.pem --key-id default

Trust store:
- spell trust add <publisher> <public-key>
- spell trust list
- spell trust remove <publisher>

Notes:
- publisher is derived from the spell id prefix before the first / (example: samples/call-webhook -> samples).
- public key format is ed25519 spki DER encoded as base64url.

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

10. UI connection spec
- Decision-complete button integration spec:
  /Users/koichinishizuka/spell-runtime/docs/ui-connection-spec-v1.md
- Sample button registry:
  /Users/koichinishizuka/spell-runtime/examples/button-registry.v1.json
- Button registry schema:
  /Users/koichinishizuka/spell-runtime/examples/button-registry.v1.schema.json
- Registry optional policy:
  require_signature (when true, Execution API adds --require-signature)

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

14. Execution API (async)
Start:
  npm run api:dev

Defaults:
- listens on :8787
- reads registry: ./examples/button-registry.v1.json
- limits:
  - request body: 64KB
  - execution timeout: 60s
  - in-flight executions: 4
- execution index persistence: ~/.spell/logs/index.json
- routes:
  GET /
  GET /ui/app.js
  GET /api/buttons
  GET /api/spell-executions (status/button_id/limit query supported)
  POST /api/spell-executions
  GET /api/spell-executions/:execution_id

Optional environment variables:
- SPELL_API_PORT
- SPELL_BUTTON_REGISTRY_PATH
- SPELL_API_AUTH_KEYS (comma-separated role=token entries; when set, /api/* requires auth and derives actor_role from token)
- SPELL_API_AUTH_TOKENS (legacy: comma-separated tokens; when set, /api/* requires auth but does not bind role)
- SPELL_API_BODY_LIMIT_BYTES
- SPELL_API_EXECUTION_TIMEOUT_MS
- SPELL_API_RATE_LIMIT_WINDOW_MS
- SPELL_API_RATE_LIMIT_MAX_REQUESTS
- SPELL_API_MAX_CONCURRENT_EXECUTIONS
- SPELL_API_LOG_RETENTION_DAYS (default 14, 0 disables age-based pruning)
- SPELL_API_LOG_MAX_FILES (default 500, 0 disables count-based pruning)

Security note:
- execution logs redact secret-like keys (token, authorization, apiKey, etc.)
- environment-derived secret values are masked in persisted logs
- when auth is enabled, pass Authorization: Bearer <token> (or x-api-key) for /api routes
- do not set both SPELL_API_AUTH_KEYS and SPELL_API_AUTH_TOKENS at the same time
