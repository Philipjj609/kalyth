# 0003. Revision-stamped version rows and replayable events

Date: 2026-10-16. Status: accepted. Refinement R3 (KAL-20261016-005/006).

## Context

The kernel must read any past revision, diff revisions, keep an immutable audit trail, and never
leave an event without its state change or the reverse. Refinement R3 requires that the event log
alone suffices for deterministic replay, with schema versions and redactable content references.

## Decision

- Each project has an integer head revision; each committed change set creates exactly one revision.
- Objects and relations are version rows with `rev_from` and `rev_to`. A version is current at
  revision R when `rev_from <= R` and `rev_to` is null or greater than R. A write closes the previous
  current row and inserts a new one. Retirement is a new version with lifecycle `retired`; nothing is
  deleted.
- A commit runs in one `BEGIN IMMEDIATE` transaction: version rows, evidence rows, change set,
  event, head update. Any failure rolls all of it back (tested with fault injection at three points).
- `changeSet.committed` events (schema version 1) carry complete resolved writes: the full post-state
  of every version row and evidence record, with ids and type versions. Replay applies writes in
  order; a version write closes the previous current version of the same id. A property test replays
  random histories and compares the result with the live store.
- Event readers upcast older schema versions before applying them and refuse versions they do not
  know. History is never rewritten; type migrations happen as new change sets.
- Database triggers make events, change sets and evidence append-only, allow a version row only to
  be closed once, and allow a content row only to lose its body.
- Evidence excerpts live in a separate content store, keyed by SHA-256. Proposals and events carry
  only `{contentId, sha256}`. Excerpts matching common secret patterns are stored as hashes with a
  redaction marker, and an owner redaction can later remove any body without touching events.

## Alternatives

Full event sourcing with snapshots gives more freedom for projections but makes historical reads
slower and needs more code. Git-backed JSON files would make branching natural later but give weak
queries and concurrency. Version rows meet every stated requirement with the least machinery.

## Consequences

Proposals, principals, grants and content bodies are not revisioned state and are not replayed.
Grants will become revisioned records when delegation grants are introduced (Navigator gate).
