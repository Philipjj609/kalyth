# 0028. Scenarios, parameters and deterministic applicability

Date: 2026-10-27. Status: Proposed, for review before any code. Builds on ADRs 0005, 0026 and 0027.

## Context

Whether a pattern or principle applies to part of a project depends on facts about the project:
players per match, expected load, latency targets, whether the simulation is deterministic. Those
facts are often estimates, ranges or unknown. They differ between a small launch and a very large
audience, and sometimes the evidence contradicts itself. Kalyth must decide applicability
deterministically, explain every verdict, and never turn an unknown into a yes or a no.

Philip's decision: K3 starts with stated parameters. The contracts also cover parameters observed
in source and, later, measured at runtime, without building new analysers now.

## Decision

### 1. Dimensions and units

Every quantity Concept (ADR 0026) has one `Dimension`. Units convert within a dimension by exact
rational factors, without offsets, so no float error enters a comparison.

| Dimension | Base unit | Units (factor to base) |
|---|---|---|
| time | s | ns, µs, ms, s, min (60), h (3600), d (86400) |
| dataSize | B | B, kB (10³), MB (10⁶), GB (10⁹), TB (10¹²), KiB (2¹⁰), MiB (2²⁰), GiB (2³⁰), TiB (2⁴⁰) |
| dataRate | B/s | bit/s (1/8), kbit/s, Mbit/s, Gbit/s, B/s, kB/s, MB/s, GB/s |
| frequency | 1/s | Hz, 1/min (1/60), 1/h, 1/d |
| count | 1 | 1 (integers only) |
| ratio | 1 | 1, % (1/100) |
| money | (per currency) | none: different currencies are incompatible, never converted |
| boolean, category | none | none |

Values are decimal strings, parsed to exact rationals. Comparing two values of different
dimensions is `incompatible`. That is an error the validator reports, never a false result. The
unit catalogue has its own version, and it is part of `evaluatorVersion`. Adding a unit therefore
marks assessments stale with a clear reason (ADR 0029).

### 2. Scenarios

```
core.Scenario { name, order: int, description, base?: LocalRef<Scenario>,
                status: "assumed" | "planned" | "committed", rationale }
```

`order` sorts scenarios from small to large. `base` lets a scenario inherit parameters from
another and override some. The chain of `base` is acyclic, and every inherited value names the
scenario it came from in explanations.

### 3. Parameters

```
core.Parameter {
  concept: KnowledgePin,                 // a quantity or property Concept (ADR 0027)
  scope: { scenario: LocalRef<Scenario>, elements: LocalRef[] },   // [] = the whole system
  nature: "current" | "expected" | "target" | "limit",
  value: ParameterValue,
  provenance: "stated" | "sourceObserved" | "runtimeMeasured",
  note
}

ParameterValue =
  | { kind: "point", value: Decimal, unit }
  | { kind: "interval", min?: Decimal, max?: Decimal, unit,
      minInclusive: boolean, maxInclusive: boolean }   // a range or an uncertainty band
  | { kind: "boolean", value: boolean }
  | { kind: "category", value: string }                // one of the Concept's allowed values
  | { kind: "unknown", reason: string }                // asked, and nobody knows yet
```

**Provenance ties to the claim basis.**

- `stated`: basis `stated`, with a statement by the person who gave the value.
- `sourceObserved`: basis `observed`, with `sourceSpan` evidence (for example a constant
  `TICK_RATE = 30`). The contract exists now; analysers that produce it come later.
- `runtimeMeasured`: reserved. R4 keeps `observed` for static source facts, so a measurement
  needs its own basis (`measured`) and evidence kind (`measurement`: a source system, a window
  and a statistic). Both are introduced by a later ADR. Until then, the validator refuses this
  provenance.

**Uncertainty** is an interval: "between 50,000 and 120,000 concurrent players". An estimate is a
`stated` interval with a note. **Unknown** is an explicit value, distinct from a missing parameter.
It means someone looked and could not say.

**Contradiction.** Two committed parameters with the same concept and scope (scenario and
elements) whose values differ are a conflict. It is not resolved by intersection, average or
recency. Both are kept, and evaluation reports `contradictory` with both values (section 4). A
person resolves it by retiring one, or by stating a new parameter that `supersedes` both.

