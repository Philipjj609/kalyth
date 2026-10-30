# Design: the engineering knowledge fabric

Status: proposed specification, not implemented. Written on 26 October 2026 on the branch
`future/engineering-intelligence`, after the submission of v0.1.0, which it does not change. It
details part 1 of [the roadmap](../roadmap/engineering-intelligence.md) and the parts of 2, 3 and 6
that knowledge needs. ChatGPT reviewed it and Philip approved it as the basis for K0 on 26 October.
The contracts are now ADRs 0026 to 0029, amended after ChatGPT's final review on 27 October. They
take precedence over this document where they differ. Among the differences:
- verdicts are `conditionsMet`, `conditionsNotMet`, `unknown`, `excepted`, `conflicting` and
  `notAssessed`, and assert declared conditions only;
- maturity is a lifecycle, and dispute is a computed overlay;
- quote match, source verification and support review are separate;
- canonical form v1 is frozen with test vectors, and pinned content is embedded in the project;
- parameters have specificity rules, and nothing is derived from scale;
- selection has several relevance sources;
- mandatory checks block acceptance without a recorded exception;
- hypotheses are filed as linked proposals.

Two smaller differences: the relations `exceptWhen` and `realizesPrinciple`, and the types
`core.LibraryUse` and `core.Correspondence`.

## 1. The problem, stated narrowly

Kalyth 0.1.0 knows what a project is: elements read from source (`observed`), what people said
(`stated`), and what a model proposed (`inferred`), each citing its evidence. It does not know
engineering: that rollback netcode needs a deterministic simulation, that a read replica trades
freshness for read capacity, or that an expand-and-contract migration keeps old and new code
working together. The Navigator's model brings such knowledge implicitly, uncited and unversioned.

The goal is to make that knowledge explicit, sourced and connected, and to let it meet a project
without becoming a fact about the project. It is not a library of articles, prompts or skills.
The unit is a claim about engineering, with its sources, its conditions and its trade-offs. A
project conclusion that uses it says which version it used, and why it applies.

Initial subjects: system design and architecture; scalability, capacity and distributed systems;
databases, storage and migration; networking, concurrency and reliability; security and
operations; and how they interact in one application.

## 2. Design principles, and what each rules out

1. **One store.** Knowledge lives in the kernel as typed objects and relations, with revisions,
   proposals and events. This rules out a separate knowledge database, a vector store as the
   source of truth, and documents that the kernel cannot check.
2. **Knowledge and project facts never mix.** A project fact says "this code does X". Knowledge
   says "in general, X brings Y under conditions Z". The kernel enforces the line (section 5).
3. **Every piece of knowledge cites its sources**, and every project conclusion cites both the
   knowledge it uses, pinned to a version, and the project evidence for each condition it checks.
4. **Deterministic where possible.** Kalyth computes applicability, impact and freshness itself;
   a model drafts, maps and proposes, and its output is checked as today.
5. **Few new types.** A new type must carry structure that the kernel checks or a view needs.
   Prose belongs in attributes, not types (section 10 lists what was rejected).

## 3. Where knowledge lives: library projects

A **library** is an ordinary Kalyth project whose purpose is knowledge, for example
"Kalyth engineering library: real-time networking". It uses the same kernel, revisions,
proposals, authorisation, event log, export and import. It differs only in three ways:

- it registers the `knowledge` pack (section 4) and no `software` elements;
- its claims may not cite project source code, so a library never depends on a project;
- commits need a new scope, `knowledge.curate`, given to its curators.

A **project** pins a library at a revision. Revisions are immutable, so a pin is stable, exactly as
a source span is pinned to a commit. Updating a library makes a new revision; projects move to it
only when someone accepts the change (section 6).

Why not one global knowledge graph, or relations across projects? A relation across projects would
break what the kernel guarantees per project: rebase checks at the head (R1), one transaction per
commit, export and replay of a project on its own (R3). Pinned references keep each project
self-contained.

## 4. The knowledge pack: objects and relations

### Object types (pack `knowledge`, in libraries)

