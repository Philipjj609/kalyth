# Roadmap: engineering intelligence after 0.1.0

Status: proposal, not implemented. Written on 26 October 2026 on the branch
`future/engineering-intelligence`, cut from the competition release `v0.1.0`. Nothing here
changes the released version. Each part needs an ADR, reviewed by ChatGPT and approved by Philip,
before any code.

The aim is one system, not a set of features. Kalyth 0.1.0 already has the spine: a typed model of
a codebase, claims that say where they come from, proposals that people commit, revisions and
events that replay. The work ahead adds what Kalyth knows, how work is done, who does it, how well
it works, and how people and agents reach it. Each addition plugs into that spine rather than
beside it.

## What stays

- **The kernel is the only store of engineering knowledge.** Typed objects and relations, claims
  with a basis (R4) and evidence groups (R2), proposals validated against a base revision with
  rebase checks (R1), and an event log that reproduces the state (R3). New knowledge arrives as
  new types and new producers of proposals, never as a parallel store.
- **Everything automated proposes; people decide.** Agents, models, analysers and councils write
  proposals and critiques. A person, or a policy a person approved and can audit, commits.
- **Contracts grow by registry.** New object and relation types, with their impact rules and
  invariants, are registered and versioned. A breaking change to a contract needs an ADR.
- **Every model call** keeps the gateway's guarantees: catalogue, consent, a reserved worst case,
  schema-checked output and citations checked against pinned evidence.

## The six parts, and how they fit

```
                       Interaction: UI · MCP · CLI · HTTP API   (one service layer)
                                          │
        Orchestration ── runs ──▶ Methods ── use ──▶ Capabilities (models, analysers, agents, tools)
              │                      │                         │
              └──── proposals, critiques, questions ───────────┘
                                          ▼
               Knowledge fabric: kernel + type packs + domain knowledge (claims with basis)
                                          ▲
                Evaluation and evolution: outcomes, frozen truths, method versions
```

### 1. An extensible knowledge fabric

Today the registry knows software: systems, containers, modules, endpoints, data entities. A
**type pack** adds a domain's vocabulary to the same registry: its object types, relation types
with impact rules, invariants, the analysers that can observe them, and the evidence they cite.
Packs are versioned, and a project declares which it uses. The software pack is the first; a game
pack is the worked example below.

Sources widen too, each with an honest basis. Source code stays `observed`. Documents, ADRs and
tickets are `stated` (someone said it) or `imported`. Runtime measurements (traces, load tests)
need their own basis or a declared coverage, because R4 keeps `observed` for static source facts
and never means runtime verification. That choice is an ADR question, not a default.

### 2. Reusable methods and capabilities

A **method** is a named, versioned way of doing a piece of engineering work, as a kernel object
(proposed in KAL-20261024-048 as `core.Method`). It states what it applies to (element types), its
steps, the evidence each step needs, what it produces (the shape of its proposals), and how its
result is verified. Examples: assess the impact of a schema change; choose a synchronisation model
for a game mode; threat-model an endpoint.

A **capability** is something that can carry out a step: a model role through the gateway, an
analyser, a coding agent through MCP tasks, a test runner. It declares what it can produce or
verify, its cost and how far it is trusted. Methods bind to capabilities by what they need, not by
name, so a better model or tool can replace another without changing the method.

Today's hand-off is already a method in disguise: the agent policy, the task prompt and the git
verifier encode one way of implementing a decision. Making it explicit is the first migration.

### 3. Domain knowledge

Engineering judgement rests on knowledge no repository contains: patterns, trade-offs, standards,
failure modes. **Domain knowledge** enters the fabric as `imported` claims with their sources and
versions, kept apart from facts observed in a project. A model may cite it as evidence for an
inferred claim, as it cites source today. It never becomes an observation of the project.

Knowledge is curated and versioned like code, and a project chooses which bodies of it to trust.

### 4. Council and multi-agent orchestration

A **council** is a method run by several capabilities in roles: proposers, critics, a domain
expert, a verifier. They do not chat freely. Each writes kernel objects: proposals, critiques that
cite what they dispute, and questions. A deterministic aggregator, not a model, merges the
proposals, keeps every disagreement as an open question and computes impact. The result is one
change thread, as today, with more voices in it, and a person still decides.

Orchestration reuses what exists: task leases for work, the spend ledger for budgets per run, the
event log for audit, rebase checks when runs overlap. Councils are useful only when a role adds
something measurable, which part 5 must show.

