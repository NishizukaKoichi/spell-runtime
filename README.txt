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
- spell cast <id> [--version x.y.z] [-p key=value ...] [--input input.json] [--dry-run] [--yes] [--allow-billing] [--verbose] [--profile <name>]
- spell log <execution-id>

3. Storage layout
- Spells: ~/.spell/spells/<id_key>/<version>/
- ID index: ~/.spell/spells/<id_key>/spell.id.txt
- Logs: ~/.spell/logs/<timestamp>_<id>_<version>.json

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
- Platform guard
- Risk guard (high/critical requires --yes)
- Billing guard (billing.enabled requires --allow-billing)
- Connector token guard (CONNECTOR_<NAME>_TOKEN)
- Execution summary output

If --dry-run is set, command exits after summary and validation.

5. Runtime model
v1 supports host execution only.
- host: steps run in order, shell/http supported.
- docker: explicitly unsupported in v1 and fails with a clear error.

Future docker direction:
- docker image contains spell-runner and executes bundle in container.

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
- registry/marketplace/signature enforcement/license verification
- real billing execution (Stripe)
- DAG/parallel/rollback/self-healing
- advanced templating language (only {{INPUT.*}} and {{ENV.*}})
- docker step execution runtime

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

11. Install from npm
Global install:
  npm i -g spell-runtime
  spell --help

Run with npx:
  npx --yes --package spell-runtime spell --help
