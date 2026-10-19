# 0022. Proposed elements and statement evidence

Date: 2026-10-19. Status: accepted (D2 in KAL-20261019-034, with ChatGPT's refinement). Builds on
ADRs 0005, 0010 and 0015; part of the direction in ADR 0020.

## Context

The product audit (KAL-20261019-033) found that a project could not start from an idea:

- an alternatives run on an empty project failed, because every direct change had to name an
  existing element;
- the Navigator could not introduce anything new, even on a real repository (an `Organisation`
  entity for multi-tenancy);
- nothing a person said could be cited, so inferences about a greenfield idea rested on nothing.

ChatGPT's refinement: a person's statements are evidence of what they said or intend, never
observations of real behaviour. The basis of a claim and its verification must stay separate (R4).

## Decision

**Proposed elements.**

- Alternatives and refine runs may declare `newElements`, numbered P1, P2, ...:
  - a type: `software.Container`, `software.Component`, `software.DataEntity` or
    `software.Endpoint`;
  - a name (for an endpoint, `METHOD /path`);
  - a description and a confidence;
  - the N or earlier P ref of the container it belongs in, or none;
  - optional citations.
- A direct change may name an N ref or a P ref. Every alternative still names at least one direct
  change, so an alternative on an empty project names the new elements it introduces.
- The Navigator creates a proposed element only when a kept direct change uses it, or when it
  contains one that is. It is created as a `toBe` object with an `inferred` claim. Its containment
  is a `toBe` `contains` relation, and the change is an `impacts` relation, as before.
- The proposal reports a rejected item for each of these:
  - an unused element;
  - a malformed endpoint name;
  - a repeated ref;
  - a container that cannot contain.
- Later runs list `toBe` elements marked `[proposed]`, so the model does not propose them again.
- The analyzer only touches records it observed itself, so re-analysis never retires a proposed
  element. When the code later implements one, the observed element is a separate record. Linking
  the two (`realizes`) is part of reconciliation (ADR 0020).

**Statement evidence.**

- The text a person typed to start a run is shown to the model as statement S1, which it may cite
  like a source excerpt. The grounding validator checks the quote against the person's exact
  words.
- When a kept item cites it, the run's proposal records it as evidence with the existing
  `statement` source (`statedBy`: the person who started the run). The evidence is collected by
  `kalyth-navigator`, holds the words verbatim, and is cited by local ref in the same proposal.
- Claims that cite a statement keep the basis `inferred`. A statement is never `observed`, and it
  never counts as verification. It has no source snapshot, so it does not go stale.

**Questions** may carry `options`, up to 4 suggested answers. The Decisions view offers them as
choices, and a person may still answer in their own words.

**In the UI:**

- A person can create a project, naming it and describing the idea.
- On a project with no elements, the Navigator form starts from that idea.
- Proposal review names proposed elements as "(proposed)".

## Alternatives

- **Uncited "unsupported" claims for greenfield work.** No new evidence use, but model claims
  would cite nothing.
- **Allowing alternatives with no direct change.** Simpler, but an alternative would no longer say
  what it changes.
- **Recording every request as evidence**, cited or not. It would fill the evidence store with
  text nothing relies on.
- **Recording answers to questions as statements too.** Answers stay stated attributes of their
  question for now. The refine prompt shows them, but they cannot be cited yet, because the
  version record does not say who answered.

## Consequences

- The Navigator's prompts, output schema and context changed. Recorded requests no longer match,
  so the hosted demo's presets need one re-recording (D5, with Philip's go-ahead). Tests make their
  own recordings and are unaffected.
- Run output gains `newElements`. Runs stored earlier read it as 0.
- The mock provider answers an empty project with proposed elements and a citation of the request.
  So the idea-first journey works without a paid model, including one citation the validator
  must reject.
- The canvas shows committed proposed elements like other elements until its redesign draws them
  as drafts (ADR 0020).
