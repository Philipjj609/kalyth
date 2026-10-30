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
| [0009](0009-source-snapshots-analyzer-and-freshness.md) | Source snapshots, the repository analyzer and claim freshness | Accepted |
| [0010](0010-provider-gateway-grounding-and-navigator.md) | Provider gateway, budget ledger, grounding and the Navigator | Accepted |
| [0011](0011-context-packages-and-mcp-handoff.md) | Context packages, agent tokens and the MCP handoff | Accepted |
| [0012](0012-evaluation-harness.md) | Evaluation harness | Accepted |
| [0013](0013-tasks-leases-and-verified-execution-reports.md) | Tasks, leases and execution reports verified against git | Accepted, commit-policy addition pending review |
| [0014](0014-project-export-and-import.md) | Project export and import | Accepted |
| [0015](0015-guided-exploration-hybrids-and-comparison.md) | Guided exploration, hybrid alternatives and comparison | Accepted |
| [0016](0016-openrouter-free-provider.md) | OpenRouter’s free endpoints as a test provider | Accepted |
| [0017](0017-bounded-citation-normalisation.md) | Bounded citation normalisation | Accepted |
| [0018](0018-citations-by-evidence-span.md) | Citations by evidence span | Proposed |
| [0019](0019-hosted-demo.md) | Hosted demo: per-visitor sandboxes, recorded runs first, capped live inference | Accepted with amendments (D7, KAL-20261019-029) |
| [0020](0020-product-direction-workspace-and-change-thread.md) | Product direction: one workspace, change threads and the Drafting Table language | Accepted (KAL-20261019-034) |
| [0021](0021-data-access-relations-and-finer-impact.md) | Data access relations, entity references, endpoint parameters and finer impact | Accepted (technical lead; the `writes` rule awaits review) |
| [0022](0022-proposed-elements-and-statement-evidence.md) | Proposed elements and statement evidence | Accepted (D2, KAL-20261019-034) |
| [0023](0023-decision-facets-and-package-revalidation.md) | Decision facets and package revalidation | Accepted (D4, KAL-20261019-034) |
| [0024](0024-reconciliation.md) | Reconciliation after an agent's work: task prompt, person-filed reports, recorded findings and `realizes` links | Proposed (technical lead review); amended 2026-10-20 |
| [0025](0025-larger-repositories.md) | Larger repositories: ingest in parts, scoped keys for repeated names, routes only from routers, and a first canvas view that opens one big box | Accepted |
| [0026](0026-knowledge-libraries-and-pack.md) | Knowledge libraries, the knowledge pack and curation: Principle and Pattern, maturity and hypotheses, matching versus support, sources and licences | Proposed, for review (future branch) |
| [0027](0027-knowledge-identity-storage-and-pins.md) | Knowledge identity, storage, pins and composition across libraries: one logical kernel, resolvers, correspondences, conflicts as decisions, export format 2 | Proposed, for review (future branch) |
| [0028](0028-scenarios-parameters-and-applicability.md) | Scenarios, parameters and deterministic applicability: dimensions and units, provenance, uncertainty, contradictions, three-valued verdicts with explanations | Proposed, for review (future branch) |
| [0029](0029-assessments-freshness-and-methods.md) | Assessments, their freshness, and methods that use knowledge: dependency sets, checks, hypotheses, the explorer and agent access | Proposed, for review (future branch) |
| [0030](0030-knowledge-operation-contracts.md) | Operation contracts for knowledge libraries and pins (K1 and K2), resolving contradictions with the existing kernel | Proposed, for review (future branch) |
| [0031](0031-read-access-to-knowledge.md) | Read-only MCP and HTTP access to knowledge and assessments (K4) | Proposed, for review (future branch) |
| [0032](0032-pinned-snapshot-delegation.md) | Pinned-snapshot read delegation for agent tokens | Proposed, for review (future branch) |
