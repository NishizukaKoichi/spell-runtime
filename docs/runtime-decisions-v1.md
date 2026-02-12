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
- v1 runtime is completed for `host` execution.
- `docker` execution is explicit not-supported error in v1.

## 5. Button contract boundary
- clients should send `button_id` only.
- backend resolves `button_id -> spell_id@version` from allowlist/registry.
- clients do not pass arbitrary `spell_id`.

## 6. Execution lifecycle policy
- execution is treated as asynchronous contract from day one.
- return `execution_id` and retrieve details via execution log APIs.

## 7. Guard responsibility split
- runtime enforces: schema, platform, risk/billing flags, connector token presence.
- backend enforces: role/access policy, button registry mapping, rate/size/timeout controls.
- UI enforces: confirmations and clear risk/billing consent UX.

## 8. Logging safety policy
- secrets must not be exposed in API responses.
- raw stdout/stderr should be summarized for user-facing responses.
- execution logs are audit artifacts and must be handled with least exposure.

## 9. Scope discipline
v1 intentionally excludes:
- registry/marketplace
- signature enforcement
- real billing execution
- DAG/parallel/rollback
- advanced template language
