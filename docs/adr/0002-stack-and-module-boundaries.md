# 0002. TypeScript modular monolith and module boundaries

Date: 2026-10-16. Status: accepted, stack provisional (KAL-20261016-006).

## Context

One process serves a local UI and coding agents over MCP, from one SQLite store. The UI, the API,
MCP tool schemas and model structured output all need the same data contracts. Development happens
on Windows; deployment will be a small Linux host.

## Decision

- TypeScript throughout, ESM, strict mode. Node 24 LTS (pinned for the hackathon; Node 26 becomes
  LTS on 2026-10-28). pnpm workspaces.
- Sources use erasable syntax only and `.ts` import extensions, so Node runs them directly without
  a build step in development. TypeScript 7 typechecks; Biome lints and formats; Vitest tests.
- zod 4 schemas in `packages/contracts` are the single source for types, runtime validation and
  JSON Schema (MCP tool inputs, model output contracts).
- SQLite through better-sqlite3 13, which ships prebuilt binaries for Windows, macOS and Linux. Its
  install script is disabled (it would try to compile from source). No ORM: the kernel needs exact
  control over version rows, triggers and transactions.
- Fastify 5 for HTTP. MCP per ADR 0007.

Layout and dependency direction:

```
packages/contracts   <- depended on by everything
packages/core        kernel (validation, apply), store (SQLite), services (authz, propose, commit, queries)
apps/server          HTTP and MCP adapters; they call services only
```

The kernel does not touch the database directly; the store implements the state views the kernel
reads. Navigator, context compiler and analyzer modules will read through services and write only
proposals.

## Alternatives

A Python server with a generated TypeScript client would give Python's own parser for repository
analysis but split the contracts across two type systems. A Python analysis worker beside the
TypeScript core (option C in the Phase 0 review) remains the fallback; the parser spike (ADR 0008)
showed it is not needed for the pinned demo repository.

## Consequences

All production dependencies are MIT, Apache-2.0, BSD-3-Clause or ISC (checked 2026-10-16), which is
compatible with Apache-2.0. ELK layout (EPL-2.0 or GPL-3.0) is avoided for the canvas in favour of
dagre (MIT) unless a licence review approves it.
