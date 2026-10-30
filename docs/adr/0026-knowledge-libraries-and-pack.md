# 0026. Knowledge libraries, the knowledge pack and curation

Date: 2026-10-27. Status: Proposed, for review before any code. Builds on ADRs 0003, 0005, 0006,
0010 and 0017, and on [the knowledge-fabric design](../design/knowledge-fabric.md) (e388835),
reviewed by ChatGPT and approved as the basis for K0 with Philip's decisions of 26 October.

## Context

The design puts reusable engineering knowledge in the kernel, not beside it. This ADR fixes what a
library is, which types and relations it holds, where Principle ends and Pattern begins, how new
ideas enter as hypotheses, and how knowledge is curated with its sources. It also separates two
checks that 0.1.0 treats as one: a citation that **matches** its source, and evidence that
**supports** a claim.

Philip's decisions: Principle and Pattern stay separate, with clear boundaries; Philip curates and
approves at first, helped by research agents and authoritative sources, keeping attribution,
versions, licences and evidence.

## Decision

### 1. A library is a project of kind `library`

`Project` gains `kind: "project" | "library"` (default `project`, so every existing project is
unchanged). A library:

- registers the `knowledge` pack and may not hold `software.*` objects;
- may cite `document`, `external`, `statement` and `knowledge` evidence (ADR 0027), never
  `sourceSpan` evidence;
- takes proposals from principals with `proposal.create` on it, and commits with
  `proposal.commit`, as any project. Maturity, reviews and verifications need the human-only scope
  `knowledge.curate` (ADR 0030, C2). Commit policy (ADR 0006) is unchanged otherwise: models and
  agents propose, a person commits.

### 2. Object types (pack `knowledge`, version 1)

All carry `maturity` (section 4) and the usual claim.

```
knowledge.Concept    { name, aliases[], definition, kind: "term" | "quantity" | "property" | "quality",
                       dimension?: Dimension,             // ADR 0028; required when kind = quantity
                       projectTypes?: TypeName[] }        // project element types it describes,
                                                          // used by selection (ADR 0029)
knowledge.Principle  { statement, rationale, scope, exceptions[] }
knowledge.Pattern    { name, aliases[], problem, solution, structure, consequences }
knowledge.Condition  { subject: LocalRef<Concept> | KnowledgePin, test: ConditionTest, text }
                     // ADR 0028; a pin names a concept of another library this one pins (ADR 0027)
knowledge.Method     { name, purpose, inputs, steps[], outputs[], checks[] }       // ADR 0029
```

### 3. Principle and Pattern: the boundary

- A **Principle** is a normative rule: it says what to prefer or avoid, why, and when it does not
  hold. It names no structure. Example: "Never trust the client: validate every action on an
  authority." It must state `scope` and may list `exceptions` (for example "single-player modes
  with no shared state"). It relates to qualities with `addresses`, and to conditions with
  `appliesWhen` and `exceptWhen`.
- A **Pattern** is a reusable structure: components, interactions and the forces it balances.
  Example: "server-authoritative simulation with client prediction". It must have at least one
  `affects` trade-off, and conditions or an open Question saying none is known.
- A pattern may `realizesPrinciple` a principle. A principle never requires a pattern.
- **Test for curators:** if removing the text about structure leaves something true and useful,
  it is a principle. If it leaves nothing, it is a pattern. A validator cannot check this; the
  curator decides, and a `core.Question` records a disputed case.

### 4. Maturity, dispute and hypotheses

Two separate properties:

**Maturity** is the lifecycle a curator sets, and it is stored:

`maturity: "hypothesis" | "proposed" | "established" | "deprecated"`

- **hypothesis:** a new idea proposed because existing knowledge is inadequate. Any principal with
  `proposal.create` on the library may propose one, a model included, during a method run (ADR 0029). It needs a
  rationale and at least one piece of evidence, which may be a statement or a case document. It is
  never used to rule a pattern in or out.
- **proposed:** the curator committed it with its sources, and its support is not yet fully
  reviewed.
- **established:** every remaining support group has been reviewed by a person as supporting the
  claim, for its stated scope, at that revision, and every cited source has been matched or
  verified (section 6). It is a statement about review, not a guarantee that the claim is true
  everywhere. Established knowledge stays open to challenge, and to new review.
- **deprecated:** superseded or withdrawn; kept for pins that still cite it.

