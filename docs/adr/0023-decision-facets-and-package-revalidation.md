# 0023. Decision facets and package revalidation

Date: 2026-10-20. Status: accepted (D4 in KAL-20261019-034, with ChatGPT's refinement). Builds on
ADRs 0009, 0011 and 0013; part of the direction in ADR 0020.

## Context

The audit (KAL-20261019-033) found that staleness never reached what was built on it:

- after the source moved, the Decisions view showed nothing;
- a context package still said "current";
- `get_context_package` told an agent nothing had changed.

Finishing a task did not move the decision either. ChatGPT's refinement: do not merge decision
acceptance, implementation progress, verification and evidence freshness into one lifecycle. Each
may be partial. Packages are revalidated on read and before consequential use, and commit-time
revision checks stay as they are.

## Decision

**Decision facets.** Every decision summary (`listDecisions`, HTTP and MCP) carries `facets`,
computed on read at the revision asked for. Nothing is stored, and nothing is revoked.

- **Acceptance** stays the decision's own `status`, changed only by a person (`setDecisionStatus`).
- **Freshness** of the evidence its direct changes rest on:
  - once an alternative is accepted, only that alternative's changes count; while the decision is
    open, every alternative's changes count;
  - a change needs review when its own claim, or the claim of the element it changes, is stale,
    derived-stale or weakened;
  - the facet is `current`, `stale` (with each change and the reason) or `unchecked` (no change
    cites evidence that can go stale).
- **Implementation**, from the tasks that `implements` the decision or one of its alternatives:
  - `none`, `planned`, `in-progress`, `reported` (a report awaits review), `partial` or `complete`;
  - cancelled tasks do not count;
  - a completed task whose last report was `partial` makes the facet `partial`.
- **Verification**, from the latest report on each of those tasks and that report's verification:
  - `none`, `failed`, `partial` or `passed`;
  - the result includes the latest passing verification's own coverage statement, so a pass never
    claims more than the verifier checked (ADR 0013).

**Packages revalidated on read.** A package's body stays content-addressed and unchanged. Every
read (HTTP, MCP and the resource) adds a `current` section, computed against the head:

- whether the head moved since the package was compiled;
- which of its items now need review that it recorded as current;
- which items left the model;
- one sentence saying what to do.

The MCP tool description tells agents to check those items, or ask for a new package, before
relying on them. This is a warning only. Proposals are still validated against their base revision
at commit, and a stale proposal is still refused (ADR 0004).

## Alternatives

- **One lifecycle with an "implemented" state.** Rejected in review. It would hide partial work,
  and it would mix up what was decided, what was built and what was checked.
- **Storing derived staleness on the decision.** It would be written by no one, and it would be
  wrong as soon as the source moved again. A read model needs no migration and cannot drift.
- **Marking the package itself stale.** The body is content-addressed. Changing it would change
  its id and break the provenance proposals record (ADR 0011).

## Consequences

- `listDecisions` now reads every record at the revision and assesses freshness once per call.
  That is linear in the model's size, which is fine at the sizes Kalyth handles today.
- The Decisions view shows the three facets under the decision's status. The package view shows
  the warning when the head moved.
- Reconciliation still needs a person: completing a task does not accept, verify or refresh
  anything by itself. Re-analysing the task's commit and linking what it observed to the proposed
  elements (`realizes`) is the next step.
