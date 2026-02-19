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
- DAG/parallel/rollback
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
