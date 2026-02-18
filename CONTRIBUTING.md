# Contributing

## Development Setup

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm test
```

Use Node.js `>=20`.

## Pull Request Guidelines

- Keep changes scoped and reversible.
- Add tests for behavior changes.
- Update `README.md` and/or `README.txt` when user-facing behavior changes.
- Ensure local gates are green before opening a PR:
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run build`
  - `pnpm test`

## Commit Style

Use short imperative commit messages, one logical change per commit.

## Release Process

Releases are tag-based via GitHub Actions (`.github/workflows/release.yml`).

```bash
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm test
pnpm run pack:check
npm version patch
git push --follow-tags
```

A pushed tag `vX.Y.Z` triggers npm publish.
