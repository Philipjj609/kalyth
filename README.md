# Kalyth

Kalyth keeps a persistent, evidence-backed engineering model of a project. The model holds typed
components, data, interfaces, constraints, decisions and alternatives. Each one is linked to the
source evidence it rests on and to the revision in which it became true. People and coding agents
(Claude Code, Codex and other MCP clients) read the same model and propose changes to it. People
decide.

It is built for the Nebius x NVIDIA Global AI Hackathon (October 2026) and meant to outlive it.

## Try the hosted demo

**[kalyth-demo.fly.dev](https://kalyth-demo.fly.dev/)** opens your own copy of Kalyth's model of
the [FastAPI full-stack template](https://github.com/fastapi/full-stack-fastapi-template), analysed
at tag 0.12.0. Nothing you change there reaches other visitors. You can:

- read the Situation page, the canvas and its lenses, and each element's evidence, pinned to lines
  of the template's source;
- start one of four change requests in the Navigator, and watch its recorded Nemotron 3 Ultra run
  play back, free and at once, or write your own request, which runs live on Nemotron 3 Super; the
  banner says whether a live run can start, and how many you have left today;
- compare the alternatives, accept one, and commit the proposals, which makes new revisions of
  your copy;
- build the context package that a coding agent would get for the accepted decision.

The hosted demo is deliberately narrower than Kalyth run locally
([ADR 0019](docs/adr/0019-hosted-demo.md)):

- **One project, no imports.** It holds the analysed template only and cannot analyse your
  repository. Run Kalyth locally for that ([Analyse a repository](#analyse-a-repository)).
- **No agent access.** MCP and agent tokens are off, so no coding agent can connect to it. The
  hand-off to Claude Code is shown in the demo video and works locally
  ([Connect a coding agent over MCP](#connect-a-coding-agent-over-mcp)).
- **Live runs are capped.** Recorded runs are always free. A live run sends excerpts of the public
  template, and nothing else, to Nemotron 3 Super on Nebius Token Factory. Each copy has at most
  three live runs a day, and all visitors share a small daily allowance (0.07 USD a day for the
  public and 0.03 USD for judges until 1 December, more during judging). A live run reasons
  within a budget, makes one attempt, takes about half a minute and costs about 0.01 USD. Its
  alternatives are briefer than the recorded Ultra runs. It is offered only while the allowance
  left today covers its worst-case cost (0.03 USD), so before December that is about five public
  runs and one judges' run a day. After that, live runs stop until the next UTC day, and the
  recorded runs still work.
- **Copies are temporary.** A copy is deleted after a day without use, or sooner, oldest idle copy
  first, when new visitors need the space. Every copy starts again from the template when the
  server restarts or is redeployed.
- **One small machine.** It sleeps while nobody uses it; the first request after a pause takes
  about a second. Each address has a daily traffic limit.

Judges: the Devpost testing instructions give a code. **I have a judge code**, in the banner, gives
your copy the judges' own allowance.

## Status

Phase 1. What exists and is tested today, in CI on Linux and Windows: 532 unit and integration
tests, and 64 browser tests of the main flows by keyboard (57 of the local workbench, 7 of the
hosted demo, one at phone width), with automated accessibility checks:

- **Semantic kernel.**
  - Typed objects and relations, with a registry of allowed endpoints and impact rules.
  - Claims with an explicit basis: observed, inferred, stated or imported.
  - Evidence pinned to a commit, git blob and line span.
  - Proposals validated against a base revision.
  - Authorised commits that produce immutable revisions and replayable events, and historical
    reads at any revision.
- **Concurrency and integrity.**
  - Stale proposals are refused with the references that changed. Unrelated ones rebase
    automatically, and each rebase re-checks cross-object invariants at the head.
  - One SQLite transaction per commit. The database enforces append-only events, and a replay
    test proves the event log reproduces the stored state.
- **Repository analyser.** Static tree-sitter analysis of Python and TypeScript repositories into
  observed facts with pinned evidence. It finds modules, imports, libraries, FastAPI routes and
  SQLModel tables. Nothing from the analysed repository is executed. When the repository advances,
  re-observed facts are refreshed, and vanished ones are reported stale for review, along with
  anything derived from them.
- **Impact traversal.** From any elements, it finds the elements a change may affect, each with a
  typed path, following each relation type's declared impact rule.
- **Navigator.**
  - Grounded summaries of an element.
  - Alternatives for a change request, with the elements each one changes directly.
  - Exploring a decision again with hybrids of earlier alternatives, and answers to its open
    questions.

  Every citation is checked against the pinned source text, and an item with a fabricated
  citation is rejected. Everything becomes a proposal for a person to review. Model calls go
  through one gateway with consent and a persistent spend cap.
- **Decisions.** The workbench compares a decision's alternatives side by side: what each changes,
  what that reaches, and the open questions. A person accepts one.
- **Context packages and agent handoff.** For an accepted decision or chosen elements, Kalyth
  builds a deterministic, content-addressed package pinned to one revision.
  - Its mandatory part is never truncated: invariants, constraints, accepted decisions,
    acceptance criteria and agent policy.
  - Optional items are ranked by typed distance, with an explicit list of what was left out.
- **Tasks and execution reports.** Coding agents claim tasks with an expiring lease and submit
  execution reports. Kalyth checks each report against git: the commit exists on a branch or tag,
  it carries the task's trailer, it descends from the task's base, and the files changed since the
  base are exactly those reported.
  Tests are the agent's own claim; Kalyth does not run them. A person completes the task.
- **Reconciliation.** After a report passes verification, Kalyth's analyser reads the task's
  commit and compares it with the commit the work started from, element by element: their own
  source, their fields and their relations. It says which of the decision's changes the source now
  shows, what else changed, and which changes came from other commits. Links to proposed elements
  come back as proposals for a person.
- **Workbench UI.** A Situation page that says what needs you; a canvas of the system with lenses
  for claim basis, freshness, impact and decisions; one change thread per decision, from the request
  through alternatives, questions, the decision, hand-off and agent work to reconciliation; a
  side-by-side comparison; and Records, Proposals, Tasks, Agents and packages, and History, with an
  inspector. Light and dark themes, and keyboard shortcuts, listed under the keyboard button in the
  header.
- **Export and import.** A project's whole history, as one file that rebuilds the same state.

### NVIDIA Nemotron on Nebius Token Factory

Every model call goes through Nebius Token Factory's OpenAI-compatible API, through one gateway
([ADR 0010](docs/adr/0010-provider-gateway-grounding-and-navigator.md)):

- **Change requests** use Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`). The hosted
  demo's four presets replay Ultra answers recorded on Nebius against the same project.
- **Element summaries, the evaluation harness, and the hosted demo's live change requests** use
  Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`). In the hosted demo, Super reasons
  within a budget of 8,000 thinking tokens and 14,000 output tokens, with one attempt per run
  ([ADR 0019](docs/adr/0019-hosted-demo.md)).
- **Every call** asks for structured output against a strict JSON schema. Every citation is
  checked against the pinned source. The call needs the project's consent, and its worst-case
  cost is reserved in a spend ledger before it is made.

### Evidence so far

- **Grounding.** In the keyed spike (0.25 USD cap), after a prompt fix, 37 of 52 citations matched
  their source exactly; the rest differed only in quote style or layout
  ([ADR 0017](docs/adr/0017-bounded-citation-normalisation.md)). In the recorded multi-tenancy run
  the demo replays, 25 of 39 citations are exact and 4 more match after that bounded
  normalisation. The 9 items that failed a check, 7 of them for a quote not found in the cited
  source, were dropped, not repaired.
- **Live runs in the hosted demo.** Three configurations of Nemotron Super were measured on the
  same request (ADR 0019). Unbounded reasoning ran out of output tokens once and cost 0.025 USD.
  Reasoning off was fast but gave inconsistent alternatives. Bounded reasoning, the one deployed,
  answered on its first attempt in 33 seconds for 0.008 USD, with 4 of 4 citations exact.
- **Agent hand-off.** Claude Code, connected over MCP, claimed a task, made the change in its own
  worktree, committed it with the task's trailer and reported. Kalyth verified the report against
  git and reconciled the commit with the decision (the demo video, and
  [docs/releases/v0.1.0-rc.1.md](docs/releases/v0.1.0-rc.1.md)).
- **Not done yet: the independent evaluation.** It is a blinded comparison of the same coding
  agent given a plain prompt, retrieved repository files, or Kalyth's context package and MCP
  tools, on a demanding change to a pinned open-source repository. Its
  ground truth was reviewed by someone other than the implementer and frozen (version 2, on the
  branch `eval/independent-2026-10`). The run is planned for after the hackathon submission, and
  this README will say what it found ([docs/evaluation](docs/evaluation/README.md)).

The hosted demo runs on Fly.io at [kalyth-demo.fly.dev](https://kalyth-demo.fly.dev/) (above). It
is the same server in demo mode (`pnpm demo:serve` runs it locally), deployed by hand from the
release tag, never automatically on a push ([deploy/README.md](deploy/README.md)).

## Limitations

- **Static analysis, two frameworks.** The analyser reads Python and TypeScript with tree-sitter.
  It finds FastAPI routes and SQLModel tables; other frameworks show up as modules, imports and
  libraries only. Each observation states its coverage.
- **Behaviour is not observed.** Nothing from an analysed repository is executed. "Observed" means
  a tool read a fact in pinned source, never that the code runs correctly. An agent's tests are
  its own claim.
- **The model proposes; a person decides.** Navigator output is inferred, carries its citations
  and lands only when a person commits it. A citation that does not match the pinned source is
  rejected, but a grounded proposal can still be a poor design. The Navigator has no typed way to
  propose a new field of an existing entity, so a model may propose one as an entity of its own
  (`User.org_id`); reconciliation then finds no element of that name, though it shows the field
  added to the entity.
- **Local first.** One person per server, on one machine. The hosted demo gives each visitor a
  copy of one analysed project, with no imports and no agent access
  ([Try the hosted demo](#try-the-hosted-demo)).

## Requirements

- Node 24, 25 or 26. Node runs the TypeScript sources directly, so the server needs no build step.
- pnpm 11.
- git on the `PATH`. The analyser reads repositories with git.

## Quick start

```bash
pnpm install
pnpm check          # lint, typecheck, tests
pnpm build          # build the workbench UI
pnpm test:e2e       # optional: browser tests and accessibility checks (needs Chrome)
pnpm dev:seed       # optional: a small sample project
pnpm dev:server     # API and UI on 127.0.0.1:4317
```

Open the `kalyth ui: http://127.0.0.1:4317/#token=...` link that the server prints. The token
changes on every launch. If a tab shows "Session expired", open the new link in it.

Every root script runs from the repository root, so they all share `.kalyth/kalyth.db` there. Set
`KALYTH_DB` to use another file. In bash: `KALYTH_DB=.kalyth/demo.db pnpm dev:server`. In
PowerShell: `$env:KALYTH_DB = ".kalyth/demo.db"; pnpm dev:server`.

`pnpm dev:web` runs the UI with hot reload; see [apps/web/README.md](apps/web/README.md).

## Analyse a repository

Kalyth reads a repository from its git objects at one ref, and never executes it. A remote one is
cloned bare, over HTTPS only, into `.kalyth/repos`:

```bash
pnpm ingest --repo https://github.com/fastapi/full-stack-fastapi-template --ref 0.12.0
pnpm ingest --repo https://github.com/fastapi/full-stack-fastapi-template --ref b1125d8839482cb7bbae603ddc6d0081bf87532e
```

A repository on your machine is read in place, without a copy. Only committed work at the ref is
read, so commit what you want analysed:

```bash
pnpm ingest --repo /absolute/path/to/your/repo --ref main --project "your project"
```

The second run advances the project's source snapshot. Claims whose evidence changed are refreshed
or reported stale (`GET /api/v1/projects/:id/freshness`, MCP `assess_freshness`).

## Demo

[docs/demo/walkthrough.md](docs/demo/walkthrough.md) is the script for the video. It follows a
change request through a person's decision and a coding agent's work over MCP to what the model
learns from that work. It runs on the committed demo template (`deploy/demo/template.json`, the
pinned FastAPI template analysed at tag 0.12.0) and replays a Nemotron run recorded against it, at
no cost. `pnpm demo:setup` builds the same analysis from scratch, with new ids that no recording
matches.

The hand-off in the video is real. Claude Code connects to Kalyth over HTTP MCP with a token for
that one project, and is given the task prompt Kalyth wrote. It claims the task, reads the context
package, makes the change in its own worktree, commits it with the task's trailer and submits an
execution report. Kalyth then checks the report against git and reconciles the commit with the
decision. Nobody types while Claude Code works; the browser steps are scripted, and the video says
so. [docs/demo/recording.md](docs/demo/recording.md) is how it is recorded:
`pnpm demo:recording setup` makes a disposable project, repository and agent worktree for the
hand-off. `pnpm demo:agent` is a scripted stand-in for rehearsals only.

## Navigator and model providers

By default the Navigator uses a local mock provider. It is free and deterministic, and it labels
everything it produces as mock output. Start a run from the Navigator view, or over HTTP with
`POST /api/v1/projects/:id/navigator/runs`. Only a person can start a run.

Real inference uses NVIDIA Nemotron models on Nebius Token Factory. The gateway refuses a call
unless all of these hold:

- the model is in the price catalogue, with the capabilities the run needs;
- the project has consented to sending content to the provider;
- the spend ledger can reserve the call's worst-case cost under the cap.

The ledger lives in `~/.kalyth/ledger.sqlite` (override with `KALYTH_LEDGER`). Without a cap, no
paid call is possible.

```bash
pnpm budget                                   # show cap, spend and remaining budget
pnpm budget set 0.50 --note "approval reference"
```

To use Nebius:

1. Copy `.env.example` to `.env`, which git ignores.
2. Set `KALYTH_PROVIDER=nebius` and your own `KALYTH_NEBIUS_API_KEY`.
3. Set a cap with `pnpm budget set`.
4. Grant consent for the project in the Navigator view.

The key stays in the server process. It is never sent to the browser, stored in run records or
logged.

Once a cap is set, `pnpm spike --project "<name>"` checks the model ids (listing them is not
billed), then makes one summary call and one alternatives call. It records both for replay and
reports validity, citations, tokens and cost. `pnpm spike:replay` checks the recorded answers
again without any call. See [ADR 0010](docs/adr/0010-provider-gateway-grounding-and-navigator.md).

For public repositories and synthetic data only, `KALYTH_PROVIDER=openrouter` with
`KALYTH_OPENROUTER_API_KEY` uses OpenRouter's free Nemotron endpoint, which may log prompts. Nebius
remains the competition provider ([ADR 0016](docs/adr/0016-openrouter-free-provider.md)).

## Connect a coding agent over MCP

Over stdio, the agent's client starts the server itself. Use absolute paths, because the client
chooses the working directory.

Claude Code (project scope):

```bash
claude mcp add kalyth --scope project -e KALYTH_DB=/absolute/path/to/kalyth.db -- node /absolute/path/to/kalyth/apps/server/src/mcp/stdio.ts
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kalyth]
command = "node"
args = ["/absolute/path/to/kalyth/apps/server/src/mcp/stdio.ts"]
env = { KALYTH_DB = "/absolute/path/to/kalyth.db" }
```

A stdio agent can read and propose in every project in that database. To confine an agent to one
project, connect it over HTTP instead. The server must be running. Issue an agent token for the
project in the Handoff view, then run:

```bash
claude mcp add --transport http kalyth http://127.0.0.1:4317/mcp --header "Authorization: Bearer <agent token>"
```

For Codex, use `url = "http://127.0.0.1:4317/mcp"` with
`bearer_token_env_var = "KALYTH_AGENT_TOKEN"`. A token works for one project and expires within 30
days. The UI session token is not accepted on `/mcp`.

Agents get:

- read tools, among them `list_decisions`, `get_context_package`, `analyze_impact` and
  `assess_freshness`;
- `propose_change`;
- task tools: `list_tasks`, `get_task`, `claim_task`, `renew_task_lease`, `release_task` and
  `submit_execution_report`.

There is no commit or accept tool: proposals wait for a person to review and commit them. No tool
spends money either: Navigator runs are started by a person.

## Export and import

```bash
pnpm project:export --project <project id> --out project.json
pnpm project:import project.json
```

The export holds the project's full event history and stored excerpts. Import rebuilds the project
and refuses the file unless the rebuilt state matches the exported state hash
([ADR 0014](docs/adr/0014-project-export-and-import.md)). The UI's Overview view can also download
an export. Use `pnpm project:import`, never `pnpm import`: that is pnpm's own command, and it can delete
`pnpm-lock.yaml`.

## Configuration

All settings are environment variables, and all are optional. The root scripts read `.env` in the
repository root at startup. A variable set in the environment wins over `.env`, so
`KALYTH_PROVIDER=mock pnpm dev:server` uses the free mock provider whatever `.env` says.

| Variable | Default | Meaning |
|---|---|---|
| `KALYTH_DB` | `.kalyth/kalyth.db` | The project database |
| `KALYTH_LEDGER` | `~/.kalyth/ledger.sqlite` | Spend ledger and provider consent |
| `KALYTH_PORT` | `4317` | HTTP port (always on 127.0.0.1) |
| `KALYTH_PROVIDER` | `mock` | `mock`, `nebius`, `openrouter` or `replay` |
| `KALYTH_NEBIUS_API_KEY` | none | Your Nebius Token Factory key |
| `KALYTH_OPENROUTER_API_KEY` | none | Your OpenRouter key (public and synthetic data only) |
| `KALYTH_RECORD_DIR` | none | Record real model responses for replay |
| `KALYTH_REPLAY_DIR` | none | Recordings to replay with `KALYTH_PROVIDER=replay` |
| `KALYTH_GROUNDING_PYTHON_STRINGS` | off (on in the hosted demo) | `1` accepts swapped Python string quotes in citations ([ADR 0017](docs/adr/0017-bounded-citation-normalisation.md)) |

## Concepts in brief

| Concept | Meaning |
|---|---|
| Revision | Every commit creates exactly one new project revision. Any revision can be read later. |
| Proposal | Typed operations against a base revision. Stored as pending or invalid, never applied silently. |
| Claim basis | `observed` (a tool saw it in pinned source, within stated coverage; not runtime verification), `inferred` (a hypothesis with confidence), `stated`, `imported`. |
| Evidence support | Groups of evidence: items in a group are jointly required, groups are alternatives. |
| Decision status | Changed only by a dedicated operation, and only by a person acting directly. |

## Documentation

- [docs/adr](docs/adr/README.md): architecture decisions.
- [docs/contracts/kernel.md](docs/contracts/kernel.md): the kernel contract summary. The executable
  contracts are the zod schemas in [packages/contracts](packages/contracts/src).
- [docs/security/threat-model.md](docs/security/threat-model.md): the threat model for local mode.
  [SECURITY.md](SECURITY.md) explains how to report a vulnerability.
- [docs/evaluation](docs/evaluation/README.md): the evaluation and its ground truth.
- [docs/demo/walkthrough.md](docs/demo/walkthrough.md): the demo script, and
  [docs/demo/recording.md](docs/demo/recording.md): how the video was made.
- [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md): the competition release, what was checked
  and what is known not to work.
- [docs/hackathon/submission.md](docs/hackathon/submission.md): the hackathon submission text.
- [docs/feedback/nebius-nvidia.md](docs/feedback/nebius-nvidia.md): what we hit with Nebius Token
  Factory and the Nemotron models.

## Repository layout

```
packages/contracts   shared zod schemas and types (kernel, API, MCP)
packages/core        semantic kernel, SQLite store, application services, export and import
packages/analyzer    static repository analysis and ingest (tree-sitter, git objects)
packages/gateway     provider gateway: model catalogue, spend ledger, consent, providers
packages/navigator   grounded summaries and change alternatives, as proposals
packages/context     deterministic context packages for coding agents
packages/tasks       task leases and execution reports verified against git
packages/eval        evaluation harness: lexical retrieval versus context packages
apps/server          HTTP API, MCP server and command-line tools over the services
apps/web             workbench UI (React, React Flow)
docs/adr             architecture decision records
```

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) describes the workflow and
the checks every change passes (`pnpm check`, and `pnpm build && pnpm test:e2e` for the UI), and
[AGENTS.md](AGENTS.md) the conventions for coding agents working in this repository. Report
vulnerabilities as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## License

Apache-2.0. See [LICENSE](LICENSE).