**Specificity and overrides.** A parameter's scope is a scenario, plus an element list (empty means
the whole system). For a condition evaluated on element E in scenario S, the parameter used is the
most specific one, found in this order:

1. In S: a parameter whose elements include E.
2. In S: one whose elements include E's nearest `contains` ancestor, then the next ancestor, and
   so on up to the system.
3. In S: one scoped to the whole system.
4. The same three steps in S's `base` scenario, then its base, and so on. The scenario comes
   first: a system-wide value in S overrides an element value in a base scenario. S is the context
   being assessed, and its author chose to state that value for it.
5. Otherwise none, which makes the condition `missing`.

A parameter may be scoped to proposed (to-be) elements, so a project still in design can be
assessed. A parameter scoped to a retired element is never used, and is reported as dangling until
it is retired too.

A more specific parameter overrides a broader one **for that element only**. Siblings keep using
the broader value. A parameter scoped to several elements applies to each of them equally. Only
parameters at the same step for the same element, with different values, conflict (see
Contradiction above). The explanation records the step that resolved each value, for example
`element`, `ancestor:<id>`, `system`, or `base:<scenario>/system`.

### 3a. Missing requirements and uncertain scenarios stay visible

- **Nothing is derived.** Kalyth never infers one parameter from another: not "needs several
  regions" from five million players, nor "needs sharding" from a write rate. A value a condition
  needs is stated, observed or measured, or it is missing. A model may suggest a value, but only
  as a proposed parameter, which a person commits as `stated`.
- **Scenarios carry their own certainty:** `status` (assumed, planned or committed) and `rationale`
  (section 2). Both are shown with every verdict computed in that scenario. A verdict in an
  `assumed` scenario reads as conditional on that assumption.
- **Missing stays missing.** A missing or `declared-unknown` parameter gives `unknown` and one
  open Question. The Question stays open, and is listed with every assessment that needed it,
  until someone answers it. Scale never fills the gap.

### 4. Evaluating one condition

`ConditionTest` (on `knowledge.Condition`, ADR 0026):

```
ConditionTest =
  | { op: "lt" | "le" | "gt" | "ge" | "eq" | "ne", value: Decimal, unit }
  | { op: "between", min: Decimal, max: Decimal, unit }        // inclusive
  | { op: "is", value: boolean }
  | { op: "in", values: string[] }
```

Results: `true`, `false`, `unknown`. Each carries a reason: `missing`, `declared-unknown`,
`straddles`, `contradictory`, `no-correspondence`, `incompatible` or `notAssessed`.

- **Point:** convert both values to the base unit and compare exactly.
- **Interval:** `true` if the test holds for every value in the interval, `false` if it holds for
  none, otherwise `unknown` with reason `straddles`. Open ends are handled as unbounded.
- **Boolean and category:** compared directly. A category outside the concept's allowed values is
  a validation error.
- **Declared unknown, missing, contradictory, or no correspondence** (ADR 0027): `unknown`, with
  that reason. A missing parameter raises a `core.Question` naming the concept, scope and unit.
- **Incompatible dimensions:** `unknown` with reason `incompatible`, and a validation error on
  whichever side is wrong.

### 5. Verdicts

Conditions combine in three-valued logic: AND is false if any operand is false, true if all are
true, and unknown otherwise; OR is the dual.

| Item | Verdict |
|---|---|
| Pattern | **conditionsNotMet** if any `unsuitableWhen` is true or any `appliesWhen` is false; **conditionsMet** if every `appliesWhen` is true and every `unsuitableWhen` is false; otherwise **unknown** |
| Pattern with `requires` | as above, AND the verdicts of the required patterns. `requires` among knowledge items is acyclic, checked by the library validator |
| Principle | **excepted** if any `exceptWhen` is true; **conditionsMet** if every `appliesWhen` is true and every `exceptWhen` is false; otherwise **unknown** |
| Hypothesis (any type) | **notAssessed**: never a verdict, but listed as an idea to consider (ADR 0026, I5) |
| Several libraries | each library separately. If definite verdicts disagree (conditionsMet against conditionsNotMet), the result is **conflicting**. A definite verdict beside an unknown is reported as such, with the unknown noted. A Decision may settle a conflict (ADR 0027) |

