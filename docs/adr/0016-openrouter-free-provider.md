# 0016. OpenRouter's free endpoints as a test provider

Date: 2026-10-18. Status: accepted (Philip, KAL-20261018-020). Amends ADR 0010; reverses option
(a) of KAL-20261017-013 for tests only.

## Context

Real-model work waits for Nebius calls, which cost money. OpenRouter serves NVIDIA Nemotron 3
Super for free, with structured outputs. That makes it useful for free tests on public
repositories and synthetic data. Nebius stays the competition provider.

Checked on 2026-10-18 from OpenRouter's public model metadata:

- `nvidia/nemotron-3-super-120b-a12b:free`:
  - price 0;
  - 262,144-token context;
  - served by NVIDIA;
  - supports `response_format` and `structured_outputs`.
- The free Ultra endpoint supports neither, so it cannot meet Kalyth's strict JSON schema.
- Free-tier limits: 20 requests a minute, and 50 a day until 10 credits have been purchased (1,000
  a day after that).
- The free endpoint publishes no data policy, so prompts must be treated as possibly logged or
  used for training.

## Decision

**One more provider inside the gateway, not a second inference path.**

- `OpenRouterProvider` uses a shared OpenAI-compatible client (`OpenAICompatibleClient`) that:
  - builds the strict JSON-schema request;
  - sends the key only in the Authorization header and scrubs it from error text;
  - uses https only and refuses redirects.
- Everything else is the gateway's, unchanged:
  - catalogue check;
  - per-project consent, recorded separately for `openrouter`;
  - budget reservation;
  - schema validation with at most two corrective retries;
  - grounding validation in the Navigator;
  - recording and replay.

**Configuration.** Set `KALYTH_PROVIDER=openrouter` and `KALYTH_OPENROUTER_API_KEY` in the
git-ignored `.env`. A key under any other name is not read. Every role uses
`nvidia/nemotron-3-super-120b-a12b:free`.

**Guards, on top of the gateway:**

- The catalogue lists only `:free` OpenRouter models, at price 0. The provider also refuses any
  id without `:free` before sending anything.
- Before the first call to a model, the provider reads OpenRouter's public model metadata,
  without the key. It refuses the call unless the model is listed, free, and supports both
  `response_format` and `structured_outputs`.
- Requests set `provider.require_parameters: true` and `allow_fallbacks: false`, so routing never
  goes to an endpoint that ignores the schema.
- Requests ask for usage with cost. A reported charge above zero stops the provider for the rest
  of the process. The call that reported it is recorded as an unknown outcome.
- Philip sets a 0 USD credit limit on the OpenRouter key, so no paid route can succeed even if all
  of the above failed.

**Budget.** Free calls reserve 0, so they run within any cap, including none. They are still
recorded in the ledger, with their token usage.

**Privacy.** The consent text for `openrouter` says free endpoints may log prompts or use them
for training. A person consents only for projects built from public repositories or synthetic
data. The competition video and the evaluation use Nebius output only.

## Alternatives

- **No OpenRouter (KAL-20261017-013).** It kept one provider. But every real-model test then
  costs Nebius credits that the demo needs.
- **Paid OpenRouter models.** Not needed for tests, and they would split spend across two
  accounts.
- **A separate client outside the gateway.** Rejected: consent, budget and validation would have
  to be rebuilt and could drift.

## Consequences

- Free real-model tests become possible on public and synthetic projects, within OpenRouter's
  rate limits.
- Output from the free endpoint is not competition evidence and is labelled with its provider in
  every run record.
- The Nebius adapter moves onto the shared client once the keyed Nebius spike has run, so the
  spike uses code already reviewed.
