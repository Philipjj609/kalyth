# 0019. Hosted demo

Date: 2026-10-19. Status: accepted with amendments (decision D7, KAL-20261019-029). The amendments
below take precedence over the original proposal that follows them.

## Amendments (KAL-20261019-029)

Philip reviewed the proposal (KAL-20261019-028) with ChatGPT and approved:

- the design and its implementation: per-visitor sandbox projects, recorded examples, limited live
  Nemotron inference, daily caps and a reserved allowance for judges;
- Fly.io as the host, with at most 15 USD of planned hosting expense through 15 December;
- up to 10 USD of his Nebius promotional credits for hosted inference.

With these changes:

1. **No paid resource without a go-ahead.** No paid Fly.io resource is created, and no spending
   limit is raised, without Philip's explicit go-ahead. That includes the ledger cap for recording
   more preset runs. Until then, only no-cost work goes ahead.
2. **MCP stays off in the hosted demo.** The `/mcp` endpoint is not served, and agent tokens cannot
   be issued. The Handoff view still compiles context packages, and says how to connect an agent to
   a local Kalyth. MCP will be reconsidered only after specific tests of its authentication,
   sandbox isolation, rate limiting and token security in hosted mode pass.
3. **Judges keep a working demo when the public allowance runs out.** Judges have their own daily
   pool. Recorded runs are free and never blocked by any cap. Everything that needs no inference
   stays fully interactive in every visitor's sandbox: the graph, records, impact, decisions,
   accepting alternatives, committing proposals, history, tasks and export.
4. **The daily allowance splits** as follows; unused allowance does not carry over:
   - before 1 December: 0.07 USD a day for the public and 0.03 USD for judges (0.10 USD);
   - from 1 to 15 December: 0.15 USD for the public and 0.25 USD for judges (0.40 USD).

   The pools' hard totals are 4.49 USD (public) and 4.71 USD (judges). With 0.30 USD for recordings
   and 0.50 USD for staging, the total is 10 USD.
5. **Recorded examples come from a clean template.** The spike's database cannot be the template: a
   rehearsal left an accepted mock decision in it. The template is a clean analysis, committed as an
   export. Its preset runs need one recording session against Nebius (at most 0.30 USD of the
   approved inference budget), which waits for Philip's go-ahead under amendment 1. Until then,
   development and tests use a test provider. Recorded on 19 October for 0.058 USD
   (KAL-20261019-031).
6. **The Python string fallback is on in the hosted demo** (KAL-20261019-032). Without it, the
   recorded backend summary keeps neither statement: all 7 rejected citations only swap Python's
   string quotes. With it, both statements are kept, and the run report lists those 7 citations as
   normalised, apart from exact ones. `fly.toml` sets `KALYTH_GROUNDING_PYTHON_STRINGS=1`; local
   mode keeps the fallback off unless a person sets it.

### Limits added after the security review (24 October 2026)

The review found that one visitor could take the demo from everyone. A single address, within its
request limit, could use up the day's 3 GB of traffic in about two minutes. A sandbox could also
grow without limit on the disk all copies share. Since commit `9edf947`:

- **Traffic is shared out.**
  - Each address may be sent 150 MB a UTC day; an IPv6 /64 counts as one address.
  - The last 500 MB of the day's 3 GB serves judges' sessions only. Up to 100 MB of it lets anyone
    load the UI and enter a judge code.
  - A heavy walkthrough measures 6.9 MB, and a first visit about 2.8 MB.
- **Requests and sandboxes are bounded.**
  - Request bodies are limited to 64 KB; the UI's largest is under 1 KB.
  - A sandbox takes no more changes past 24 MB.
  - All sandboxes together stay within 640 MB. When room is needed, the fullest go first, then the
    least recently used.
- **Sandboxes are on the 1 GB volume.** The volume now holds the template and the sandboxes beside
  the ledgers, so their limit fits a disk of known size. The server deletes leftover sandboxes at
  start, so a restart still starts everyone afresh. About 100 copies fit at once, not 200.
- **A dedicated Fly.io organisation.** By Philip's decision before staging, the demo has its own
  organisation, so it gets its own invoice and its own private network. `deploy/fly-audit.mjs` checks that the
  app is the only one in it.

### Fly.io billing controls

Fly.io has no enforceable spending limit:

- Its support staff wrote in June 2026 that they "aren't able to cap spending limits at this time".
- Prepaid credits "are not a way to control spend": usage beyond them is charged to the card on
  file.
- Its billing documentation mentions no caps or alerts. Billing is monthly per organisation, and
  the dashboard shows the invoice so far.

So the 15 USD cannot be enforced by Fly.io. It is kept by what we run, and by checking:

- **What costs money.** One machine (shared CPU, 1 GB) and one 1 GB volume: about 6.84 USD a
  month, about 11 USD through 15 December. Fly.io never creates machines automatically. The
  configuration fixes one machine in one region, with no autoscaler, no dedicated IPv4 (2 USD a
  month), no database add-ons and no extra volumes.
- **Traffic, the only part that grows with use,** at 0.02 USD per GB. The demo stops serving, except
  its health check, once it has sent 3 GB in a UTC day: about 1,000 first visits of about 2.8 MB
  each. That bounds traffic to at most 0.06 USD a day, about 2.80 USD for the whole period.
- **Who can create resources.** Only Philip's account, from his own machine, in the demo's own
  organisation. No Fly.io token is stored in the repository, GitHub or CI. Deployments are run by
  Philip, or by Claude only with his go-ahead each time. If automation ever needs a token, it is an
  app-scoped deploy token with a short expiry (`deploy/README.md`).
- **Monitoring.** `deploy/fly-audit.mjs` checks the organisation's apps and the app's machines,
  volumes and IP addresses with `flyctl`, and fails if anything beyond the expected set exists.
  Philip runs it, and looks at the organisation's invoice so far in the dashboard, weekly and
  after every deployment.
- **The end.** On 15 December after 12:00 PT, the machine and volume are destroyed and the demo's
  Nebius key is revoked.

Remaining financial risk:

- The planned configuration costs at most about 11 USD in compute and storage, plus at most about
  2.80 USD in traffic.