Only `setMaturity`, by a curator, changes maturity. It needs a reason, recorded as a statement. If
a later review leaves an established item without the reviews it needs, the same proposal must set
it back to proposed, or the commit is refused. (ADR 0030 A7 lets a curator give that curation when
committing someone else's proposal.)

**Dispute** is computed on read, never stored, and never changes maturity:

`dispute: { status: "none" | "disputed", by: KnowledgePin[] }`

An item is disputed while a committed `contradicts` points at it from knowledge whose maturity is
proposed or established, or while its claim has `contradictedBy` evidence (ADR 0030, C4). When the dispute ends, through deprecation or `supersedes`, the item shows
its unchanged maturity again. Views show both, for example "established, disputed by 1".

### 5. Relations (pack `knowledge`, version 1)

| Relation | From → to | Rules |
|---|---|---|
| `isA` | Concept → Concept | acyclic |
| `refines` | Pattern → Pattern | acyclic |
| `addresses` | Pattern, Principle → Concept (quality or property) | |
| `affects` | Pattern → Concept (quality) | `effect: improves \| worsens \| mixed`, `note`, optional `conditions[]` |
| `appliesWhen` | Pattern, Principle → Condition | all jointly required |
| `unsuitableWhen` | Pattern → Condition | any one rules the pattern out |
| `exceptWhen` | Principle → Condition | an exception to the principle |
| `competesWith` | Pattern → Pattern | symmetric |
| `realizesPrinciple` | Pattern → Principle | |
| `uses` | Method → Concept, Pattern, Principle | |

The core relations `requires`, `contradicts`, `supersedes` and `concerns` get a new version whose
endpoints include knowledge types. Their earlier versions stay valid for existing data.

### 6. Matching, verifying and supporting are three different things

A citation of an external source passes up to three separate checks:

1. **Quote match**, by Kalyth, deterministic. The stored quote occurs in the stored source content
   (ADR 0017), and that content still matches its hash. It is possible only when the source's
   `quotePolicy` lets content be stored.
2. **Source verification**, by a person, or by Kalyth when it can retrieve the source. The source
   exists at the stated version, and the locator points to the passage relied on:

   ```
   // Recorded in the citing claim's support group, per evidence id, since evidence is immutable
   // (ADR 0030, C1).
   SourceVerification { status: "unverified" | "verified" | "failed",
                        method: "retrievedHash" | "manual", by: PrincipalId, at,
                        retrievedSha256?: string, note }
   ```

   Where quotes cannot be stored (`quotePolicy: "none"`), or the source cannot be retrieved, this
   is the only check that the citation points somewhere real. It is manual, and it is recorded.
3. **Support**, judged by a person: the passage actually backs the claim, as stated, for the scope
   claimed. Kalyth cannot decide this. A matched quote or a verified locator never implies it.

Each `supports` group of a knowledge claim carries a review:

```
SupportReview { verdict: "supports" | "partly" | "doesNotSupport" | "unreviewed",
                reviewer: PrincipalId, reviewedAt, note, scopeLimit?: string }
```

It defaults to `unreviewed`. `doesNotSupport` removes the group from the claim's support at the
next commit, and a claim left without support is refused. `partly` requires a `scopeLimit` (for
example "holds only for two-player games"). Reviews can be revised later, by a new review recorded
with its reason. Views always show all three properties separately. Examples:

- "quoted, matched, support not reviewed";
- "paraphrase, locator verified, supports";
- "paraphrase, locator unverified".

None of these reads as "true". Project claims are unchanged: their citations of project source are
checked for match only, as in 0.1.0.

### 7. Sources, attribution and licences

`document` and `external` evidence used by libraries must carry:

```
SourceMeta { title, authors[], publisher?, edition?, version?, published?, locator,
             licence: "public-domain" | "cc-by" | "cc-by-sa" | "permissive" | "proprietary" | "unknown",
             quotePolicy: "full" | "excerpt" | "none" }
```

- `quotePolicy` limits stored quotes: with `excerpt`, at most 600 characters per quote and three
  quotes per source per claim; with `none`, a locator and a paraphrase only, no stored source
  content, and so no quote match. Such a citation relies on source verification (6.2) and support
  review (6.3).
- Exports of a library carry `SourceMeta`, so attribution travels with the knowledge.
- Research agents propose with sources; they cannot set `licence` to anything but `unknown`, and a
  curator confirms it.

## Invariants

- I1. A library holds no `software.*` objects and no `sourceSpan` evidence.
- I2. Every knowledge claim has at least one support group. Every quoted citation matches, and every
  unquoted one has a SourceVerification record, which may still be `unverified`.
- I3. `established` requires every remaining group to be reviewed as `supports` or `partly`, and
  every cited source to be matched or `verified`. ADR 0030 A8 adds: at least one group reviewed as
  `supports` holds a verified, attributable document or external source.
- I4. Dispute is computed on read from committed `contradicts` relations. It is never stored, and
  never changes maturity.
- I5. A hypothesis never decides an applicability verdict (ADR 0028).
- I6. `isA` and `refines` are acyclic.
- I7. Established means reviewed, not true. It is still challengeable and re-reviewable, and views
  never present it as settled fact.

## Migration consequences

- `Project.kind` is a new field with a default; old exports import as `project`.
- New pack and relation versions are additions. Core relation endpoints widen in a new version,
  and old versions remain readable.
- `SupportReview` is new data on knowledge claims only; project claims do not change.
- New operations `setMaturity`, `reviewSupport` and `verifySource` resolve to ordinary object and
  relation versions in `changeSet.committed` V2. There is no new event type, and older events
  replay unchanged (R3). ADR 0030 gives the exact contracts.

## Test cases (for K1)

1. A library refuses a `software.Module` and a claim citing `sourceSpan` evidence.
2. A knowledge claim with an unmatched quote is refused; a matched one is accepted as unreviewed.
3. `established` is refused while any group is unreviewed, or any unquoted source is unverified;
   it is accepted once both are complete.
4. Reviewing a group as `doesNotSupport` removes it, and removing the last group refuses the
   commit. Revising a review so an established item no longer qualifies is refused unless the same
   proposal sets it back to proposed.
5. A committed `contradicts` from a proposed claim makes an established target show "established,
   disputed". Deprecating the source of the contradiction clears the dispute, and the target is
   still established, with its maturity never changed in between.
6. An `isA` cycle and a `refines` cycle are refused.
7. A Pattern without `affects` fails validation unless it has an open Question about its
   trade-offs; a Principle without `scope` is refused.
8. A quote longer than `excerpt` allows is refused. `none` accepts a paraphrase with a locator and
   an `unverified` SourceVerification, and shows "locator unverified".
9. Library export and import round-trip `stateSha256`, with `SourceMeta` and reviews.
10. A matched quote with an unreviewed group is shown as "matched, support not reviewed", never as
    supported.

## Trade-offs left open

- Human support review is slow, and will be the bottleneck of a large library. That is intended
  for now: unreviewed knowledge is still usable, but labelled.
- The Principle/Pattern test depends on curator judgement. Merging the two types was considered and
  rejected by Philip's decision.
- The licence enum is coarse; a full SPDX expression may be needed later.