| Type | What it holds | Key attributes |
|---|---|---|
| `knowledge.Concept` | A defined idea, quantity or quality: tick rate, round-trip time, players per match, linearizability, write amplification, availability | `name`, `aliases`, `definition`, `kind` (term, quantity, quality), `unit` for quantities |
| `knowledge.Principle` | A normative rule with its rationale: validate every client action on an authority; make retried writes idempotent | `statement`, `rationale` |
| `knowledge.Pattern` | A reusable solution with its forces and structure: lockstep, rollback, server authority with client prediction, read replicas, sharding by key, outbox, expand-and-contract migration | `name`, `problem`, `solution`, `structure` (prose), `aliases` |
| `knowledge.Condition` | A testable statement about a project, over a quantity concept or a property | `subject` (a Concept, by local reference), `operator`, `value`, `unit`, `text` |
| `knowledge.Method` | A reusable way to carry out a piece of engineering work, with steps (section 7) | `name`, `purpose`, `steps`, `outputs`, `checks` |

Each claim has the usual basis: `imported` when taken from a source (a book, paper, RFC, vendor
documentation, at a version and locator); `stated` when a curator asserts it; `inferred` when a
model drafted it, in which case it must cite sources and is dropped otherwise, as today.

### Relation types (pack `knowledge`)

| Relation | From → to | Meaning | Rules |
|---|---|---|---|
| `isA` | Concept → Concept | specialisation (RTT is a latency) | acyclic |
| `refines` | Pattern → Pattern | a variant (rollback refines optimistic simulation) | acyclic |
| `addresses` | Pattern, Principle → Concept | the force or problem it deals with | |
| `affects` | Pattern → Concept (quality) | a trade-off: `effect` improves, worsens or mixed, with `note` | |
| `appliesWhen` | Pattern, Principle → Condition | applicability; several conditions are jointly required | |
| `unsuitableWhen` | Pattern → Condition | a limitation; any one rules the pattern out | |
| `competesWith` | Pattern → Pattern | alternatives for the same problem | symmetric |
| `uses` | Method → Concept, Pattern, Principle | knowledge a method consults | |

Core relations are reused where their meaning already fits: `requires` (a pattern needs another,
such as rollback needing deterministic simulation), `contradicts` (two claims that disagree),
`supersedes` (a newer version of a piece of knowledge), and `concerns` (a `core.Question` about a
knowledge object). Reusing them means widening their allowed endpoints in the registry, a new
version of each relation type, recorded in ADR 0026. None of the new relations has impact rules on
project elements, because knowledge is not a project element.

Trade-offs, limitations and applicability are relations to quality concepts and conditions, not
objects of their own. That keeps them queryable ("what worsens consistency?") without new types.

## 5. How knowledge meets a project

### Pinned knowledge evidence

A new evidence kind, beside `sourceSpan`, `document`, `external` and `statement`:

```
{ kind: "knowledge", library: prj_…, revision: 12, object: obj_…, versionSha256: "…" }
```

It is an immutable pointer to one knowledge object version, with the hash of its canonical
content. Its excerpt is stored as content, so a project export stays self-contained and replays
(R3). Export becomes format 2 (format 1 still imports).

### Three project types (pack `core`)

| Type | What it holds | Why it is needed |
|---|---|---|
| `core.Scenario` | A named load and context, ordered: launch (1,000 daily players), growth (100,000 concurrent), peak (5 million concurrent, global) | The same project gets different answers under different scenarios |
| `core.Parameter` | A project quantity or property in a scenario: players per match, peak concurrent users, target action latency, deterministic simulation (yes, no or unknown) | Conditions are evaluated against these, with evidence |
| `core.Assessment` | A conclusion: whether the declared conditions of a piece of knowledge are met for an element in a scenario, with each condition's evaluation | The project-specific conclusion, kept apart from both knowledge and facts |

A Parameter is usually `stated` (a person gives the expected load) and sometimes `observed` (a
constant read in source, such as a tick rate). It names its quantity by pinned knowledge evidence
to the Concept, so "players per match" means the same thing in every project.

