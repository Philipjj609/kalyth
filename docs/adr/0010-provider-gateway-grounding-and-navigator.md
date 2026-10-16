# 0010. Provider gateway, budget ledger, grounding and the Navigator

Date: 2026-10-16. Status: accepted. Gate G3; builds on ADRs 0005, 0006 and 0009.

## Context

G3 makes an NVIDIA Nemotron model on Nebius Token Factory do core work: grounded summaries of
analysed components, and alternatives with typed impact paths for a change request. Three things
must hold whatever the model writes. It cannot raise its own authority. It cannot invent evidence.
It cannot spend beyond a cap that Philip sets: chargeable calls are not authorised yet (KAL-006),
and the budget request is KAL-20261016-010. Nebius documents prepaid billing but no hard spend cap,
so Kalyth's own cap is the real control.

## Decision

**Gateway.** Every model call goes through `packages/gateway`. A call names a model, a purpose, a
zod output schema and a maximum output length. The gateway refuses it unless:

- the model is in the price catalogue;
- an external provider has the project's consent;
- the budget ledger can reserve its worst-case cost.

The output is then parsed and validated against the schema. If it fails, the model gets at most two
corrective retries, each reserved and charged separately. There are three providers:

- **mock** is the default. It runs locally, is free, gives deterministic output and labels every
  record it produces as mock output.
- **replay** answers only requests it has a recording for, keyed by the request hash. Tests use it,
  so runs are repeatable.
- **Nebius** sends OpenAI-compatible chat completions to `https://api.tokenfactory.nebius.com/v1`,
  with `response_format` set to a strict `json_schema`. It is built only when `KALYTH_PROVIDER=nebius`
  and `KALYTH_NEBIUS_API_KEY` are both set.

The key stays in the server process. It never appears in API responses, run records, logs or the
web bundle, and provider error text is scrubbed of it.

**Budget ledger.** Spend is recorded in its own SQLite file, separate from project databases
(default `~/.kalyth/ledger.sqlite`, override with `KALYTH_LEDGER`). Deleting or re-seeding a project
database therefore never resets spend, and all processes on the machine share one cap.

- **The cap.** It is set with `pnpm budget set <usd> --note <approval>`. Each change is kept with its
  time and note. Without a cap the limit is zero, so no paid call is possible.
- **Reserving.** Before each call, the ledger reserves an upper bound on its cost, inside an
  immediate transaction:

  ```
  (prompt bytes + per-message overhead) × input price + maximum output tokens × output price
  ```

  It refuses the call with `budget_exceeded` if the reservation exceeds what remains. Byte-level
  tokenisers produce at most one token per byte, so the reservation bounds the real cost before usage
  is known.
- **Settling.** After the call, the ledger settles to the usage the provider reports. Without
  reported usage, the reservation stands. A transport failure after the request was sent is recorded
  as an unknown outcome and stays charged.
- **Units and thresholds.** Amounts are integer micro-dollars. Advisory thresholds at 50 and 80
  percent are reported with the status.

**Consent.** For external providers, each project needs consent from a person acting directly
(origin `human`). Consent is stored in the ledger database and can be revoked.

**Grounding validator.** The model sees evidence as numbered excerpts (`E1` to `En`) and elements as
numbered entries (`N1` to `Nn`). Excerpts are delimited and declared to be data, not instructions. A
citation is `{ref, quote}`, and it is valid only when all of these hold:

- the reference was in the model's context;
- the quote, with whitespace normalised and at least 12 non-space characters, occurs in the excerpt;
- the excerpt still hashes to the evidence's `spanSha256`, so it is the pinned source text.

An item with any invalid citation is rejected and counted, never repaired. A statement about existing
code also needs at least one valid citation. Each run reports its citation and rejection counts.

**Impact traversal** is deterministic and read-only. It is the `analyzeImpact` service, exposed over
HTTP and as the MCP tool `analyze_impact`. From seed elements it walks active relations in the
direction their type's `impact` declares (ADR 0005). It adds one rule of its own: changing an
endpoint or data entity changes the module that defines it, so `contains` is followed upwards from
those two types to their module. Every reached element carries its typed path. Depth and node count
are bounded.

**Navigator.** `packages/navigator` has two operations.

- *Summarise an element.* It produces cited statements, stored as `core.Assertion` records linked by
  `concerns`.
- *Alternatives for a change request.* One model call returns 2 to 4 alternatives, up to 3 questions,
  and, for each alternative, the elements it changes directly, with citations. Kalyth computes the
  propagated impact from those direct changes by traversal. The model never invents dependencies.
  The result is a `core.Decision` with `core.Alternative` records (`alternativeOf`), questions
  (`concerns`), and the new relation type `impacts`, from an alternative to a software element, with
  the change described in its properties.

Every record is `inferred`, with model provenance, confidence and its citations as support.
Everything a run produces becomes one proposal from the Navigator principal. That principal is kind
`model`, origin `model`, and holds only `project.read` and `proposal.create`. It cannot commit, and
decisions still change status only through a person (ADR 0006).

Runs are started over HTTP by the first-party UI. In version 1, MCP has no tool that spends money.
Run records (input, model calls, cost, grounding report, proposal) live in the project database as
operational data, outside the replayable event log.

## Alternatives

- **A cap in an environment variable.** Rejected: it is easy to change silently and keeps no
  history.
- **A real tokenizer for the reservation.** Rejected: none is available for Nemotron in JavaScript,
  and the byte bound is simpler and safe.
- **Storing propagated impact as relations.** Rejected: that is hundreds of inferred relations per
  run to review. Recomputing it keeps it current at whatever revision is viewed. Direct impacts are
  stored, because they carry the model's cited reasoning and go stale with the code.
- **A Navigator tool over MCP.** Deferred until hosted, per-session caps exist (G7).

## Consequences

- The reservation over-estimates English and code by about four times, so the cap stops calls a
  little early. That is acceptable for a hard limit.
- Until the keyed spike, these are unverified: exact model id casing, `json_schema` support on
  Nemotron 3 Super and Ultra, the reasoning switch, and the usage fields. The model catalogue records
  each price's source and date.
- `impacts` is a new relation type in the core pack. Existing records are unaffected.
