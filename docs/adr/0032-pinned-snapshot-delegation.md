# 0032. Pinned-snapshot read delegation for agent tokens

Date: 2026-10-30. Status: Proposed, for review. Builds on ADRs 0006, 0011, 0027 and 0031.

## Context

An agent token is issued for one project (ADR 0011). Since K4 every library read needs
`project.read` on that library (ADR 0031), so an agent working on a project cannot see the
knowledge its project relies on. Philip decided: allow it, narrowly. The agent may read the exact
knowledge versions, and the evidence records they cite, that its project pins, and nothing else of
the library.

## Decision

- **Scope.** A new scope, `knowledge.pinned.read`, granted on one project. It allows
  `get_pinned_knowledge` on that project: each pin's canonical content and the evidence records it
  cites (with `SourceMeta`), from the project's own embedded copies.
- **Snapshots, not the library.** The operation reads only the project's content store. A copy that
  is missing is reported `notEmbedded` and one whose hash differs `hashMismatch`; it never falls
  back to the library (ADR 0027 §1 does that for resolution, which needs library access). So the
  holder sees no later revision, no unpinned item, no other project's pins, and nothing about the
  library beyond what the project pinned.
- **Everything else unchanged.** `search_knowledge`, `get_knowledge`, `get_method` and
  `assess_applicability` still need `project.read` on the library itself; assessing reads the
  library's conditions, so a delegated agent can read recorded assessments (`list_assessments`,
  `get_assessment`) but not compute new ones. The scope adds no write and no curation right; the
  per-project rules of ADR 0006 stay as they are.
- **Explicit.** A person issuing a token asks for it with `pinnedKnowledge: true`
  (`IssueAgentTokenInput`, default `false`). The token's summary lists it among its scopes.
- **Expiry and revocation.** The scope is part of the token's single grant, with the token's
  expiry. Revoking the token stops it authenticating, which ends the delegation with it.
- **People.** The local owner holds every scope, this one included.

## Tests

`apps/server/test/pinned-delegation.test.ts`: off by default; when delegated, the five pins of the
example with their cited sources; no library search or item read, no later revision, no other
project, no curation; no fallback to the library for a missing copy; revocation and expiry. The
MCP and HTTP parity test covers the new operation.

## Not decided here

Delegating library search, or assessment for agents without library access, would need its own
authorisation and is not part of this scope.
