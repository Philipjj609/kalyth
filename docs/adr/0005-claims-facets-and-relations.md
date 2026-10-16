# 0005. Claims, epistemic facets, evidence support and relation registry

Date: 2026-10-16. Status: accepted. Refinements R2 and R4 (KAL-20261016-005/006).

## Context

The product separates observed, inferred, intended, proposed, accepted, implemented and verified,
as independent dimensions rather than one status ladder. Refinement R2: claim freshness needs
explicit support semantics. Refinement R4: "observed" means a tool observed a source fact under
coverage limits, not verified runtime behaviour.

## Decision

Every object and relation carries a claim. The facets map to separate fields:

| Facet | Field |
|---|---|
| Where knowledge comes from | `basis`: observed, inferred, stated, imported |
| Reality or intention | `stance`: asIs, toBe |
| Authority over intent | Decision and Alternative `status`, changed only by `setDecisionStatus` |
| Implemented | a `realizes` relation from an asIs element, with fresh evidence |
| Verified | Verification objects linked by `verifies`, with outcome and evidence |
| Existence over time | `lifecycle`: active, retired |

Claim rules enforced at validation:

- `observed` requires an `observation` (tool, version, coverage, limitations), at least one
  supporting evidence group, no model provenance, no confidence, and source evidence rather than a
  statement (R4). Fresh source evidence is never treated as verification.
- `inferred` requires a confidence level with rationale; an inference about existing reality must
  cite evidence or the claims it derives from. Inferred intended designs need no grounding.
- `imported` requires supporting evidence; `stated` needs none.
- Referenced evidence and derived-from claims must exist; a claim cannot derive from itself.

Evidence support (R2): `supports` is a list of groups. All evidence in a group is jointly required;
groups are independent alternatives. A claim is supported while at least one group is entirely
fresh (`isClaimSupported`). Derived and summarised claims are not independent corroboration of
their sources. Freshness itself (evidence fingerprints against a newer source snapshot) is computed
by the analyzer gate.

Relation types are registered with allowed endpoint types, optional source stance, acyclicity,
cardinality limits, symmetry, temporal flag and an impact rule (none, sourceToTarget, targetToSource,
both) for later impact traversal. The starter set covers containment, dependency, interfaces, data
access, realisation, requirements, constraints, decisions, supersession, contradiction, temporal
order, verification and questions.

## Consequences

Object types are strict: unknown attributes are invalid. Domain packs (`core`, `software`) are
registries, so further domains add types without schema changes. The tutoring and creative examples
remain illustrative type packs, not claims of domain expertise.