An Assessment has `verdict` (conditions met, not met, unknown, and the others of ADR 0028), the scenario, the element it
concerns, and one entry per condition: the condition (knowledge evidence), the parameter used
(project evidence), and the result. Its claim is `inferred` when computed by Kalyth or drafted by
a model, and `stated` when a person overrides it, with a reason.

### Separation rules, enforced by the kernel

1. An `observed` claim may cite only `sourceSpan` evidence. Knowledge can never become an
   observation of the project. This extends R4.
2. A library may not cite `sourceSpan` evidence of a project, and may pin another library only at
   an existing revision. A library therefore never depends on a project, and pins cannot form a
   live cycle.
3. An Assessment must cite the knowledge it evaluates and, for every condition marked true or
   false, the project evidence behind the parameter. A condition without a parameter makes the
   verdict `unknown` and raises a `core.Question` asking for it.
4. Knowledge objects are never copied into a project. Views show them through their pins, in a
   distinct style, labelled with the library and revision.

### Freshness

Freshness (ADR 0009) extends to knowledge pins. When a project moves to a newer library revision,
any assessment whose cited knowledge changed hash is reported stale, with what changed. A stale
assessment is recomputed as a proposal, never silently. A parameter whose evidence changed makes
its assessments stale in the same way.

## 6. Sourcing, validation, challenge and change

