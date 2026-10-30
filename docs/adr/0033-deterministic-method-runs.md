# 0033. Deterministic method runs (K6a)

Date: 2026-10-30. Status: Proposed, for review before any code. Builds on ADR 0029 (§4 methods,
§5 checks), ADRs 0006, 0010, 0026 to 0032, and R1 to R4.

## Context

ADR 0029 defines methods, runs and the check catalogue. The roadmap's K6 was "methods with a
model". Philip decided that the first executable method must be a real engineering investigation
that needs no inference: select pinned knowledge, find missing parameters and uncertainties, assess
applicability under explicit scenarios and natures, compare alternatives and their trade-offs, and
hand the result to people through the proposal and decision system. Model-assisted drafting comes
after this behaviour is established and evaluated.

So K6 is split. **K6a** (this ADR) is the deterministic method engine. **K6b** is model-assisted
drafting through the gateway, with its own ADR and spend approval, and the cross-store hypothesis
filing of `docs/design/cross-store-authorization.md`.

## Decision

### 1. What a method is, and what the engine knows

A method stays a `knowledge.Method` in a library (ADR 0029 §4), curated like any knowledge. The
engine is generic: it knows knowledge types, relations, concepts, conditions, scenarios, parameter
natures and assessments, and nothing about any discipline. A method is data: its `purpose`,
`appliesTo` (element types, whether scenarios are needed), `needs` (concepts it reads), `steps` and
`checks`.

Steps run as fixed phases, chosen by what each step `produces`:

| Phase | Driven by | K6a |
|---|---|---|
| select | every step's `uses`, plus the sources of §3 | deterministic |
| ask | steps producing `question` | deterministic |
| assess | steps producing `assessment` | deterministic (ADR 0028 evaluator) |
| compare | steps producing `alternative` | deterministic (§6) |
| find gaps | steps producing `hypothesis` | deterministic Question only; no hypothesis is drafted (§7) |
| check | the method's `checks` | deterministic (§8) |
| propose | always | one project proposal (§9) |

A step with `mode: "model"` makes the run fail with `method.model_steps_not_enabled`. A step with
`mode: "person"` is recorded as needing a person's review of the proposal, which every run has
anyway (§9).

### 2. Starting a run

```
MethodRunInput {
  projectId,
  method: EvidenceId,                 // the project's pin of a knowledge.Method
  scenarios: ObjectId[],              // at least one, explicit (ADR 0028 A3)
  natures: Nature[],                  // at least one, explicit
  elements?: ObjectId[],              // default: the whole system only
  decision?: ObjectId,                // an existing open Decision to add alternatives to
  question?: string,                  // otherwise the Decision the run proposes asks this
  request?: string,                   // terms for the lexical source
  add?: EvidenceId[],                 // pins a person adds (the `person` source)
  limits?: { maxCandidates?: 1..50 (default 12), maxHops?: 0..3 (default 2),
             maxAssessments?: 1..200 (default 60) }
}
```

**Permissions** (ADR 0006, 0011, 0031, 0032; nothing new):

- Starting a run needs `project.read` and `proposal.create` on the project, since its output is a
  proposal. People and agents may start runs; the origin is recorded.
- A run reads each library it uses to select and to evaluate (the evaluator reads conditions at the
  pinned revision, K3), so it needs `project.read` on **every** library the project uses. Without
  it the run is refused before it starts (`unauthorized`, `method.library_read_required`, naming
  the libraries). There is no snapshot-only evaluation: the pinned-snapshot delegation of ADR 0032
  lets an agent read pinned versions, never run a method, and nothing here widens it (amendment
  A2).
- Pinning newly selected items in the output needs `project.read` on the library (ADR 0030 §3).
- Committing the output and accepting an alternative stay with people: `proposal.commit`, and
  `decision.decide` with origin human (D4), through the check gate of §8.

### 3. Selection (ADR 0029 §4.1, I8)

