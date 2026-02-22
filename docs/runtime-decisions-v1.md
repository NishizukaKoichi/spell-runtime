# Runtime Decisions v1

This document records stable architecture decisions for Spell Runtime v1.

## 1. ID and storage separation
- `id` is the logical identifier used for reference, display, and package identity.
- storage key uses `id_key = base64url(utf8(id))`.
- install path is `~/.spell/spells/<id_key>/<version>/`.

## 2. ID consistency source of truth
- `spell.id.txt` is version-crossing index file at `~/.spell/spells/<id_key>/spell.id.txt`.
- `spell.yaml.id` is the source of truth.
- install fails if existing `spell.id.txt` does not match `spell.yaml.id`.

## 3. Reference policy
- v1 resolves spells by `id` only.
- name lookup and ambiguous resolution are intentionally out of scope.

## 4. Runtime execution policy
- v1 runtime supports `host` execution and `docker` execution.
- docker execution is "runner-in-image": host `spell` runs `docker run <image> spell-runner ...`.
- the bundle is mounted read-only and copied to a writable temp workdir inside the container before executing steps.
- env passthrough is restricted to connector tokens (`CONNECTOR_<NAME>_TOKEN`) by default.

## 5. Button contract boundary
- clients should send `button_id` only.
- backend resolves `button_id -> spell_id@version` from allowlist/registry.
- clients do not pass arbitrary `spell_id`.

## 6. Execution lifecycle policy
- execution is treated as asynchronous contract from day one.
- return `execution_id` and retrieve details via execution log APIs.

## 7. Guard responsibility split
- runtime enforces: schema, platform, risk/billing flags, connector token presence.
- backend enforces: role/access policy, button registry mapping, signature policy (`require_signature` and optional global force mode), rate/size/timeout controls.
- UI enforces: confirmations and clear risk/billing consent UX.

## 8. Logging safety policy
- secrets must not be exposed in API responses.
- raw stdout/stderr should be summarized for user-facing responses.
- execution logs are audit artifacts and must be handled with least exposure.

## 9. Scope discipline
v1 intentionally excludes:
- registry marketplace/discovery UX
- real billing execution
- advanced template language

## 10. Execution API auth and retention controls
- API authentication is opt-in via:
  - `SPELL_API_AUTH_KEYS` (recommended, role-bound)
  - `SPELL_API_AUTH_TOKENS` (legacy, role-unbound)
- when configured, all `/api/*` routes require bearer/api-key token.
- when using `SPELL_API_AUTH_KEYS`, `actor_role` is derived from the auth token role (client-supplied role is ignored).
- execution log inventory is persisted in `~/.spell/logs/index.json`.
- retention is controlled by:
  - age (`SPELL_API_LOG_RETENTION_DAYS`, default 14)
  - max files (`SPELL_API_LOG_MAX_FILES`, default 500)
- retention pruning updates both log files and in-memory/indexed execution list for consistency.

## 11. Signature verification policy
- bundles may include `spell.sig.json` (ed25519 signature over bundle digest).
- trust store is publisher-scoped under `~/.spell/trust/publishers/`.
- trust keys are lifecycle-managed per key id (active/revoked) and can be removed individually.
- when the last key for a publisher is removed, the publisher trust file is deleted.
- signature verification ignores revoked keys; signatures referencing revoked key ids fail clearly.
- CLI `spell cast` requires a verified signature by default.
- unsigned execution is an explicit opt-out path via `--allow-unsigned`.
- Execution API can enforce signature per button (`require_signature=true`) and can force it globally (`SPELL_API_FORCE_REQUIRE_SIGNATURE=true`).

## 12. Signature authoring UX
- `spell sign keygen` generates ed25519 keypairs for publishers.
- `spell sign bundle` writes `spell.sig.json` for local bundles.
- public keys are registered via `spell trust add`.
- `spell trust revoke-key` and `spell trust restore-key` change per-key trust status without removing the publisher trust file.
- `spell trust list` reports per-key status (`active` or `revoked`).
- `spell trust inspect` reports `key_id`, `status`, `algorithm`, and a shortened public key fingerprint per key.
- `spell trust remove-key` removes one key by `key_id`; removing the final key deletes that publisher trust file.

## 13. Runtime policy management CLI
- `~/.spell/policy.json` remains the runtime policy source of truth for cast preflight.
- `spell policy show` prints current policy JSON or a clear missing-file message (exit 0).
- `spell policy validate --file <path>` validates with the same runtime parser/validator and prints `policy valid` on success.
- `spell policy set --file <path>` validates then writes normalized pretty JSON with a trailing newline to `~/.spell/policy.json`.
- policy `effects` controls are optional and enforce cast preflight using `manifest.effects`:
  - `allow_types` denies effects whose `type` is not listed.
  - `deny_types` denies listed effect types and takes precedence over `allow_types`.
  - `deny_mutations=true` denies any effect where `mutates=true`.

## 14. Output retrieval surfaces
- operators can read one output value from logs via:
  - `spell get-output <execution-id> <path>`
