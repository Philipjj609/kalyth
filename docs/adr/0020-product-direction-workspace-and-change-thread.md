# 0020. Product direction: one workspace, change threads and the Drafting Table language

Date: 2026-10-19. Status: accepted (Philip, KAL-20261019-034, on the audit in KAL-20261019-033).
Model contract changes it calls for get their own records when they are built.

## Context

The product audit of 19 October (KAL-20261019-033) found the kernel sound but the product hard to
use from start to finish:

- one change request was spread over five views;
- the canvas was unreadable at its default zoom and read-only;
- the model could describe only code that exists, so a project could not start from an idea;
- impact was too coarse to tell alternatives apart;
- staleness never reached the decisions, packages and tasks built on stale claims;
- completing a task did not update the model.

## Decision

**Interaction model: one model, many lenses; one change, one thread.**

- One workspace replaces nine equal tabs:
  - a left rail with the model outline, search and the list of changes;
  - the canvas or a change thread in the centre;
  - a panel that appears only when something is selected.
- Every action lives in one registry, reachable from a command palette, context menus and the
  panel.
- A change thread is the main working surface. It takes one request through its stages: ask,
  interpret, alternatives, compare, questions, decide, hand off, agent report, reconcile.
- Tasks, history and records stay reachable on their own, so independent work and the audit
  trail are not hidden inside threads.
- The canvas shows the same model through lenses instead of extra nodes:
  - claim basis;
  - freshness;
  - an alternative's impact;
  - decisions.
  Editing on the canvas creates a proposal, as every other change does. Moving or arranging
  elements stays presentation and changes nothing in the model.

**Visual language: Drafting Table.**

- It borrows from engineering drawings: paper and ink surfaces, hairline rules, a light drafting
  grid on the canvas, technical type (IBM Plex Sans and Mono), and a single signal colour for
  decisions.
- Claim basis is drawn as line language:
  - solid ink for observed;
  - a dashed pencil line for inferred;
  - an annotation mark for stated.
- Changed or stale areas carry a revision mark.
- The language is applied with restraint. Readability and a calm workspace come before
  ornament, and it is not a literal blueprint.

**Model direction (contracts to follow in their own records).**

- *New and greenfield elements.*
  - The Navigator may propose new elements.
  - An alternative may change nothing that exists, as on an empty project.
  - People may add, connect, rename and retire elements through proposals.
- *Statements as evidence.*
  - What a person says (an idea, an answer, a constraint) is recorded as evidence of what they
    said or intend.
  - Claims grounded in it keep the basis `stated`. It never becomes `observed` and never counts
    as verification (R4).
- *Separate facets, not one lifecycle.* Each of these is tracked on its own and may be partial:
  - decision acceptance;
  - implementation progress;
  - verification against the repository;
  - freshness of the evidence.
  No single state such as "implemented" replaces them.
- *Freshness that propagates.*
  - Staleness reaches the decisions, packages and tasks that rest on stale claims.
  - Packages are revalidated when read and before consequential use.
  - Commit-time revision checks and permissions stay as they are.

**Concurrency.** A warning that the head has moved supplements compare-and-swap validation at
commit and never replaces it. Stale proposals are still refused. Rebase semantics (R1) stay
unchanged before submission.

**Third-party UI code.** React Bits is a reference only. Its licence (MIT with the Commons Clause)
restricts redistribution, so none of its code is copied.

**Priorities when time runs short (D7).**

- Protected:
  - the main story: concept or repository, alternatives, decision, task, a real agent,
    evidence, reconciliation;
  - reliable verification;
  - reconciliation.
- Cut first:
  - optional visual refinement;
  - extra semantic-zoom levels;
  - convenience interactions.
- Where verification covers a single commit, the product says so, rather than claiming
  end-to-end verification. Mocked or scripted stand-ins in rehearsals and the video are
  disclosed.

## Alternatives

- **Quiet instrument.** A neutral, dense, dark-first look. Lower risk, but it says nothing about
  what Kalyth is.
- **A single "implemented" decision state.** Simpler to show, but it would hide partial work and
  conflate what was decided with what was built and what was checked.
- **Uncited "unsupported" claims for greenfield work.** No new evidence kind, but it would weaken
  the rule that model claims cite evidence.

## Consequences

- The web app's views are reorganised around the workspace and the change thread. Existing
  components are reused as stages.
- Navigator prompt and schema changes alter recorded request hashes. They are batched, and the
  hosted demo's presets are re-recorded once, with Philip's go-ahead (D5).
- New surfaces get the same automated accessibility and keyboard checks as the current views.