**What a verdict means, and does not mean.** `conditionsMet` means only that every condition the
library declares for the item holds for the given parameters. It does not mean that the pattern is
appropriate, best, sufficient or safe for the project. Undeclared considerations, the library's
coverage, and the alternatives' trade-offs remain for people to weigh. `conditionsNotMet` means a
declared condition rules the item out; it does not mean nothing like it could work. Views say
"conditions met" and "conditions not met", never "applies" or "recommended".

**Disputed** knowledge still gets a verdict, flagged as disputed with both sides' sources.

### 6. Explanations

Every verdict comes with a trace, a pure function of its inputs:

```
Explanation { item: KnowledgePin, verdict, evaluatorVersion,
              steps: [{ condition: KnowledgePin, relation: "appliesWhen" | "unsuitableWhen" | "exceptWhen" | "requires",
                        parameter?: { id, version, resolvedFrom: "element" | "system" | "base:<scenario>" },
                        value?: canonical value in base unit, test, result, reason }] }
```

The same inputs always give the same trace (a property test). Views render it as a table that
answers "why", one row per condition.

### 7. Library validation for conditions

- A Condition's subject must be a quantity or property Concept; its unit must belong to the
  concept's dimension.
- Within one pattern, `appliesWhen` tests on the same concept whose numeric ranges cannot overlap
  (players < 4 and players > 8) are unsatisfiable. That is a validation error, so a pattern can
  never be defined so that it never applies.
- An `appliesWhen` and an `unsuitableWhen` on the same concept that always overlap are reported as
  a warning, with a Question.

## Invariants

- I1. No conversion across dimensions or currencies.
- I2. Unknown, missing, contradictory and straddling values never yield `true` or `false`.
- I3. Two parameters for one concept and scope are never merged.
- I4. A verdict is reproducible from its explanation's recorded inputs.
- I5. `runtimeMeasured` is refused until its basis and evidence kind exist.
- I6. No parameter is derived from another; a missing value stays missing and asked.
- I7. A more specific parameter overrides a broader one only for its own element; the resolution
  step is always recorded.
- I8. `conditionsMet` asserts only the declared conditions, and is never presented as a
  recommendation.

## Migration consequences

- `core.Scenario` and `core.Parameter` are new core types. `Dimension` and units are a new
  contract module, versioned on its own, since adding a unit changes evaluation.
- No existing type changes. The `measured` basis is not added now; it is reserved by name.

## Test cases (for K3)

1. Unit conversion: 100 ms equals 0.1 s; 1 GiB is greater than 1 GB; 1 USD against 1 EUR is
   `incompatible`.
2. An interval [50, 120] tested `gt 100` gives `unknown` (straddles); `gt 40` gives `true`;
   `gt 200` gives `false`.
3. A missing players-per-match gives `unknown` with reason `missing`, and one Question.
4. Two stated values, 4 and 64 players, for one scope give `contradictory`; retiring one gives a
   definite verdict.
5. Scenario inheritance: peak inherits latency from growth; the explanation names growth.
6. The game test case: lockstep, rollback and server authority with prediction get the expected
   verdicts at 4 and 64 players and at launch and peak. Rollback is `unknown` while deterministic
   simulation is unknown.
7. A hypothesis pattern is `notAssessed` and listed, never `conditionsMet`.
8. Unsatisfiable `appliesWhen` bounds on one concept fail library validation.
9. Property tests: evaluation is deterministic, and monotonic. Narrowing an interval never turns
   `true` into `false`, or the reverse.
10. Specificity: a system-wide value of 8 players and a value of 64 on the real-time mode give 64
    for that mode and 8 for its sibling. Both values at the same step for the mode conflict. A
    system value in `peak` overrides an element value in `growth`, and the explanation names the
    step.
11. No derivation: setting peak concurrent players to five million changes no other parameter, and
    a condition on region count stays `unknown` with an open Question.
12. A verdict computed in an `assumed` scenario carries the scenario's status and rationale in its
    explanation.

## Trade-offs left open

- No probability distributions: intervals carry uncertainty, without weights. Distributions would
  make verdicts probabilistic, which is not wanted until there is evidence they help.
- Linear units only. Offset scales such as °C and logarithmic ones such as dB are excluded until a
  concept needs them.
- Being conservative yields many `unknown` verdicts at first. That is intended: each one asks for
  a parameter, rather than guessing.
