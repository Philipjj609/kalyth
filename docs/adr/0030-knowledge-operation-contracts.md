# 0030. Operation contracts for knowledge libraries and pins (K1 and K2)

Date: 2026-10-30. Status: Accepted for K1 on 30 October, with the amendments at the end (A1 to
A12). An addendum to ADRs 0026 to 0029,
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
| `reviewSupport` | `{ target, group: key, verdict, note, scopeLimit? }` (A1) | `knowledge.curate`, origin human | `partly` needs `scopeLimit`; `doesNotSupport` removes the group, and the claim must keep at least one; an established item that would break I3 must be set back to proposed in the same proposal | object or relation version, claim updated |
| `verifySource` | `{ evidence, status, method, retrievedSha256?, licence?, note, targets? }` (A3) | `knowledge.curate`, origin human | `retrievedHash` needs `retrievedSha256`; with no `targets`, it applies to every current claim in the library citing that evidence | one version per updated claim |
| pin knowledge (K2) | `recordEvidence { kind: "knowledge", library, target, id, revision }` | `proposal.create` on the project, and `project.read` on the library when it is local | the kernel resolves the version (ADR 0027 §1), computes `versionSha256`, and embeds the content in the same transaction (I6). The revision must not be later than the project's LibraryUse for that library (I4). A library may pin only libraries, not projects | evidence version + content record |
| use a library (K2) | `createObject` or `updateObject` of `core.LibraryUse` | propose: `proposal.create`; commit: `proposal.commit` | the library resolves at that revision. Moving a LibraryUse reports changed pins and stale assessments in the proposal's issues (warnings, not refusals) | object version |

The reviewer, verifier and time are taken from the authenticated principal and the commit, never
from the input.

### 4. Validation that applies to every claim (K2)

- An `observed` claim may cite only `sourceSpan` evidence (separation rule 1, extending R4). A13
  narrows this to "never a `knowledge` pin", since the task verifier observes git commits.
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

## Amendment of 2026-10-30, after review

Philip approved this ADR as the foundation for K1 (KAL-20261030-066 review), with three
clarifications, A1 to A3. A4 to A6 are gaps found while mapping it onto the kernel code. All of them
are narrow. None changes an invariant of ADRs 0026 to 0029 or of this ADR.

### A1. Support groups are addressed by a content key, with concurrency checks at commit

- A support group's key is `sg_` followed by the first 32 hex digits of the SHA-256 of the
  canonical JSON of its sorted, de-duplicated `allOf` evidence ids. It is computed, never stored,
  so replay and export reproduce it, and it does not depend on the group's position.
- In a library, two groups of one claim may not have the same key (`support.duplicate_group`).
- `reviewSupport` takes `{ target, group: key, … }` instead of an index. C6 is the same rule seen
  through the key: a replaced claim keeps the review and verifications of every group whose key is
  unchanged.
- Concurrency: every target of `reviewSupport`, `setMaturity` and `verifySource` is in the
  proposal's write set, so a change to that record after the base makes the commit `stale` (ADR
  0004). At the head, the group must still exist (`support.group_not_found`, R1).
- `verifySource` without `targets` is resolved at proposal time to the claims citing the evidence
  at the base, which are recorded in the proposal. At commit the citing set at the head must be
  the same, or the proposal is `conflicting` (`verify.citing_claims_changed`).

### A2. Curation is authorised when proposed and again when committed

The operations that need `knowledge.curate` are `setMaturity`, `reviewSupport`, `verifySource`,
and `recordEvidence` with a `licence` other than `unknown`. For a proposal holding any of them:

- **When proposed:** the proposer is a human principal, acting directly (origin `human`), and holds
  `knowledge.curate` on the library. Otherwise the proposal is refused (`unauthorized`), not filed
  as invalid.
- **When committed:** the committer is a human principal, acting directly, holding
  `knowledge.curate` on the library. The proposer must still hold it at that moment, so a revoked or
  expired grant cannot be committed through someone else. Otherwise the commit is refused
  (`unauthorized`) and the proposal stays pending.
- `knowledge.curate` is human-only (ADR 0006): `grant` refuses it for other principals, as for
  `decision.decide`.
- A curation operation targets only records of a project of kind `library`
  (`knowledge.not_a_library`).

### A3. `verifySource`: statuses, transitions and consequences

```
VerifySourceOp { op: "verifySource", evidence: EvidenceId,
                 status: "verified" | "failed" | "unverified",
                 method: "retrievedHash" | "manual", retrievedSha256?: sha256,
                 licence?: Licence, note, targets?: (ObjectId | RelationId)[] }
SourceVerification { status: "verified" | "failed" | "unverified",
                     method, by: PrincipalId, at, retrievedSha256?, licence?, note }
```

