# 0030. Operation contracts for knowledge libraries and pins (K1 and K2)

Date: 2026-10-30. Status: Proposed, for review before K1 code. An addendum to ADRs 0026 to 0029,
which Philip accepted as the foundation on 30 October subject to this contract. It fixes what K1
(library kernel) and K2 (pins and separation) need at the operation level, and resolves the places
where those ADRs contradict the existing kernel contracts (ADRs 0003, 0004, 0005, 0006, 0014). The
cross-store rules that only K6 needs are in
[the cross-store authorization requirements](../design/cross-store-authorization.md).

## Contradictions with the existing kernel, and their resolution

| # | ADR text | Existing contract | Resolution (binding) |
|---|---|---|---|
| C1 | 0026 §6 and 0027 §2a put `SourceVerification` on the evidence record | Evidence records are immutable source pointers (kernel §Records) | Verification is recorded **in the citing claim**, per evidence id, in its support group (§3). The evidence record keeps only what is known when it is recorded, including `SourceMeta`. `evidenceSha256` covers the immutable record only; vector V6 of 0027 already does. |
| C2 | 0026 and 0029 name a scope `knowledge.propose` | Scopes are granted per project (ADR 0006), and `proposal.create` already means "may propose here" | `knowledge.propose` is dropped. Proposing to a library needs `proposal.create` **on that library**. Only `knowledge.curate` is added, as a human-only scope. |
| C3 | 0026 §1 adds `Project.kind` | `project.created` V1 carries only name and description | `project.created` moves to schema version 2 with `kind`. V1 upcasts to `kind: "project"`. |
| C4 | 0026 §4 computes dispute from `contradicts` relations only | Claims already carry `contradictedBy` evidence (ADR 0005) | Dispute is computed from both: committed `contradicts` relations from proposed or established items, and a non-empty `contradictedBy`. |
| C5 | New optional fields on claims and evidence | Event payloads are parsed by schema; unknown fields would be dropped, not kept | `changeSet.committed` moves to schema version 2, whose claims and evidence carry the new fields. V1 events upcast with none. No V1 event is rewritten. |
| C6 | 0026: reviews are curator-only | `updateObject` may replace a whole claim | `ClaimInput` cannot carry reviews or verifications. A replaced claim keeps the review and verification of every group whose `allOf` set is unchanged; changed or new groups start `unreviewed`. Only the operations of §3 write reviews. |
| C7 | 0026 §4: maturity is set by `setMaturity` | The registry already supports reserved attributes, changed only by a dedicated operation (as decision status) | `maturity` is a reserved attribute of every knowledge object type. `setMaturity` is its dedicated operation, modelled on `setDecisionStatus`. |
| C8 | 0027 §1: embedded pinned content keyed by `versionSha256` | The content store keys excerpts by `{contentId, sha256}` | No new store. Pinned content is a content record whose bytes are the canonical form, so its `sha256` equals `versionSha256`. |

ADRs 0026, 0027 and 0029 carry a one-line note pointing here where C1, C2 and C4 apply.

## Decision

### 1. Schema and storage versions

- `EVENT_SCHEMA_VERSIONS`: `project.created` 2 and `changeSet.committed` 2. Readers upcast V1 to V2
  before applying, as the event contract already requires. Writers write V2 only.
- Store schema 3 → 4: `projects.kind` (`project` or `library`, default `project`). Pinned content
  goes into the existing content table.
- Export format 2 (ADR 0027 §6) records the event schema versions it contains. Format 1 imports by
  upcasting.

### 2. Changed contracts (additive)

```
Project            { …, kind: "project" | "library" }                    // default "project"
EvidenceSource     += { kind: "knowledge", library, target: "object" | "relation", id, revision,
                        versionHash: "v1", versionSha256 }              // ADR 0027 §3
EvidenceInput      (document | external) += { meta?: SourceMeta }       // ADR 0026 §7; required in libraries
EvidenceInput      (knowledge)  = { kind, library, target, id, revision }
                                  // the kernel resolves, hashes and embeds; clients never send content
SupportGroup       += { review?: SupportReview,
                        verifications?: Record<EvidenceId, SourceVerification> }   // C1, C6
SourceVerification += { licence?: Licence }                             // a curator's confirmed licence
Scope              += "knowledge.curate"; HUMAN_ONLY_SCOPES += "knowledge.curate"
```

### 3. Operations

Creating a library is the existing project-creation service call, outside proposals, as for any
project. Every other operation lives in a proposal. It is validated at proposal time and again at
the head when committed (R1), and resolves to the existing write kinds (object, relation or
evidence versions) inside `changeSet.committed` V2.

