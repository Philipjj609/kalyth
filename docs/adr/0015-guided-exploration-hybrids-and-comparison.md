# 0015. Guided exploration, hybrid alternatives and comparison

Date: 2026-10-18. Status: accepted. Tier B (Journey 1 in the Phase 0 review, section 13); builds
on ADR 0010 (Navigator) and ADR 0011 (decisions handed to agents).

## Context

A person often starts with a vague idea rather than a precise change. Phase 0 planned Journey 1:
from the idea to alternatives, hybrids and questions, with the same Navigator, and a comparison
view to choose between them. The alternatives run (ADR 0010) already frames a decision with 2 to 4
alternatives and up to 3 questions. Three things were missing:

- hybrids;
- a way to use the answers to those questions;
- a side-by-side comparison.

## Decision

**Hybrids.** An alternative may combine others.

- The model numbers alternatives A1, A2, ... and gives each a `combines` list: the earlier
  alternatives a hybrid combines, or nothing.
- The kernel records each link as a `combines` relation (core pack) from the hybrid to each
  alternative it combines. The relation is acyclic and has no impact rule.
- A link to an alternative that is not listed before the hybrid is rejected and reported in the
  run's grounding report, as an invalid citation is. The alternative itself stays.
- An alternatives run may now return up to 5 alternatives, so one hybrid fits beside four others.

**Guided refinement.** An alternatives run may name an open decision (`decisionId`).

- The run sees:
  - the decision;
  - its alternatives, in creation order, as A1 to Ak;
  - its answered questions with their answers, and its open questions;
  - the elements its alternatives change, first in the context.
- The output adds 1 to 4 alternatives and up to 3 questions to that decision, through its own
  output schema (`RefineOutput`, with no decision), a prompt (`REFINE_SYSTEM`) and the purpose
  `navigator.refine`.
- New alternatives continue the numbering, so a hybrid may combine existing and new ones.
- A decision that is not open is refused when the run starts.
- As with every run, the result is one pending proposal by the Navigator. Runs are started by a
  person over HTTP only, and spend only within the budget ledger.

**People answer questions** in the Decisions view. The answer is the question's `answer`
attribute and `status: answered`, proposed and committed by the person at once.

**Comparison** (the Decisions view):

- every decision, open ones first;
- for the chosen one, each alternative's summary, trade-offs, basis, confidence, questions and
  hybrid parents;
- a matrix of the elements each alternative changes, with changes shared by every alternative
  first;
- each alternative's reach through impact, and what only it reaches.

A person accepts an alternative there, through the same proposal as in the Navigator (ADR 0010).

## Alternatives

- **Hybrids as plain alternatives with "hybrid" in the title.** No structure: the comparison could
  not say what a hybrid combines, and a person could not trace it.
- **A conversational loop with the model.** It would hold more state outside the kernel. Answers
  as kernel records keep the loop in history, and each step is a reviewable proposal.
- **Re-running the original request.** It would make a second decision for the same question.
  Refinement adds to the open decision instead.

## Consequences

- One relation type is added to the core pack (`combines`). The run input gains an optional
  `decisionId`, and the model output gains a required `combines` field. Recorded Nebius
  responses made before this change no longer match the schema, so replays must be recorded
  again; none exist yet.
- The mock provider now proposes a fourth alternative, a hybrid of A and C. A refinement adds one
  refined alternative and a hybrid of the first two existing ones. Demo rehearsal notes that count
  three alternatives are out of date.