- **Which evidence:** `document` and `external` only. A statement is not a source to verify;
  `sourceSpan` cannot occur in a library; a `knowledge` pin is checked by its hash (§4).
- **Absent means unverified.** A citation with no record is `unverified`. The kernel never writes
  an implicit record, so a new citation needs no operation.
- **Method:** `retrievedHash` requires `retrievedSha256`; `manual` must not carry it. Withdrawing
  (status `unverified`) uses `manual`. In K1, Kalyth does not fetch sources: a person records what
  they checked.
- **Transitions,** per citing group:

  | From | To `verified` | To `failed` | To `unverified` |
  |---|---|---|---|
  | unverified (absent) | allowed | allowed | refused (`verify.no_change`) |
  | verified | allowed (a re-check, newer record) | allowed | allowed (withdrawn) |
  | failed | allowed (re-checked and found) | allowed (newer record) | allowed (withdrawn) |

- **Consequences:**
  - `verified` counts towards ADR 0026 I3 for that evidence in that group.
  - `failed` keeps the group, with its record, and the group stops counting as support. A claim
    whose every group has a failed verification or a `doesNotSupport` review is shown as
    unsupported. It is not refused, so a failure can always be recorded truthfully.
  - `unverified` no longer counts towards I3.
  - Maturity never changes by itself. A change that leaves an `established` item failing I3,
    through a verification, a review or a claim replacement, must come with curation that sets
    it back to `proposed` or completes it, in the same proposal or when it is committed (A7).
    Otherwise the commit is refused. I3 is checked once, on the state the whole commit produces.
- A `licence` in a verification is the curator's confirmation for that citation. The evidence's own
  `SourceMeta.licence` never changes (C1).

### A4. Reviewer, verifier and time

`by` is the authenticated proposer, and `at` the time the proposal was filed. Both are written into
the resolved operation, so the proposal shows exactly the record its commit will write. The
committer is recorded in the change set, as for every commit. For curation given at commit (A7),
`by` is the committer and `at` the commit time.

### A5. Where `SourceMeta` sits

`SourceMeta` is a field `meta` of the `document` or `external` source, as ADR 0027 vector V6 shows.
It does not repeat what the source already says: a `document` keeps its own `version` and
`locator`, so `SourceMeta.locator` and `SourceMeta.version` are optional. In a library every cited
source must have a locator, on the source or in `meta`.

### A6. Two attribute details

- A Concept whose `dimension` is `category` lists its allowed `values`, which the `in` test of a
  Condition and category parameters are checked against (ADR 0028 §3 and §4 rely on them).
- A Condition's `subject` is an object reference that local refs in the same proposal may name. In
  K1 it names a Concept of the same library; the pinned form is K2.

## Amendment of 2026-10-30, after the K1 review

Philip accepted K1 provisionally (KAL-20261030-067 review) and decided the six questions it
raised. A7 to A9 change the contract; A10 to A12 record decisions without changing it. None
changes an invariant of ADRs 0026 to 0029: A7 keeps I3 whole, and A8 strengthens it.

### A7. Agents may propose changes to established knowledge; only a curator accepts them

- **Accepted knowledge** is an object whose maturity is `established` before the proposal
  applies, together with the relations that have it as an endpoint.
- **A change to it** is an update or retirement of such an object, or a creation, update or
  retirement of such a relation. Creating a `contradicts` relation is a challenge, not a change:
  the item is unchanged, and the dispute overlay shows it (C4).
- **Filing:** anyone with `proposal.create` may propose a change, an agent included. The proposal
  is filed as pending and stays reviewable. It lists, in `curation.required`, the established
  items it changes, and in `curation.gaps`, what I3 would then be missing for each. An I3 gap on
  an item that was already established is reported there, not as an issue. Setting an item to
  `established` in the proposal itself still needs I3 to hold, or the proposal is invalid.
- **Commit:** a change to accepted knowledge is committed only by a person acting directly with
  `knowledge.curate`. The committer may give curation with the commit:

  ```
  CommitProposalInput { proposalId, curation?: (SetMaturityOp | ReviewSupportOp | VerifySourceOp)[] }
  ```

  Curation given at commit is authorised as in A2 for the committer, resolved with the committer
  as reviewer or verifier and the commit time (A4), applied after the proposal's operations, and
  written in the same change set and event. The commit result lists it, so the proposal's record
  shows who curated what. It names records by id; local refs belong to the proposal.
- **I3 at commit:** the state the commit produces, curation included, must satisfy I3 for every
  established item. Otherwise the commit is refused with `curation.required`, naming the gaps,
  and the proposal stays pending, so the curator can try again with curation, or reject it.
