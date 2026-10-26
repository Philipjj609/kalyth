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
dimensions is `incompatible`. That is an error the validator reports, never a false result.

### 2. Scenarios

```
core.Scenario { name, order: int, description, base?: LocalRef<Scenario> }
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

**Resolution of a parameter** for a condition, a scenario and an element:

1. a parameter scoped to that element in that scenario;
2. else one scoped to the whole system in that scenario;
3. else the same steps up the `base` chain of scenarios;
4. else none, which makes the condition `missing`.

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
| Pattern | **doesNotApply** if any `unsuitableWhen` is true or any `appliesWhen` is false; **applies** if every `appliesWhen` is true and every `unsuitableWhen` is false; otherwise **unknown** |
| Pattern with `requires` | as above, AND the verdicts of the required patterns. `requires` among knowledge items is acyclic, checked by the library validator |
| Principle | **excepted** if any `exceptWhen` is true; **applies** if every `appliesWhen` is true and every `exceptWhen` is false; otherwise **unknown** |
| Hypothesis (any type) | **notAssessed**: never a verdict, but listed as an idea to consider (ADR 0026, I5) |
| Several libraries | each library separately. If definite verdicts disagree (applies against doesNotApply), the result is **conflicting**. A definite verdict beside an unknown is reported as such, with the unknown noted. A Decision may settle a conflict (ADR 0027) |

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
7. A hypothesis pattern is `notAssessed` and listed, never `applies`.
8. Unsatisfiable `appliesWhen` bounds on one concept fail library validation.
9. Property tests: evaluation is deterministic, and monotonic. Narrowing an interval never turns
   `true` into `false`, or the reverse.

## Trade-offs left open

- No probability distributions: intervals carry uncertainty, without weights. Distributions would
  make verdicts probabilistic, which is not wanted until there is evidence they help.
- Linear units only. Offset scales such as °C and logarithmic ones such as dB are excluded until a
  concept needs them.
- Being conservative yields many `unknown` verdicts at first. That is intended: each one asks for
  a parameter, rather than guessing.
