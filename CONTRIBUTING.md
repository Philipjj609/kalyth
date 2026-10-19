# Contributing

Thank you for helping. Kalyth is early; the kernel contracts are stabilising and may still change.

## Workflow

1. Open an issue describing the problem or proposal before large changes.
2. Keep pull requests to one coherent change, with tests.
3. Run `pnpm check` locally. For UI changes, also run `pnpm build && pnpm test:e2e`: browser tests
   of the main flows by keyboard, with axe accessibility checks in both themes. They use the
   installed Chrome and the mock provider. CI runs all of these on Linux and Windows.
4. If you change a contract or an invariant, add or update an ADR in `docs/adr`.

## Style

- TypeScript strict mode, ESM, `.ts` import extensions, erasable syntax only (no enums, namespaces
  or parameter properties) so Node can run sources directly.
- Biome formats and lints; run `pnpm format` before committing.
- Tests use Vitest. Kernel invariants get property tests (fast-check) where a property exists.

## Commits

Write commit messages that say what changed and why. Do not include credentials, personal data or
private repository content in commits, test fixtures or issues.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