- **Sourcing.** Curators add knowledge through proposals. An importer can turn a curated source
  (for example a chapter of a reference book, an RFC or vendor documentation) into proposed
  `imported` claims, with `document` evidence giving the source, its version and a locator, and
  stored quotes. A model may draft knowledge from given sources; its claims are `inferred`, and
  each quote must occur in the cited source text (ADR 0017's rules).
- **Validation**, checked on every library commit:
  - every knowledge claim cites at least one source or statement;
  - every Pattern has at least one `affects` trade-off, and either an applicability or a
    limitation condition, or an open Question saying none is known;
  - every Condition's subject is a quantity or property Concept with a unit where it needs one;
  - Concept names and aliases are unique within the library.
- **Challenge.** Anyone with proposal rights can propose a contradicting claim with its own
  evidence, linked by `contradicts`, or open a Question. A disputed object stays usable, but every
  assessment that cites it shows the dispute and its sources. A curator resolves it with
  `supersedes`, or keeps both with their conditions.
- **Change.** Library revisions are immutable, and a release is a named revision. Projects update
  their pins by accepting a proposal, which lists the knowledge that changed and the assessments
  that go stale. Libraries travel as exports (ADR 0014), checked by `stateSha256`. They are not
  signed yet, so only trusted libraries are imported; signing is a later ADR.

## 7. Methods that use knowledge

A `knowledge.Method` is reusable and lives in a library. Running it in a project is a run, like a
Navigator run today, and its result is a change thread.

A method declares:

- **what it applies to:** project element types, and the scenarios it needs;
- **the parameters it needs:** quantity Concepts, such as players per match and target latency;
- **its steps:** each an investigation with the knowledge it `uses`, the parameters it reads and
  what it produces (Assessments, Alternatives, Questions);
- **its checks:** deterministic conditions its output must meet before it is offered for review.

How a run proceeds:

1. **Select knowledge, deterministically.** Candidates come from several bounded sources: the
   method's `uses`, the project's parameters and element types, typed relations in the pinned
   libraries, lexical matches and people. Each candidate records how it was reached, and every cut
   is listed (ADR 0029). No model is involved.
2. **Ask for what is missing.** Every condition without a parameter becomes a Question. A run can
   stop here and wait for answers.
3. **Assess, deterministically.** Each candidate pattern gets an Assessment per scenario, with
   each condition's result and evidence.
4. **Propose.** A model, through the gateway, drafts Alternatives that combine applicable
   patterns. Each change cites project evidence, and each design choice cites knowledge evidence.
   The grounding validator extends to knowledge pins: a quote must occur in the pinned knowledge
   content.
5. **Check.** The method's checks run: every alternative cites the assessments it relies on;
   none relies on a pattern whose conditions are not met; every `worsens` trade-off of a chosen
   pattern appears in the alternative's trade-offs; disputed knowledge is flagged. Failures are
   always shown. A failed mandatory check blocks acceptance unless a person records an exception
   with a reason (ADR 0029).
6. **Decide.** A person compares and decides, as today; hand-off and reconciliation follow.

"Verified" means these checks and grounding passed, not that the design will work at runtime
(R4). Whether methods improve outcomes is measured by evaluation (roadmap part 5).

## 8. Exploring knowledge as a person

- **Library graph.** The canvas, with knowledge types instead of software types. It always shows
  a neighbourhood (one or two hops around a focus), never the whole library. Lenses: by type; by
  quality ("what improves availability, and what does it cost?"); by condition ("what stops
  applying above 8 players per match?"); disputes.
- **Concept and pattern view.** One readable page: definition or problem and solution; sources
  with versions and quotes; a trade-off table (qualities improved and worsened); conditions and
  limitations; competing and required patterns; disputes and open questions; history; and, within
  the same store, the projects and assessments that cite it.
- **In a project.** A knowledge lens on the canvas marks elements with assessments. Selecting an
  element shows the knowledge whose conditions are met, not met or unknown in each scenario, and
  an assessment opens as a table
  of conditions, parameter values, evidence and results, with a scenario switch from launch to
  peak.

## 9. Coding agents

The same services, through the existing doors:

- **MCP (read):** `search_knowledge`; `get_knowledge` (an object at a pinned revision, with its
  sources, conditions and trade-offs); `assess_applicability` (deterministic, read-only: patterns,
  an element and a scenario give verdicts and the parameters missing); `get_method`.
- **Context packages** gain an optional section of the knowledge an accepted decision relies on,
  with pins, so an agent implements against the same knowledge the person decided with.
- **MCP (write):** agents propose, never commit: `propose_change` in a project as today, and in a
  library only with `proposal.create` on that library (ADR 0030).
- **HTTP** mirrors MCP, with a parity test. **CLI:** `knowledge:import`, `knowledge:export`, and
  `knowledge:check` for a library's validation rules.

## 10. Challenging this design

**Abstractions considered and rejected**

- A `TradeOff` object: a relation with properties carries the same, and stays queryable.
- `Limitation` and `Applicability` objects: conditions on relations express both.
- A `Source` object: evidence records already hold sources with versions and locators.
- A topic taxonomy: `isA` between concepts, and tags, are enough until shown otherwise.
- `Skill` or `Prompt` objects: a method's steps hold what a skill would, and prompts stay in code.

**Abstractions kept, and their risk.** Principle and Pattern are close. If curators cannot tell
them apart consistently, Principle merges into Pattern (open question 1). Scenario could be a
plain attribute of Parameter; it is an object because assessments and comparisons are per
scenario.

**Circular dependencies.** Libraries never depend on projects (rule 2). `isA` and `refines` are
acyclic in the registry. Between libraries, pins are to existing immutable revisions, so they
cannot form a live cycle. Freshness propagates one pin deep, and the first slices use one library.

**Data migration.**

- The new evidence kind extends a union. Old stores need no change, and old exports still import.
- The export format moves to version 2 to carry knowledge content.
- New types are additions to the registry; no existing type changes.
- The canonical content hash behind `versionSha256` must be fixed in the ADR, since changing it
  later would invalidate every pin.
- R3 holds: assessments are ordinary objects in the event log.

**Unsupported claims to avoid.**

- Imported knowledge is as good as its source, no better; the source is always shown.
- An assessment is only as true as its parameters, and stated parameters are assumptions.
- A model-drafted pattern is a hypothesis until a curator commits it.
- Nothing here shows that knowledge improves designs. Only evaluation can, against the 0.1.0
  baseline.
- The first library will be small. Kalyth must never present it as complete.

**Scale.** Libraries of thousands of objects are within current query paging. Views show
neighbourhoods, and assessment is per element and scenario, so cost grows with what a person
asks for.

## 11. Test case: a multi-game platform

The platform has single-player puzzles, turn-based multiplayer, and real-time multiplayer, under
three scenarios: **launch** (1,000 daily players, one region, one database), **growth** (100,000
concurrent players, several regions), and **peak** (5 million concurrent players, global, with
competitive play).

The library content below is illustrative; real content must cite real sources.

| Subject | Knowledge the case needs | Where subjects interact |
|---|---|---|
| Architecture | separate modes as services or as modules of one service; authoritative server | A modular monolith at launch, split by mode at growth: the conditions are team size and the load per mode |
| Networking and concurrency | lockstep, rollback, server authority with prediction; tick rate, RTT and jitter as quantities | Rollback `requires` deterministic simulation. If that parameter is unknown, the verdict is unknown and a Question is raised, not a guess |
| Scalability and capacity | matches sharded by match id; stateless gateways; connection fan-out; regional placement | Real-time matches pin to a region, while turn-based matches move freely. Capacity is planned per mode and scenario |
| Databases and migration | an event log of moves versus state snapshots; expand-and-contract migrations | Changing a rule set while turn-based matches are in progress needs versioned rules and replayable moves, so the migration and the game design depend on each other |
| Reliability | draining servers before deploys; recovering a session after a server fails | Real-time matches cannot move mid-match, so deploys drain; turn-based matches recover from the log |
| Security and operations | never trust the client (Principle); rate limits; cheat detection | Competitive play at peak forces server authority, which rules out pure lockstep for ranked modes |

What the test checks: the same real-time mode gets different, explained answers at 4 and at 64
players per match, and at launch and at peak. A missing parameter yields a Question instead of a
verdict. Each answer cites both its knowledge pins and the project's stated parameters.

## 12. Implementation slices

Each slice keeps the full test suite green, changes no existing contract outside its ADR, and
stays off main until reviewed.

| Slice | Scope | Acceptance criteria |
|---|---|---|
| **K0. ADRs** | ADR 0026: library projects and the `knowledge` pack. ADR 0027: knowledge evidence, separation rules, export format 2 and the canonical hash. ADR 0028: Scenario, Parameter and Assessment. ADR 0029: methods that use knowledge (replacing the `core.Method` placement of KAL-048) | Reviewed by ChatGPT and approved by Philip; open questions answered |
| **K1. Library kernel** | The `knowledge` pack registered; library projects; the validation rules of section 6; `knowledge.curate`; a seed library of about 20 objects on real-time networking, from cited sources | Uncited knowledge is refused. A pattern without a trade-off fails validation. `isA` and `refines` cycles are refused. Export and import of the library round-trip `stateSha256` |
| **K2. Pins and separation** | Knowledge evidence; content storage; export format 2; freshness for pins | An `observed` claim citing knowledge is refused. A library citing project source is refused. Moving a pin reports the assessments whose knowledge changed. Format 1 still imports, and replay reproduces the state |
| **K3. Deterministic assessment** | Scenario, Parameter, Assessment; condition evaluation; Questions for missing parameters | In the game test project, the three netcode patterns get the expected verdicts at 4 and 64 players and at launch and peak, each condition with its evidence. A missing determinism parameter gives `unknown` and one Question. Property tests cover operators and units |
| **K4. Agent and API access** | Read-only MCP and HTTP tools; the optional package section | Claude Code over MCP retrieves pinned knowledge and an assessment for the test project. HTTP and MCP return the same results (parity test). No new write path |
| **K5. Views** | Library graph neighbourhoods, concept and pattern pages, the knowledge lens and the assessment table | Browser tests with axe in both themes and at phone width. A concept page shows sources, trade-offs, conditions and disputes |
| **K6. Methods with a model** | Method runs, model drafting through the gateway, extended grounding and checks | Only after K1 to K5, with a spend approval. Proposals cite knowledge pins and project evidence; uncited items are dropped; results are measured against a frozen truth for the game case |

K1 to K3 need no model calls and no spending. K4 and K5 are read-only.

## 13. Open questions for Philip

1. Keep Principle separate from Pattern, or merge them until curators need the difference?
2. Who curates the first library, and from which sources (books, RFCs, vendor documentation)?
   Licences limit how much of a source may be quoted.
3. Are parameters observed from code, such as a tick-rate constant, worth the analyser work in K3,
   or are stated parameters enough at first?
4. Should a project be able to pin more than one library from the start, or only one until K6?
