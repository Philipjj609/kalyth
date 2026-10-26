# 0029. Assessments, their freshness, and methods that use knowledge

Date: 2026-10-27. Status: Proposed, for review before any code. Builds on ADRs 0010, 0011, 0023,
0026, 0027 and 0028. It replaces the `core.Method` placement proposed in KAL-20261024-048: a method
is reusable knowledge, held in a library, and a run of it is operational data in a project.

## Context

An assessment is a conclusion about a project: whether a piece of knowledge applies to an element
in a scenario. It depends on knowledge versions, parameters, scenarios, correspondences, decisions
and the evaluator, and on the method when a method produced it. When any of those change, it must
say so, and it must never be quietly rewritten. Methods must select knowledge and investigate
deterministically, use a model only to draft, check what they produce, and say when the knowledge
is inadequate rather than stretch it.

## Decision

### 1. Assessments

```
core.Assessment {
  item: KnowledgePin,                    // the pattern or principle assessed
  element?: LocalRef,                    // [] = the whole system
  scenario: LocalRef<Scenario>,
  verdict: "applies" | "doesNotApply" | "unknown" | "excepted" | "conflicting" | "notAssessed",
  explanation: Explanation,              // ADR 0028, section 6
  inputs: DependencySet,
  producedBy: { kind: "evaluator" | "method" | "person", evaluatorVersion,
                method?: KnowledgePin, run?: RunId },
  override?: { verdict, reason }         // a person's verdict; the computed one is kept beside it
}
```

Its claim is `inferred` when Kalyth or a method computed it, and `stated` when a person overrode
it. Its support groups cite the knowledge pins and the parameters' evidence. Assessments are never
edited. A recomputation is a new Assessment that `supersedes` the old one, so the history of how a
conclusion changed is kept.

### 2. Dependencies

```
DependencySet {
  knowledge: KnowledgePin[],             // every object and relation version traversed
  parameters: { id, version }[],         // including those resolved through base scenarios
  scenarios: { id, version }[],          // the scenario and its base chain
  correspondences: { id, version }[],    // ADR 0027, when used across libraries
  decisions: { id, version }[],          // ADR 0027, when a decision settled a conflict
  libraryUses: { id, revision }[],
  method?: KnowledgePin,
  evaluatorVersion
}
```

The evaluator records exactly what it read, nothing more. That is checked by a test that evaluates
with a recording reader and compares.

### 3. Freshness

An assessment is **current** when every dependency still holds:

| Dependency | Holds when |
|---|---|
| knowledge pin | the project's LibraryUse for that library, at its current revision, resolves the item to the same `versionSha256` |
| parameter, scenario, correspondence, decision | not retired or superseded, and its current version is the recorded one |
| library use | its revision is the recorded one, or a later one under which every pinned item keeps its hash |
| method | the pinned method version is still the method's current version |
| evaluator | the evaluator version is unchanged; otherwise it is stale, with reason "evaluator changed" |

Otherwise it is **stale**, with one reason per broken dependency, and computed on read, as decision
facets are (ADR 0023). Staleness spreads one level, to what cites the assessment:

- alternatives and decisions get a new facet, `knowledge`, with the values current, stale,
  conflicting or unknowns open;
- context packages (ADR 0011) report it when revalidated on read.

Nothing is recomputed automatically. "Reassess" makes a proposal of superseding assessments, with
a diff of verdicts, which a person commits.

### 4. Methods

```
knowledge.Method {
  name, purpose,
  appliesTo: { elementTypes: TypeName[], needsScenarios: boolean },
  needs: LocalRef<Concept>[],            // parameters the method reads
  steps: Step[],
  checks: CheckId[]                      // from a fixed, versioned catalogue (section 5)
}
Step { id, title, uses: LocalRef[], reads: LocalRef<Concept>[],
       mode: "deterministic" | "model" | "person",
       produces: ("assessment" | "question" | "alternative" | "hypothesis")[] }
```

A **run** is operational data, like a Navigator run (ADR 0010), outside the event log. It records
its pinned inputs: the method version, the LibraryUse revisions and the project revision. Its
output is one proposal. A run proceeds:

1. **Select.** Starting from each step's `uses`, Kalyth follows `competesWith`, `refines` and
   `requires`, two hops at most, within the pinned libraries. The candidates are listed with how
   each was reached. No model is involved.
2. **Ask.** Missing parameters become Questions. The run may pause until they are answered.
3. **Assess.** One Assessment per candidate, element and scenario, by the evaluator of ADR 0028.
4. **Draft** (model steps only). Through the gateway, with its consent, budget and schema checks, a
   model drafts Alternatives that cite assessments and knowledge pins. Grounding extends to
   knowledge: a quote must match the pinned content.
5. **Find gaps.** If no candidate applies in some scenario, or a model step names a need that no
   pinned knowledge addresses, the run proposes a **hypothesis**:
   - to a library: a `knowledge.Pattern` or `knowledge.Principle` with maturity `hypothesis`, its
     rationale, and the project's need as a case document (never project source, ADR 0026). This
     needs a `knowledge.propose` grant on that library, and the library's curator decides;
   - in the project: an Alternative marked `unbacked`, citing the hypothesis proposal, so a person
     sees that it rests on an idea no library holds yet.
6. **Check.** The method's checks run on the draft (section 5). Failures are listed with the draft;
   they do not delete it.
