# Architecture decision records

Each record states a decision, why it was made, and what it costs. Product direction, approvals and
review history live in the project's coordination queue (entries `KAL-YYYYMMDD-NNN`); records here
cite those entries where a decision came from review.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions in the repository | Accepted |
| [0002](0002-stack-and-module-boundaries.md) | TypeScript modular monolith and module boundaries | Accepted (provisional stack, KAL-006) |
| [0003](0003-revisioned-storage-and-replayable-events.md) | Revision-stamped version rows and replayable events (R3) | Accepted |
| [0004](0004-proposals-concurrency-and-rebase.md) | Proposals, optimistic concurrency and rebase (R1) | Accepted |
| [0005](0005-claims-facets-and-relations.md) | Claims, epistemic facets, evidence support and relation registry (R2, R4) | Accepted |
| [0006](0006-authorisation-and-commit-policy.md) | Authorisation, commit policy and instruction provenance | Accepted |
| [0007](0007-mcp-sdk-and-tool-surface.md) | MCP SDK v2 and the version 1 tool surface | Accepted |
| [0008](0008-repository-parsing.md) | Repository parsing with tree-sitter | Accepted |