- Above that, money is spent only if someone with access to Philip's Fly.io account creates or
  enlarges resources, or if traffic that never reaches the application is billed (for example,
  floods stopped by Fly.io's proxy). The first is controlled by keeping access to Philip. The
  second is not under our control, but the audit and the weekly invoice check would show it within
  days.

## Context

The hackathon's official rules ask for:

- a URL to a working demo, hosted application or test build;
- access for judges "free of charge and without any restriction", until the judging period ends on
  15 December 2026 at 12:00 PT (judging starts 1 December). Login credentials in the testing
  instructions are allowed. Judges may also judge from the text, images and video alone.

The project "runs on Nebius" through runtime calls to the Token Factory inference API. The host
itself can be anywhere.

Local mode (the [threat model](../security/threat-model.md)) assumes one trusted person on a
loopback address. A public demo breaks those assumptions:

- anyone can reach it;
- every Navigator run spends real money;
- a shared database could be defaced, or used to show one visitor's text to another.

The spike measured the costs, at catalogue prices that Philip will still check against the
Nebius console:

| Call | Model | Cost | Time |
|---|---|---|---|
| Summary | Nemotron 3 Super | about 0.0025 USD | 3 s |
| Alternatives | Nemotron 3 Ultra | 0.024 to 0.033 USD (reservation up to 0.075) | 14 to 23 s |

Earlier plans (Phase 0, decision D7) proposed:

- a small paid host with a persistent volume;
- a daily inference cap of about 0.40 USD;
- allowlisted repositories only;
- a copy of the demo project for each visitor;
- a disclosed replay mode once the cap is reached.

This record makes that concrete.

## Decision (proposed)

### Shape

One small container serves the built UI and the HTTP API from one Node process, as local mode
does; MCP is off (amendment 2). It runs in a new **hosted demo mode** (`KALYTH_MODE=demo`). The mode changes
only how people get in, which data they see, and how spend is limited. The kernel, services,
gateway and UI stay the same.

### Visitors and their sandboxes

- **No account and no token to paste.** A first visit creates an anonymous session: a random id in
  a `Secure`, `HttpOnly`, `SameSite=Strict` cookie. The server stores only a hash of it.
- **Each session gets its own sandbox.** It is a copy of a read-only template database, holding
  the pinned FastAPI template analysed at tag 0.12.0. The visitor is the human owner of that copy,
  so they can accept alternatives, commit proposals and compile context packages. Nothing they do
  reaches any other visitor.
- **Sandboxes expire** after 24 hours without use, and at most 200 are kept; the oldest is removed
  first. They live on the machine's ephemeral disk, so a restart starts everyone afresh. That is
  acceptable for a demo. (Since the security review they live on the volume, are bounded in size,
  and about 100 fit; see "Limits added after the security review".)
- **No repository import.** The clone and ingest paths are off. The only repositories are the ones
  built into the image.
- **MCP over HTTP is off** (amendment 2). Context packages still compile in the Handoff view.

### Model calls

Every call still goes through the gateway: catalogue, consent, budget, then the network. Three
additions:

1. **Recorded runs first.** The demo offers a few preset change requests, such as "add
   multi-tenancy" and "add role-based access control". Their Nemotron runs are recorded once
   before launch, then replayed without cost. The UI labels them "Recorded Nemotron run, <date>".
   The gateway checks for a recording before any live call, keyed by the exact request.
2. **Live runs within caps.** A free-text request, or a preset with no recording, makes a live
   Nebius call. Caps live in the host's own ledger, on a persistent volume, so a restart does not
   reset them:
   - a total cap for the whole demo period;
   - a daily cap;
   - a per-session limit of 3 live alternatives runs a day;
   - a per-IP rate limit.
3. **A judges' pool.** Part of each day's cap is reserved for sessions that entered a judge code.
   The code goes in Devpost's testing instructions. Without the code, everything still works: it
   only guarantees that anonymous traffic cannot use up the judges' share.

   When a pool is used up, live runs pause until the next UTC day. The Navigator says so and offers
   the recorded runs. It never fails silently.

Provider consent for the demo project is granted once, by Philip, when the host is set up. The UI
says that requests go to Nebius Token Factory and asks visitors not to type personal data.

### Operations

- **Image.** `node:24-slim`, a production install from the lockfile, and the built UI. The template
  database is imported at image build time from a committed export of a clean `pnpm demo:setup`
  build. Prompts include the model's ids, and an import keeps them, so the recorded runs keep
  matching; a fresh analysis would get new ids and match none. It runs as a non-root user, with only
  `/data` writable (ledger and logs).
- **Secrets.** The Nebius key is a platform secret that Philip sets. It should be a dedicated key
  for the demo, so it can be revoked on its own and its spend shows separately in the console. It
  is never in the image, the repository, the browser or the logs.
- **Logging.** Method, route pattern, status and duration only. No bodies, cookies, tokens or IP
  addresses beyond a short-lived rate-limit table in memory.
- **Health.** A health check restarts the machine if it stops answering. `pnpm budget`, run on the
  host, shows spend; Philip also sees it in the Nebius console.
- **End.** After 15 December 12:00 PT the host is stopped, and the demo key is revoked.

## Hosting options and costs

The period runs from 27 October, for a staging deployment, to 15 December: about 1.6 months.

| Option | Cost for the period | Notes |
|---|---|---|
| **A. Fly.io, 1 shared CPU, 1 GB, 1 GB volume** (recommended) | about 11 USD, less if the machine stops when idle | shared-cpu-1x 2.19 USD a month, plus 6 USD per extra GB of RAM, plus 0.15 USD per GB of volume a month, plus 0.02 USD per GB of traffic (official price page, 19 October). Billed per second of running time. There is no hard spend cap, so the configuration fixes one machine. |
| B. Railway Hobby | about 10 to 15 USD | 5 USD a month with 5 USD of usage included, over two or three billing months. Volume rates differ between sources. |
| C. Render Starter plus disk | about 15 to 22 USD | 7 USD a month plus disk, over two or three billing months. |
| D. A VPS (Hetzner or similar) | about 5 to 10 USD | The cheapest compute, but TLS, updates and restarts become our own work. |
| E. Nebius AI Cloud compute | about 70 to 150 USD | CPU VMs from about 0.06 to 0.13 USD an hour, by third-party lists. Fits the sponsor's platform, but is not required by the rules. Whether Token Factory credits cover it is unknown. |
| F. Hugging Face Spaces | 0 to 9 USD | Free CPU hardware sleeps after 48 hours idle, and its disk is not persistent, so the caps could reset. Hugging Face's own documents disagree on whether Docker Spaces need a paid plan. Fallback only. |

The inference budget is separate and comes from the Nebius credits (Philip reports 61 USD):

| Item | Cap |
|---|---|
| Recording the preset runs once (about 6 alternatives runs and summaries) | 0.30 USD |
| Live runs, 30 October to 30 November (32 days): daily cap 0.10 USD (about 3 runs) | 3.20 USD |
| Live runs, 1 to 15 December (15 days): daily cap 0.40 USD (about 13 runs), 0.25 of it reserved for judges | 6.00 USD |
| Staging and the cap test | 0.50 USD |
| **Total hosted inference cap** | **10.00 USD** |

The worst case is the full cap. A typical case is far lower, because most visitors will open the
recorded runs.

## Hosted threat model (additions to local mode)

| Threat | Control | Remaining risk |
|---|---|---|
| Spending through anonymous runs | Recorded runs first; total, daily, per-session and per-IP limits in a persistent ledger; judges' pool; worst-case reservation before every call | A determined visitor can use the anonymous share of a day's cap. Cost stays bounded by the caps. |
| Defacing shared data, or showing one visitor's text to another | One sandbox per session; the template is read-only; nothing a visitor writes is shown to anyone else | None known beyond bugs in the isolation, which tests will cover. |
| Server-side request abuse (making the server fetch URLs) | Repository import and cloning are off; the only outbound calls go to the Nebius API | None known. |
| Cross-site requests and session theft | Cookie `HttpOnly`, `Secure`, `SameSite=Strict`; the existing Host and Origin checks with the public host name; the existing CSP; HSTS | A visitor's own browser extensions are out of scope. |
| Agent tokens leaking | None can be issued: MCP is off (amendment 2) | None while MCP is off. |
| Denial of service | A 64 KB body limit; per-address limits (an IPv6 /64 as one) on requests, sessions, runs and traffic (150 MB a day); a daily limit of 3 GB sent, of which 500 MB is kept for judges; sandboxes of at most 24 MB, 640 MB in all; the platform's own protections | Many addresses (about 17) can use up the public share of a day's traffic; judges keep theirs. A large attack could make the demo unavailable for a while. Judges may also judge from the video. |
| Prompt injection through free-text requests | The output is still only a proposal in the visitor's own sandbox, grounded and checked as in local mode | A visitor can make the model say odd things to themselves. |
| Key exposure | Platform secret, dedicated key, scrubbed from errors, never logged | Platform compromise is out of scope. |

## Alternatives

- **No hosted app, only a test build** (the repository and its instructions). The rules allow it,
  but judges would need to install it and bring their own key. It scores worse on design and is
  less likely to be tried.
- **A static site with recorded data only.** It costs nothing and cannot be abused, but it shows
  no live Nemotron call and cannot commit or accept anything, so it does not show the product
  working.
- **One shared database for all visitors.** Simpler, but one visitor's changes would be seen by
  the next, and accepting a decision would end the demo for everyone.
- **Live inference only with the judge code.** Safer still, but anonymous visitors from the
  Devpost gallery would see only recordings. The proposed split keeps a small anonymous share.

## Effort and timeline

About two days of work after approval:

- hosted mode: sessions, sandboxes and the template;
- the extra caps and the judges' pool in the ledger;
- the recording-first provider;
- the Dockerfile and platform configuration;
- the hosted threat model in the security document;
- browser tests run anonymously against the hosted mode, and a cap test.

With approval by 21 October:

- build from 21 to 25 October;
- staging on 26 October;
- the G7 checks on 27 October: an anonymous browser test, a clean secret scan and a test that the
  caps stop spend;
- submission on 29 October.

## Decisions (D7)

As proposed in KAL-20261019-028 and decided in KAL-20261019-029:

1. **Host:** Fly.io. Philip creates the account and adds the payment method himself, and approves
   activating paid resources separately (amendment 1).
2. **Hosting budget:** up to 15 USD in total through 15 December, not enforceable by Fly.io (see
   the billing controls above).
3. **Hosted inference budget:** up to 10 USD from the Nebius credits, with:
   - the daily split in amendment 4;
   - 3 live runs per session a day;
   - a dedicated Nebius key, created by Philip.
4. **Live runs for anonymous visitors** within their share: as proposed.
5. **MCP over HTTP in the demo:** off until tested (amendment 2).