Candidates are patterns and principles from the libraries the project uses, at the revision of
each LibraryUse. Sources, each bounded and recorded with its path or score:

| Source | Adds |
|---|---|
| `explicit` | items in the method's steps' `uses` |
| `person` | pins in `add` |
| `parameter` | items whose conditions, or `addresses`, name a concept the project has a parameter or open Question for, in the chosen scenarios |
| `elementType` | items that `addresses` a concept whose `projectTypes` include the type of a chosen element |
| `graph` | `competesWith`, `refines` and `requires`, in either direction, from selected items, up to `maxHops` |
| `lexical` | items whose name or aliases match terms of `request`, ranked by the BM25 of `packages/eval` |

Hypotheses are listed as ideas, never as candidates (ADR 0026 I5). Deprecated items are excluded and
listed. The list is cut at `maxCandidates` in the fixed order of ADR 0029: explicit, person,
parameter, elementType, graph (fewer hops first), lexical (higher score first), ties by id. Every
cut item is listed with its sources.

### 4. Ask: missing values and uncertainties

For each candidate, scenario, element and nature, the evaluator reports what it lacked (ADR 0028).
The run turns that into one open Question per missing `(concept, scenario, element, nature)`,
unless an open one with the same text exists. Uncertainties the evaluator reports are listed
too: straddling intervals, declared-unknown values, contradictory parameters, missing
correspondences, an underspecified item, and an `assumed` or `planned` scenario. The run does not
pause for answers (ADR 0029 says it "may"); it proceeds with unknowns visible, and a person re-runs
after answering. A re-run supersedes the earlier assessments (ADR 0029 I1).

### 5. Assess

One assessment per candidate × scenario × element × nature, up to `maxAssessments`; beyond that the
run fails before proposing (`method.too_many_assessments`), naming the product, rather than
silently assessing a subset. Each is computed by the evaluator and recomputed when the proposal is
committed (ADR 0028 I4, K3).

### 6. Compare: alternatives from knowledge, not invented