- **No silent change:** maturity changes only through `setMaturity` by a curator, in a proposal or
  at commit. Nothing an agent proposes moves an item back to `proposed` or changes an accepted
  item without a curator committing it.

### A8. Established needs an attributable, verified source reviewed for the declared scope

ADR 0026 I3 is strengthened. Besides every remaining group being reviewed and every cited source
verified, at least one group must be reviewed as `supports` (not `partly`), and contain a
`document` or `external` source with `SourceMeta` whose locator is verified. Support made only of
statements, or only of `partly` reviews, is not enough. Established still means reviewed for the
stated scope, never universally true (ADR 0026 I7).

### A9. Matching, verifying and supporting stay separate in every view

- **Quote match** is Kalyth comparing a stored quote with stored source content. K1 stores no
  source content, so no citation is ever matched in K1. A stored quote is reported as `unchecked`;
  `matched` and `mismatch` exist in the contract for when source content can be stored.
- **Locator verification** (`verifySource`) records that a person found the source at the stated
  version and the passage relied on at the locator. `retrievedSha256` is the hash of the retrieved
  source, not of any quote. A verified locator never says a stored quote is verbatim, and views
  never present it as a matched quotation.
- **Support review** records whether the passage backs the claim for its scope.
- ADR 0026 I3 ("matched or verified") is met in K1 by locator verification. ADR 0026 test 2
  (an unmatched quote is refused) waits for stored source content: until then, refusing unmatched
  quotes would refuse every quote.

The status read model reports each source as `{ quote: "none" | "stored", quoteMatch:
"notApplicable" | "unchecked" | "matched" | "mismatch", locatorVerification }`.

### A10. Licence confirmation is a library rule

A licence other than `unknown` needs `knowledge.curate` only in a library (A2). Evidence in
ordinary projects keeps the permissions it had: `proposal.create` to propose, `proposal.commit`
to commit.

### A11. Knowledge stays in libraries

`knowledge.*` objects exist only in projects of kind `library`. Ordinary projects refer to
knowledge through pins and keep their own assessments (K2, K3).

### A12. Two costs accepted for now

- K1 exports stay format 1, carrying version 2 events; an older build refuses them as an unknown
  event version, never by dropping fields. Format 2, with embedded pins, is part of K2.
- Verifying a source writes one version per citing claim. Every version of one verification is in
  one change set and one event, so it is atomic, attributable to one curator, and replayed exactly.

## Amendment of 2026-10-30, K2

Recorded while implementing K2 (pins, LibraryUse, export format 2). A13 resolves a contradiction
with the existing kernel; A14 and A15 state how K2 meets ADR 0027 without changing it.

### A13. Separation rule 1 protects observations from knowledge

§4 said an `observed` claim may cite only `sourceSpan` evidence. The existing task verifier
(ADR 0013) records `observed` verifications citing a git commit as `document` evidence, so that
reading would break a shipped contract. The rule's purpose is that library knowledge never passes
for a tool observation: an `observed` claim may not cite `knowledge` pins
(`claim.observed_from_knowledge`), and, as before, not statements. Observed claims keep citing
`sourceSpan` and tool-recorded `document` evidence.

### A14. What a pin embeds, and how it is checked

- Creating a pin embeds the version's canonical text, keyed by `versionSha256`, and the canonical
  text of every evidence record it cites, keyed by `evidenceSha256` (the hash of the record's
  source, SourceMeta included, as vector V6). Attribution therefore travels with the project.
- A pin is recorded only after the kernel resolved it; a client may send the hash it expects
  (`pin.hash_differs` if it differs). The proposer must hold `project.read` on the library.
- At commit, the embedded copy must verify (`pin.hash_mismatch`), and I4 is checked on the state
  the whole proposal produces, so a LibraryUse and its first pins can be one proposal.
- A LibraryUse names a present library other than its own project, at a revision the library has;
  there is one per library; it never changes library and never moves back, so no pin can become
  later than its use.
- Moving a LibraryUse is previewed with the pin status read model (`preview`), which reports each
  pin as `current`, `unchanged`, `changed`, `removed`, `noLibraryUse` or `libraryNotPresent`.
  Proposals still carry no warnings of their own.

### A15. K2 scope

- One resolver, `local` (ADR 0027 §1). Snapshot and remote resolvers, and cross-store pins (K6),
  are not built. A pin whose embedded copy is lost resolves from the local library, but the copy is
  not written back yet.
- `core.Correspondence`, cross-library evaluation and `conflicting` verdicts need conditions to be
  evaluated, so they come with K3. Freshness of assessments (ADR 0029) also waits for K3; K2 gives
  pin freshness.

K2 was accepted by Philip on 30 October 2026 (KAL-20261030-069 review), including A13: observed
claims may cite direct implementation evidence such as git commits, never knowledge pins or
statements.
