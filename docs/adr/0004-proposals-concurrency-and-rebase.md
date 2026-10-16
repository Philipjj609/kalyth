# 0004. Proposals, optimistic concurrency and rebase

Date: 2026-10-16. Status: accepted. Refinement R1 (KAL-20261016-005/006).

## Context

Proposals from people, the analyzer, models and external agents may wait for review while other
commits land. Project-wide locking would make almost every reviewed proposal stale. Refinement R1:
disjoint read sets alone do not establish semantic compatibility; a rebase must re-check
cross-object invariants and predicate dependencies at the current head.

## Decision

A proposal stores its base revision, resolved operations (ids assigned, local refs resolved), a
write set (ids it updates or retires), a read set (relation endpoints, claims it derives from, plus
ids declared explicitly) and optional predicates: queries whose result fingerprint is taken at the
base revision, such as "no Endpoint with path /items exists".

Commit, in one transaction:

1. Authorise (ADR 0006). Unauthorised commits change nothing; the proposal stays pending.
2. If the head moved since the base: compute ids written in between. Any overlap with the read or
   write set, or any predicate whose result fingerprint changed at head, makes the proposal
   **stale**, reported with `currentRevision` and `changedRefs`.
3. Otherwise apply every operation against the **head** state, always, not only after a rebase.
   This re-checks endpoint existence and types, cycles, cardinality, "no active relation to a
   retired object" and "one accepted alternative per decision". A violation makes the proposal
   **conflicting**, with issues.
4. Write and advance the head. A rebased commit records its original base (`rebasedFrom`).

Errors use one envelope on every interface: `invalid`, `unauthenticated`, `unauthorized`, `stale`,
`conflicting`, `not_found`, `budget_exceeded`, `retryable` (HTTP 422, 401, 403, 409, 409, 404, 429,
503). Committing an already committed proposal returns its original result. An idempotency key makes
repeated submissions return the first proposal and refuses reuse with different content.

## Consequences

Tests cover both R1 cases with disjoint read sets (two alternatives accepted concurrently; retiring
an object while a relation to it is added) and a predicate change. A mutation check confirmed these
tests fail if commit validates against the base instead of the head. Semantic merge of overlapping
proposals is left for later; v1 asks the proposer to re-read and re-propose.
