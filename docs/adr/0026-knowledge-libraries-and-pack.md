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
- needs the scope `knowledge.curate` to commit, and `knowledge.propose` to propose. Commit policy
  (ADR 0006) is unchanged otherwise: models and agents propose, a person commits.

### 2. Object types (pack `knowledge`, version 1)

All carry `maturity` (section 4) and the usual claim.

```
knowledge.Concept    { name, aliases[], definition, kind: "term" | "quantity" | "property" | "quality",
                       dimension?: Dimension }            // ADR 0028; required when kind = quantity
knowledge.Principle  { statement, rationale, scope, exceptions[] }
knowledge.Pattern    { name, aliases[], problem, solution, structure, consequences }
knowledge.Condition  { subject: LocalRef<Concept>, test: ConditionTest, text }   // ADR 0028
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

### 4. Maturity, and hypotheses

`maturity: "hypothesis" | "proposed" | "established" | "disputed" | "deprecated"`

- **hypothesis:** a new idea proposed because existing knowledge is inadequate. Any principal with
  `knowledge.propose` may create one, a model included, during a method run (ADR 0029). It needs a
  rationale and at least one piece of evidence, which may be a statement or a case document. It is
  never used to rule a pattern in or out.
- **proposed:** the curator committed it with its sources; its support is not yet reviewed.
- **established:** every support group has been reviewed as supporting (section 6).
- **disputed:** a committed `contradicts` points at it from knowledge that is at least proposed.
  The value is computed, never set by hand.
- **deprecated:** superseded or withdrawn; kept for pins that still cite it.

Only `setMaturity`, by a curator, moves between hypothesis, proposed, established and deprecated.
It needs a reason, recorded as a statement.

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

### 6. Matching is not supporting

A citation has two separate properties:

1. **Match**, checked by Kalyth: the quoted text occurs in the cited source content (ADR 0017),
   and the content still matches its hash. It is deterministic, and it is required.
2. **Support**, judged by a person: the cited passage actually backs the claim, as stated, for the
   scope claimed. Kalyth cannot decide this.

Each `supports` group of a knowledge claim carries a review:

```
SupportReview { verdict: "supports" | "partly" | "doesNotSupport" | "unreviewed",
                reviewer: PrincipalId, reviewedAt, note, scopeLimit?: string }
```

It defaults to `unreviewed`. `doesNotSupport` removes the group from the claim's support at the
next commit; a claim left without support is refused. `partly` requires a `scopeLimit` (for
example "holds only for two-player games"). Views always show both properties. A matched but
unreviewed citation is shown as "quoted, not yet reviewed", never as "supported". Project claims
are unchanged: their citations are checked for match only, as in 0.1.0.

### 7. Sources, attribution and licences

`document` and `external` evidence used by libraries must carry:

```
SourceMeta { title, authors[], publisher?, edition?, version?, published?, locator,
             licence: "public-domain" | "cc-by" | "cc-by-sa" | "permissive" | "proprietary" | "unknown",
             quotePolicy: "full" | "excerpt" | "none" }
```

- `quotePolicy` limits stored quotes: with `excerpt`, at most 600 characters per quote and three
  quotes per source per claim; with `none`, a locator and a paraphrase only. The match check (6.1)
  then applies to the paraphrase's stated locator, not to quoted text.
- Exports of a library carry `SourceMeta`, so attribution travels with the knowledge.
- Research agents propose with sources; they cannot set `licence` to anything but `unknown`, and a
  curator confirms it.

## Invariants

- I1. A library holds no `software.*` objects and no `sourceSpan` evidence.
- I2. Every knowledge claim has at least one support group, and every group has a match.
- I3. `established` requires every remaining group to be reviewed as `supports` or `partly`.
- I4. `disputed` is computed from committed `contradicts` relations, never set directly.
- I5. A hypothesis never decides an applicability verdict (ADR 0028).
- I6. `isA` and `refines` are acyclic.

## Migration consequences

- `Project.kind` is a new field with a default; old exports import as `project`.
- New pack and relation versions are additions. Core relation endpoints widen in a new version,
  and old versions remain readable.
- `SupportReview` is new data on knowledge claims only; project claims do not change.
- The event schema gains `setMaturity` and `reviewSupport` operations, a schema-version bump with
  replay of older events unchanged (R3).

## Test cases (for K1)

1. A library refuses a `software.Module` and a claim citing `sourceSpan` evidence.
2. A knowledge claim with an unmatched quote is refused; a matched one is accepted as unreviewed.
3. `established` is refused while any group is unreviewed, and accepted once all are reviewed.
4. Reviewing a group as `doesNotSupport` removes it; removing the last group refuses the commit.
5. A committed `contradicts` from a proposed claim makes its target `disputed`; deprecating the
   source of the contradiction clears it.
6. An `isA` cycle and a `refines` cycle are refused.
7. A Pattern without `affects` fails validation unless it has an open Question about its
   trade-offs; a Principle without `scope` is refused.
8. A quote longer than `excerpt` allows is refused; `none` accepts a paraphrase with a locator.
9. Library export and import round-trip `stateSha256`, with `SourceMeta` and reviews.

## Trade-offs left open

- Human support review is slow, and will be the bottleneck of a large library. That is intended
  for now: unreviewed knowledge is still usable, but labelled.
- The Principle/Pattern test depends on curator judgement. Merging the two types was considered and
  rejected by Philip's decision.
- The licence enum is coarse; a full SPDX expression may be needed later.