| Operation | Input | Permission | Validation | Resolves to |
|---|---|---|---|---|
| create a library | the project-creation service with `{ name, description, kind: "library" }` | `project.create` | none beyond today's | `project.created` V2 |
| knowledge objects and relations | existing `createObject`, `updateObject`, `retireObject`, `createRelation`, `updateRelation`, `retireRelation` with `knowledge.*` types | propose: `proposal.create` on the library; commit: `proposal.commit` on the library | the library rules of ADR 0026 (I1, I2, I6) and ADR 0028 §7; `maturity` on create must be `hypothesis` or `proposed`, never `established` | object and relation versions |
| record a source | existing `recordEvidence` with `document` or `external` and `meta` | `proposal.create` | in a library `meta` is required. A `licence` other than `unknown` needs `knowledge.curate` (agents and models: `unknown` only). Quotes respect `quotePolicy` (ADR 0026 §7) | evidence version |
| `setMaturity` | `{ id, maturity, reason }` | `knowledge.curate`, origin human | allowed moves: hypothesis → proposed; proposed ↔ established; any → deprecated. To established: ADR 0026 I3 holds at the head | object version, maturity changed |
| `reviewSupport` | `{ id, group: index, verdict, note, scopeLimit? }` | `knowledge.curate`, origin human | `partly` needs `scopeLimit`; `doesNotSupport` removes the group, and the claim must keep at least one; an established item that would break I3 must be set back to proposed in the same proposal | object or relation version, claim updated |
| `verifySource` | `{ evidence, status, method, retrievedSha256?, licence?, note, targets?: ClaimTarget[] }` | `knowledge.curate`, origin human | `retrievedHash` needs `retrievedSha256`; with no `targets`, it applies to every current claim in the library citing that evidence | one version per updated claim |
| pin knowledge (K2) | `recordEvidence { kind: "knowledge", library, target, id, revision }` | `proposal.create` on the project, and `project.read` on the library when it is local | the kernel resolves the version (ADR 0027 §1), computes `versionSha256`, and embeds the content in the same transaction (I6). The revision must not be later than the project's LibraryUse for that library (I4). A library may pin only libraries, not projects | evidence version + content record |
| use a library (K2) | `createObject` or `updateObject` of `core.LibraryUse` | propose: `proposal.create`; commit: `proposal.commit` | the library resolves at that revision. Moving a LibraryUse reports changed pins and stale assessments in the proposal's issues (warnings, not refusals) | object version |

The reviewer, verifier and time are taken from the authenticated principal and the commit, never
from the input.

### 4. Validation that applies to every claim (K2)

- An `observed` claim may cite only `sourceSpan` evidence (separation rule 1, extending R4).
- A claim in a library may not cite `sourceSpan` evidence (ADR 0026 I1).
- A `knowledge` pin's hash must verify at the head when the citing proposal commits. Otherwise the
  commit is refused with `hash-mismatch` (ADR 0027 §5a).

### 5. Replay and determinism

- Replaying the event log rebuilds the same state, `stateSha256` included. Upcasting V1 events is a
  pure function, and it is tested.
- Computed values are never written: dispute, freshness, verdicts on read. So replay never depends
  on the clock or on another library.
- Embedded pinned content is part of the project's content, exported with it, and verified on
  import (ADR 0027 I3).

## Invariants added

- I1. Reviews and verifications enter claims only through `reviewSupport` and `verifySource`.
- I2. A claim replacement keeps the reviews of unchanged groups and resets the others.
- I3. No operation sets `established` on creation.
- I4. Every write is an object, relation or evidence version, in a `changeSet.committed` V2 event.
  No new event type is introduced.
- I5. V1 events and format 1 exports remain readable without loss.

## Representative tests (K1 and K2)

1. Creating a library writes `project.created` V2 with `kind: "library"`. An old store opens with
   every project as `kind: "project"`.
2. Replaying a log of V1 and V2 events gives the same `stateSha256` as the live store.
3. An agent proposing `setMaturity`, `reviewSupport` or `verifySource` is refused (human-only
   scope). A person with `knowledge.curate` succeeds.
4. `createObject` of a Pattern with `maturity: "established"` is refused.
5. Replacing a claim with one group changed keeps the other groups' reviews and resets that one.
6. `reviewSupport` with `doesNotSupport` on the only group is refused; on one of two, it removes
   the group.
7. `verifySource` without targets updates every citing claim, one version each, and an agent's
   evidence with `licence: "proprietary"` is refused.
8. A claim with non-empty `contradictedBy` shows as disputed, with no stored field changed.
9. Pinning: the embedded content's `sha256` equals `versionSha256`; a pin later than its
   LibraryUse is refused; an `observed` claim citing a pin is refused; a library citing a
   `sourceSpan` is refused.
10. An export of format 1 imports into schema 4, and an export of format 2 round-trips with
    embedded content.

## Trade-offs left open

- Recording verification in claims repeats it for each claim citing a source. `verifySource`
  without targets writes them all in one proposal, at the cost of many versions.
- Bumping both event schemas touches every reader once. The upcast is small and tested; the
  alternative, new event types, would split the log's model.