- execution API supports:
  - `GET /api/spell-executions/:execution_id/output?path=...`
- output path grammar is fixed to existing runtime references:
  - `step.<stepName>.stdout`
  - `step.<stepName>.json`
  - `step.<stepName>.json.<dot.path>`
- API output reads remain tenant-scoped under auth keys (`TENANT_FORBIDDEN` for cross-tenant non-admin access).

## 15. Registry version resolution strategy
- registry install supports:
  - `registry:<id>@<version>` (exact)
  - `registry:<id>` and `registry:<id>@latest` (latest)
  - optional index selection via `spell install registry:<id>... --registry <name>`
- latest selection is deterministic:
  - semver `x.y.z` numeric compare preferred
  - non-semver fallback uses lexical descending
- required pin enforcement (`commit`/`digest`) applies to the resolved concrete version entry.
- operators can inspect resolution without install via `spell registry resolve registry:<id>...`.

## 16. Signature governance policy
- runtime policy supports `signature.require_verified`:
  - when `true`, cast denies non-verified signature states (`unsigned`, `untrusted`, `invalid`)
  - this applies even if caller passes `--allow-unsigned`
- this gives operators a global, host-local enforcement switch for signature strictness.
- operators can run `spell verify <id> [--version ...]` to validate installed bundle signature/trust state without running `cast`.

## 17. Execution list time filters
- execution API list supports optional `from` / `to` ISO-8601 timestamps.
- execution API list supports optional `spell_id` exact filter.
- filtering is applied on `created_at` (inclusive bounds).
- invalid timestamps or reversed ranges fail with `INVALID_QUERY`.

## 18. OCI install channel
- `spell install` supports `oci:<image-ref>` in addition to local/git/registry sources.
- OCI install extraction is deterministic and minimal:
  - `docker create <image-ref>`
  - `docker cp <container>:/spell/. <temp-bundle-dir>`
  - `docker rm -f <container>`
- runtime expects bundle root at `/spell` in the image (`/spell/spell.yaml` required).
- install provenance records OCI source as:
  - `type: "oci"`
  - `source: "oci:<image-ref>"`
  - `image: "<image-ref>"`

## 19. CI Docker smoke coverage
- CI includes a dedicated `docker-smoke` job separate from main verify gates.
- scope is intentionally narrow:
  - OCI install smoke (`oci:<image-ref>`)
- this keeps default validation deterministic while still exercising real Docker paths on every PR/push.

## 20. Spell-level runtime policy allow/deny
- runtime policy supports spell id controls in `~/.spell/policy.json`:
  - `spells.allow`: explicit allowlist of spell ids
  - `spells.deny`: explicit denylist of spell ids
- deny takes precedence over allow.
- policy evaluation order remains fail-fast and deterministic:
  - spell deny/allow -> publisher deny/allow -> risk/runtime/effects/signature -> default allow/deny.

## 21. Step DAG / parallel / condition model
- step graph uses `steps[].depends_on` references by step name.
- cycle detection is enforced at install/load time.
- optional `runtime.max_parallel_steps` controls concurrency (`1` default).
- optional `steps[].when` supports guarded execution using:
  - `input_path` + `equals`/`not_equals`
  - `output_path` + `equals`/`not_equals`
- `when.output_path` requires explicit `depends_on` on the referenced step, preventing race conditions.
- skipped steps are treated as successful audit events (`success=true`, `message="skipped by condition"`), and do not emit output keys.

## 22. Step rollback model
- steps may define `rollback` as an executable path under the bundle root.
- if a cast fails after one or more steps executed, rollback runs best-effort in reverse execution order for steps that define rollback.
- rollback step names are recorded as `rollback.<originalStepName>` in step results.
- rollback failures are also recorded in step results; runtime still returns the original execution failure.

## 23. Compensation strictness signal
- rollback outcomes are summarized in execution logs under `rollback`:
  - attempted/succeeded/failed counts
  - steps executed without rollback handlers
  - final state (`not_needed`, `fully_compensated`, `partially_compensated`, `not_compensated`)
- runtime policy supports `rollback.require_full_compensation`.
- when enabled and rollback state is not fully compensated, cast reports `manual recovery required` and API maps it to `COMPENSATION_INCOMPLETE`.

## 24. Step retry policy
- steps may define optional retry policy via:
  - `retry.max_attempts` (`1..10`)
  - `retry.backoff_ms` (`0..60000`, default `0`)
- retry is applied to step execution failures before the step is treated as failed.
- when a step succeeds after retries, step result message includes attempt marker (`attempt n/m`).
- final failure after retries appends attempt marker to error message (`attempt m/m`).

## 25. Execution status stream (SSE)
- execution API exposes `GET /api/spell-executions/:execution_id/events` as server-sent events.
- stream sends:
  - `snapshot`: immediate current execution snapshot
  - `execution`: delta snapshots when status/receipt changes
  - `terminal`: final snapshot, then stream closes
- stream is tenant-scoped under auth keys:
  - non-admin cross-tenant requests fail with `TENANT_FORBIDDEN`.