7. **Decide.** A person reviews the proposal: a change thread as today, then hand-off and
   reconciliation.

### 5. The check catalogue (version 1)

Checks are code, named and versioned, never free text or scripts carried by a library.

| Check | Fails when |
|---|---|
| `alternatives-cite-assessments` | an alternative relies on a pattern without citing its assessment |
| `no-reliance-on-ruled-out` | an alternative relies on a pattern assessed `doesNotApply` in a scenario it claims to cover |
| `worsens-disclosed` | a `worsens` trade-off of a relied-on pattern is missing from the alternative's trade-offs |
| `disputed-flagged` | disputed knowledge is relied on without saying so |
| `unknowns-asked` | an `unknown` verdict has no Question for its missing parameter |
| `hypotheses-labelled` | an alternative relies on a hypothesis without being marked `unbacked` |

"Verified" in a method's output means these checks and grounding passed. It never means the design
works at runtime (R4).

### 6. Exploring knowledge, beyond the graph

The explorer is a set of connected, readable views. The graph is one of them.

- **Library index:** subjects (the roots of `isA`), patterns and principles by quality addressed,
  with search over names and aliases.
- **Concept, pattern and principle pages:**
  - definition, or problem and solution;
  - consequences and trade-offs as a table of qualities improved and worsened;
  - conditions, limitations and exceptions in plain sentences;
  - competing, refining and required items;
  - maturity, disputes and open Questions;
  - history across revisions.
- **Evidence panel:** each source with its `SourceMeta` and licence, its quotes or locators, and,
  per citation, whether it **matches** and whether its **support** has been reviewed (ADR 0026).
- **Comparison:** two to four competing patterns side by side: trade-offs, conditions and, inside a
  project, their verdicts per scenario.
- **Contextual applicability**, inside a project: for an element, the knowledge that applies, does
  not apply, or is unknown in each scenario, each with its explanation table, and the Questions
  that would settle the unknowns.
- **Graph:** neighbourhoods of one or two hops around a focus, with lenses by type, quality,
  condition and dispute. It is never the whole library.
- **Navigation:** breadcrumbs and back links between all of these, and from any project claim to
  the pinned knowledge it cites.

### 7. Agents and other interfaces

The services are the same for every door. HTTP mirrors MCP, with a parity test.

- **MCP, read:**
  - `search_knowledge` (libraries in use; names, aliases, subjects);
  - `get_knowledge` (by pin, or by id at a revision; with sources, conditions, trade-offs, maturity
    and support status);
  - `assess_applicability` (item, element, scenario; computes and explains without creating an
    Assessment);
  - `list_assessments` (with freshness);
  - `get_method`.
- **MCP, write:** `propose_change` only, as today. In a library it needs `knowledge.propose`.
- **Context packages:** an optional section with the assessments and knowledge pins an accepted
  decision relies on, with their freshness.
- **CLI:** `knowledge:import`, `knowledge:export` and `knowledge:check` (library validation).

## Invariants

- I1. Assessments are immutable; change happens by superseding.
- I2. Freshness is computed on read from recorded dependencies; nothing is recomputed silently.
- I3. A method's model steps go through the gateway, with its consent, budget and grounding checks.
- I4. A run never commits; its output is one proposal.
- I5. Hypotheses enter a library only as proposals its curator decides on, and never through
  project source.
- I6. Checks come from a code catalogue with versions; libraries cannot carry executable checks.

## Migration consequences

- `core.Assessment` is a new type; the `knowledge` facet extends ADR 0023's facets, as an additive
  field in decision summaries.
- Method runs need a run store beside `navigator_runs`, operational and outside the event log, as
  today.
- Context package results gain an optional section; existing packages are unchanged.
- The evaluator version becomes part of assessments. Changing the evaluator makes every assessment
  stale with a clear reason, which is the honest behaviour.

## Test cases (for K3 to K6)

1. Changing a parameter makes exactly the assessments that read it stale, with that reason, and
   not the others (recording-reader test).
2. Moving a LibraryUse where a pinned pattern's hash changed makes its assessments stale; a move
   where nothing pinned changed keeps them current.
3. Retiring a correspondence used across libraries makes the dependent assessment stale.
4. Reassessing produces superseding assessments and a verdict diff, and keeps the old ones in
   history.
5. A decision with a stale assessment shows `knowledge: stale` in its facets.
6. A method run on the game test case lists its candidates with how each was reached, asks one
   Question for deterministic simulation, and produces assessments for launch and peak.
7. Each check of the catalogue fails on a crafted draft and passes on a corrected one.
8. With every candidate ruled out at peak, the run proposes a hypothesis to the library (when
   granted), and an `unbacked` alternative in the project.
9. HTTP and MCP return the same results for each read tool.
10. Views: browser tests with axe for the pages, the evidence panel, the comparison and contextual
    applicability, in both themes and at phone width.

## Trade-offs left open

- Dependency sets are verbose. They are compact pins, and freshness is computed on read with a
  cache keyed by project revision and LibraryUse revisions.
- Two hops of selection may miss relevant knowledge far away in the graph. That is accepted to keep
  runs bounded and explainable; the hop count is a method setting, recorded in the run.
- A fixed check catalogue limits what libraries can enforce. That is intended until checks
  themselves can be reviewed and tested like code.
