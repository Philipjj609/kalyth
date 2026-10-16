# 0001. Record architecture decisions in the repository

Date: 2026-10-16. Status: accepted.

## Context

Kalyth's product direction and governance live in a shared coordination workspace. Contracts that
code depends on must live next to the code so that they change in the same commit.

## Decision

Architecture decisions that affect code are recorded here as short ADRs. Each names its context, the
decision, the consequences, and the coordination entries it came from. The zod schemas in
`packages/contracts` are the executable contracts; `docs/contracts` summarises them in prose.

## Consequences

The coordination workspace links to ADRs and commits instead of duplicating them. An ADR is changed
by superseding it with a new one, not by rewriting history.