The run proposes, or extends, one Decision: the `decision` given, or a new one asking `question`
(default: the method's purpose, for the chosen elements). Each candidate **pattern** becomes one
Alternative. Principles, selected or realised by a candidate (`realizesPrinciple`, read for display
only), are shown in the comparison as constraints, never as alternatives. Patterns that
`refines` another candidate are shown under it, not as separate alternatives.

`core.Alternative` gains a version 2 with an optional, structured `basis`, so checks read structure,
never prose:

```
core.Alternative v2 { …v1, basis?: {
  pins: EvidenceId[],             // the knowledge relied on
  covers: ObjectId[],             // assessments whose verdict is conditionsMet or unknown
  ruledOut: ObjectId[],           // assessments whose verdict is conditionsNotMet
  disclosed: { disputed: EvidenceId[], hypotheses: EvidenceId[], worsens: string[],
               underspecified: EvidenceId[] },
  unbacked: boolean               // always false in K6a
} }
```

**Coverage is per assessment** (amendment A1). An assessment fixes the exact context: item,
scenario, element (or the whole system) and nature. So `covers` and `ruledOut` list assessment ids,
never scenarios, and a pattern can cover the RTS and be ruled out for the shooter in one scenario.
The kernel refuses a basis that could mislead (`alternative.basis_inconsistent`): every listed
assessment must exist, be active, assess one of `pins`, and have a verdict that matches its list;
no context `(item, scenario, element, nature)` may appear in both lists; and every pin must have at
least one listed assessment.

Its `summary` is the pattern's solution and `tradeoffs` lists every `affects` relation as
"improves / worsens / mixed: quality — note", quoted from the pinned content with its attribution.
Its claim is `imported`, supported by the pins, and `derivedFrom` its assessments. The run also
records a **comparison**: per alternative, its verdict in each exact context (scenario, element,
nature), its trade-offs by quality, and the principles that constrain it. Views and agents read the comparison from the
run; the proposal holds the structured records.

An alternative ruled out in every assessed context is listed in the comparison, not proposed.

### 7. Find gaps

If, in some exact context (scenario, element, nature), no candidate has its conditions met, the
run adds one open Question for that context: "No
pinned knowledge has its declared conditions met for <elements> in <scenario> (<nature> values).
Is there an approach outside the libraries in use?". In K6a no hypothesis is drafted and no library
proposal is filed; that is K6b, with the cross-store requirements.

### 8. Checks and the acceptance gate (ADR 0029 §5, I6, I7)

The six checks of catalogue version 1 are code in `packages/core`, each a pure function of the
proposal's operations and the project state, reading `basis`:

| Check | Severity | Fails when |
|---|---|---|
| `alternatives-cite-assessments` | mandatory | the alternative relies on a pin with no assessment of it in `covers` or `ruledOut`, or `covers` is empty |
| `no-reliance-on-ruled-out` | mandatory | a context it covers has a `conditionsNotMet` assessment of any relied-on pin, whether listed or not |
| `disputed-flagged` | mandatory | a relied-on item is disputed and not in `disclosed.disputed` |
| `hypotheses-labelled` | mandatory | a relied-on item is a hypothesis and the alternative is not `unbacked` |
| `worsens-disclosed` | advisory | a `worsens` trade-off of a relied-on pattern is not in `disclosed.worsens` |
| `unknowns-asked` | advisory | an `unknown` verdict for missing values has no open Question |

- The run stores its check results with the proposal (`Proposal.checks`) for display.
- **The kernel recomputes them** when the proposal is committed and when an alternative is
  accepted, as it recomputes assessments; stored results are never trusted.
- A failed mandatory check refuses the commit, or the acceptance, with `check.failed`, unless the
  committer, a person acting directly, gives a CheckException for that check and target with the
  commit, like curation in ADR 0030 A7:

  ```
  CommitProposalInput += { exceptions?: { check, target: ObjectId, reason }[] }
  ```

  Each becomes a `core.CheckException { check, checkVersion, target, reason }`, `stated`, with
  statement evidence, in the same change set. Agents and models cannot give one.
- Advisory failures never block.

A deterministic run builds alternatives that pass by construction. The checks still run, so a
hand-edited or model-drafted proposal (K6b) gets the same gate.

### 9. The output and the run record

A run never commits (ADR 0029 I4). Its output is **one project proposal** holding, in order: pins of
newly selected items, Questions, Assessments (superseding earlier ones for the same item, scenario,
element and nature), the Decision if new, Alternatives with `basis` and `alternativeOf`, and the
gap Questions. Its rationale names the run.

A **run** is operational data outside the event log (ADR 0029, like Navigator runs, ADR 0010), in a
`method_runs` table (store schema 6):

```
MethodRun { id: run_…, projectId, startedBy, origin, startedAt, finishedAt,
            input: MethodRunInput,
            pinned: { method: KnowledgeRead, libraryUses: { id, library, revision }[],
                      projectRevision, engineVersion, checkCatalogueVersion },
            status: "running" | "proposed" | "failed",
            selection: { candidates: { pin | item, sources: { source, path?, score? }[] }[],
                         cut: …same…[], ideas: …[], excluded: …[] },
            uncertainties: { kind, concept?, scenario, element?, nature, detail }[],
            comparison: …,  checks: { check, version, target, passed, detail }[],
            proposal?: ProposalId, failure?: { code, message },
            cost: { modelCalls: 0, microUsd: 0 } }
```

**State transitions.** `running` → `proposed`, or `running` → `failed`. Runs are synchronous and
short, so there is no pause state. A run is never edited; a re-run is a new run whose input names
the earlier one (`previous`). If the proposal is later rejected or goes stale, the run says so on
read, from the proposal's status.

**Determinism.** The same input, project revision and library revisions give the same selection,
assessments, comparison, checks and proposal operations, apart from ids and times. A test hashes
the run's outputs with ids and times masked, twice.

### 10. Failure behaviour

| Situation | Behaviour |
|---|---|
| The method pin is unresolved, or not a `knowledge.Method` | `failed`, `method.not_resolved`; nothing proposed |
| The method has a `model` step | `failed`, `method.model_steps_not_enabled` |
| No scenario or no nature given, or one not active | refused before the run starts (`invalid`) |
| A library the project uses is absent | its items are not selected; listed as "library not present"; the run continues if any candidate remains, else `failed`, `method.no_candidates` |
| The caller cannot read a library the project uses | refused before the run starts: `unauthorized`, `method.library_read_required`, naming the libraries; no run is recorded |
| More assessments than `maxAssessments` | `failed`, `method.too_many_assessments`, naming the product |
| A pin cannot be resolved when assessing | that candidate is listed with the reason, not assessed, not proposed |
| The proposal is invalid (for example the decision is no longer open) | `failed`, with the proposal's issues; no proposal is left pending |
| The proposal goes stale before commit | shown on read; the person re-runs |
| A mandatory check fails at commit | the commit is refused with `check.failed` unless a person gives an exception (§8) |

A failed run keeps everything it computed, so a person can see how far it got.

### 11. Interfaces

The service methods `startMethodRun`, `getMethodRun` and `listMethodRuns` are the one interface
(ADR 0002). K6a exposes them through the K4 operation table as `run_method` (writes: it files a
proposal, as `propose_change` does), `get_method_run` and `list_method_runs`, over MCP and HTTP with
the parity test. A view in the knowledge explorer and a CLI command follow the same contracts, in
later slices. A portable skill (docs/design/portable-methods.md) will describe a method and call
`run_method` through MCP; no generator is built.

### 12. Evaluation before any model

The worked example's expected run (below) is written down before coding, reviewed by Philip, and
frozen as a test fixture with its hash. The engine must reproduce it. K6b is later measured against
the same fixture: a model may add alternatives or explanations, but must not lose a candidate,
a Question or a ruled-out verdict that the deterministic run finds.

## Worked example: synchronisation for the multi-game platform

**Method** (to be added to the real-time networking seed as a proposed item, from its existing
sources): "Choose a state synchronisation model". `appliesTo`: `software.Container`, scenarios
needed. `needs`: Deterministic simulation, Predictable entity motion. Steps, all deterministic:
select (`uses`: deterministic lockstep, authoritative server, snapshot interpolation), assess
(produces assessment, question), compare (produces alternative). Checks: the four mandatory ones and
both advisory ones.

**Run:** element Arena shooter and RTS; scenarios Launch and Expansion; nature expected.

**Expected, before any code** (to be confirmed against the seed when the fixture is written):

- Selection: the three explicit patterns; dead reckoning through `parameter` (its
  `unsuitableWhen` names Predictable entity motion, which has a parameter in Expansion); entity
  interpolation through `graph` (`competesWith` dead reckoning); client-side prediction (`refines`
  authoritative server) and lag compensation (`requires` it) through `graph`. The principle "Do not
  trust the client" is shown as a constraint, since authoritative server realises it; no source
  makes it a candidate.
- Questions: Predictable entity motion (expected) for the RTS in both scenarios and for the
  shooter in Launch (three); "Which conditions must hold for …?" for each candidate that declares
  nothing that must hold: authoritative server, client-side prediction, entity interpolation,
  snapshot interpolation and dead reckoning (whose only condition is an exclusion), five. Lag
  compensation declares `requires`, so it is not underspecified; its verdict is unknown because
  the authoritative server's is.
- Assessments: 7 candidates × 2 scenarios × 2 elements × 1 nature = 28. Lockstep met for the RTS in
  both scenarios and for the shooter in Launch (through Launch's system-wide value), not met for
  the shooter in Expansion; dead reckoning not met for the shooter in Expansion, unknown elsewhere;
  every other candidate unknown.
- Alternatives (six; client-side prediction refines authoritative server, so it is shown under it):
  lockstep, covering three contexts and ruled out for the shooter in Expansion; dead reckoning,
  covering three (unknown) and ruled out for the shooter in Expansion; authoritative server,
  snapshot interpolation, entity interpolation and lag compensation, covering four unknown
  contexts each. Underspecified and `worsens` items are disclosed.
- Gaps: one, for the shooter in Expansion (expected values); elsewhere lockstep is met.
- Checks: all pass. Cost: zero model calls.

The exact expectation is frozen in `deploy/knowledge/fixtures/multi-game-method-run.json`, written
from the seed before the engine is built.

## Generalisation

Nothing above names a discipline. A database-scaling library (concepts: write rate, dataset size,
consistency requirement; patterns: read replicas, sharding, CQRS) or an accessibility library
(concepts: input modality, colour contrast need; principles: perceivable alternatives) runs through
the same phases. One acceptance test runs the engine on a small non-networking library to show it.

## Review against existing ADRs

| ADR | Point | Result |
|---|---|---|
| 0006 | People commit and decide (D4) | Kept: a run only proposes; acceptance and exceptions are a person's |
| 0010 | Runs are operational data | Kept: `method_runs` beside `navigator_runs` |
| 0026 I5 | Hypotheses never decide | Kept: listed as ideas only |
| 0028 | Explicit nature, conservative unknowns, recomputed assessments | Kept |
| 0029 §4 | Pause for answers, hypothesis drafting | Not used in K6a; both are "may". Deviation recorded here |
| 0029 §5, I7 | Exceptions "in the same proposal" | Refined: given with the commit, as ADR 0030 A7, because a run's proposal is filed before a person sees the failure. Same change set, so the invariant holds |
| 0029 §7 | MCP write is `propose_change` only | Extended: `run_method` also files a proposal; it adds no other write |
| 0029 I3, I4 | Model steps through the gateway; one project proposal | Kept: no model steps; one proposal |
| 0030 A2, A7 | Curation and changes to established knowledge | Unaffected: the run writes only to the project |
| 0031, 0032 | Read authorisation and delegation | Kept: selection beyond pins needs library read |
| Roadmap | K6 is "methods with a model" | Split into K6a (this) and K6b |

**No approved invariant changes.** Two contract additions need approval: `core.Alternative` v2
(`basis`) and `core.CheckException`, with `CommitProposalInput.exceptions`. Store schema moves to 6.

## Acceptance tests

1. The worked example reproduces the frozen fixture: selection with every source per candidate,
   the cut list, Questions, assessments, alternatives with `basis`, the comparison, checks and one
   proposal; and the same hash on a second run.
2. Selection order and cut follow the fixed order at `maxCandidates` below the candidate count;
   a candidate reachable only lexically is found beyond `maxHops` (ADR 0029 tests 6, 12).
3. A method with a model step fails with `method.model_steps_not_enabled`; a run's cost is zero.
4. Each mandatory check fails on a crafted proposal and passes on the corrected one; advisory
   failures never block (ADR 0029 test 7).
5a. Coverage keeps exact contexts: in one scenario, a pattern met for the RTS and not met for the
    shooter has the first assessment in `covers` and the second in `ruledOut`. A basis that lists a
    `conditionsNotMet` assessment in `covers`, lists one context in both, cites an assessment of an
    item it does not rely on, or leaves a pin without an assessment, is refused with
    `alternative.basis_inconsistent`.
5. A failed mandatory check refuses the commit and the acceptance of the alternative; a person's
   exception with a reason allows it and appears in history; an agent's is refused (ADR 0029
   test 11).
6. Permissions: an agent with project read and propose, and read on the libraries, can run; an
   agent with only the ADR 0032 delegation is refused with `method.library_read_required`, and so is
   one missing read on any used library; a stranger is refused; nobody's run commits.
7. Failures of §10 each produce their status and reason, and leave no pending proposal when failed.
8. After answering a Question and re-running, the new run's assessments supersede the earlier ones,
   and the earlier run shows its proposal as committed or stale.
9. The engine runs unchanged on a small non-networking library.
10. `run_method`, `get_method_run` and `list_method_runs` return the same over MCP and HTTP; access
    control as in K4.
11. Export, import and replay of a project after a committed run reproduce its state hash; runs,
    as operational data, are not exported, and the proposal's rationale names the run.

## Not in K6a

Model drafting, hypothesis filing, cross-store proposals (K6b); councils or orchestration of several
methods; the portable-skill generator; an explorer view and CLI for runs (later slices, same
contracts); pausing runs.

## Amendment of 2026-10-30, after review

Philip approved the architecture, Alternative v2 and CheckException, with two amendments, made
above:

- **A1. Exact coverage.** `covers` and `ruledOut` list assessment ids, so each entry keeps its
  scenario, element and nature. The kernel refuses an inconsistent basis, and the two mandatory
  checks about coverage read assessments, never scenario lists. Gap Questions are per exact
  context. Test 5a.
- **A2. No implicit widening for delegated agents.** A run needs read access to every library the
  project uses, and is refused otherwise. There is no snapshot-only evaluation path; the ADR 0032
  delegation stays a read of pinned versions. Test 6.

Neither changes an invariant. The worked example's expectation is frozen in
`deploy/knowledge/fixtures/multi-game-method-run.json`, written before the engine.

## Implementation notes (K6a, 30 October 2026)

Where building K6a had to settle something the contract above left open, I chose the narrowest
reading and record it here for review. None changes an invariant.

- **Checks apply to alternatives with a `basis`.** An alternative without one (every version 1
  record, and those people write by hand) is not checked, as before; otherwise every existing
  decision would fail `alternatives-cite-assessments`. K6b's model-drafted alternatives will carry a
  basis, so they meet the gate.
- **A disclosed hypothesis needs no assessment.** The evaluator never assesses a hypothesis (ADR
  0026 I5: its verdict is `notAssessed`), so the basis rule "every pin has a listed assessment"
  would make `hypotheses-labelled` unreachable and `unbacked` meaningless. A pin listed in
  `disclosed.hypotheses` is exempt from that rule and from `alternatives-cite-assessments`, and the
  check fails if the pin is not in fact a hypothesis at its pinned revision.
- **An exception must answer a failure.** An exception for a check that passes, or for a target it
  does not fail on, is refused (`check_exception.not_failing`), so exceptions are never recorded
  in advance.
- **Gap Questions follow the `question` steps.** §1's table drives gaps from steps producing
  `hypothesis`; the seed method has none, yet the frozen fixture expects the gap. Since K6a files a
  Question, not a hypothesis, gaps are asked whenever the method asks Questions. A method that
  asks no Questions gets none.
- **The `parameter` source reads parameters only.** A Question cannot name a pinned concept today
  (`concerns` targets objects, and a pin is evidence), so "or open Question" has nothing to match.
- **Selection by graph** records, for each item, the fewest hops from another item selected by the
  other sources, with the relations followed. An item reached only from itself has no graph source.
- **The run record** also gives each candidate's pin (an existing one or the one the run files),
  the libraries not present, the proposal's status read on demand, and `outputSha256`: SHA-256 of
  the outputs and operations in canonical JSON with every id and version hash replaced by its order
  of first appearance. Version hashes are masked because they hash content that holds ids.
- **BM25** moved from `packages/eval` to `packages/core`, which eval re-exports, since eval depends
  on core. One implementation ranks both.
- **The non-networking example** is a test library about database scaling
  (`packages/core/test/method-libraries.ts`), with placeholder sources. It is test data, not a
  seed.