### 5. Evaluation and evolution

Every method and capability is evaluated against frozen truths, as the independent evaluation of
October 2026 does for context packages. Reconciliation already closes a loop: it shows whether an
implemented change matched its decision. Those outcomes, with verification results, become
evidence about how well a method works.

**Evolution** is a proposal like any other: a new method version, with the evaluation evidence
that it does better, reviewed and committed by a person. Nothing modifies itself silently, and
every result is reported whatever it is.

### 6. Interaction through the UI, MCP, CLI and API

One service layer, four doors, with a published parity table of what each can do:

- **UI** for understanding and deciding: the canvas with lenses per type pack, change threads,
  comparisons, and method runs shown as threads with their steps.
- **MCP** for agents: reading, proposing, tasks, and invoking methods within their granted scope.
- **CLI** for scripts and CI: ingest, freshness checks, evaluations, export.
- **HTTP API**, versioned, for integrations.

## A worked example: a multi-game platform

A platform with three kinds of game is demanding enough to test every part:

- **Single-player puzzles:** deterministic rules, generated content that must stay solvable, and
  offline play.
- **Turn-based multiplayer:** persistent, asynchronous matches; moves validated on the server;
  timeouts and notifications.
- **Real-time multiplayer:** an authoritative server, a tick loop, netcode, matchmaking, regions
  and latency, and a cheating surface.

How the parts apply:

1. **Fabric.** A game pack adds types such as `Game`, `Mode`, `RuleSet`, `StateModel`, `Action`,
   `Match`, `Session`, `Matchmaker`, `TickLoop` and `SyncModel`, and relations such as
   `governs`, `validates`, `synchronises` and `persists`. Its invariants include "every
   multiplayer action is validated by an authority" and "every real-time mode declares its
   synchronisation model". Impact rules say that a change to a `RuleSet` reaches move validation,
   clients, replays and saved matches.
2. **Methods.** For example: choose a synchronisation model for a mode (lockstep, rollback, or
   server-authoritative with client prediction), design persistence for asynchronous matches, or
   assess the cheating surface. Each states its inputs, such as latency tolerance and player
   count, and the questions only people can answer, such as whether cross-platform play is
   required.
3. **Domain knowledge.** Netcode patterns and their trade-offs, matchmaking approaches and
   puzzle-generation techniques, each imported with its sources.
4. **Council.** A proposer drafts synchronisation alternatives; a latency-and-cost critic and a
   security reviewer cite what they dispute; a verifier checks the result against the pack's
   invariants. Disagreements become questions in the change thread.
5. **Evaluation.** Frozen truths on open-source game servers, for changes such as adding spectator
   mode to a turn-based game. The question is whether an agent with Kalyth's context and methods
   completes them more fully and correctly than without.
6. **Interaction.** Canvas lenses per mode and synchronisation model. An agent implements a new
   mode as an MCP task, and reconciliation shows what the commit changed.

The example also shows the limits honestly: static analysis cannot observe frame timing or real
latency, so those claims need the runtime basis of part 1 or stay `stated`.

## Order of work

1. **ADRs first, no code.** Type packs and registry growth; `core.Method` and capabilities (ADR
   0026); a basis for runtime measurements and imported knowledge; councils as kernel objects; the
   interface parity table. Each is reviewed by ChatGPT and approved by Philip.
2. **The independent evaluation** of 0.1.0 runs and is reported. It is the baseline that every
   later part must beat.
3. **The fabric:** type packs, with the software pack migrated, and the game pack as a prototype.
4. **Methods and capabilities:** the hand-off as the first explicit method, then two more.
5. **Domain knowledge** as imported, sourced claims.
6. **Councils** on top of methods, kept only where evaluation shows a role adds something.
7. **Evaluation and evolution** as a standing loop.
8. **Interaction parity** grows with each part, not at the end.

Each step keeps the full test suite, adds its own evaluations, and changes no contract without
an ADR.

## Questions for Philip

- Which second domain after software should the fabric support first: games, as the example, or
  a domain closer to early users?
- Should runtime measurements get a new basis, or `observed` with declared runtime coverage? This
  touches R4.
- Who may approve a policy that commits on a person's behalf, and for which kinds of change?
- How public should domain-knowledge packs be: shipped with Kalyth, per organisation, or both?
