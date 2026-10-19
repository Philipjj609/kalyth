# Kalyth

Kalyth keeps a persistent, evidence-backed engineering model of a project. The model holds typed
components, data, interfaces, constraints, decisions and alternatives. Each one is linked to the
source evidence it rests on and to the revision in which it became true. People and coding agents
(Claude Code, Codex and other MCP clients) read the same model and propose changes to it. People
decide.

It is built for the Nebius x NVIDIA Global AI Hackathon (October 2026) and meant to outlive it.

## Status

Phase 1. What exists and is tested today, in CI on Linux and Windows: 352 unit and integration
tests, and 36 browser tests of the main flows by keyboard, with automated accessibility checks:

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
  execution reports. Kalyth checks each report against git: the commit exists, it carries the
  task's trailer, it changes exactly the reported files, and it descends from the task's base.
  Tests are the agent's own claim; Kalyth does not run them. A person completes the task.
- **Workbench UI.** Overview, Graph, Records, Proposals, History, Navigator, Handoff, Tasks (board
  or dependency graph) and Decisions views, with an inspector. Claim basis and freshness show on
  every node and edge. Light and dark themes, and keyboard shortcuts, listed under the keyboard
  button in the header.
- **Export and import.** A project's whole history, as one file that rebuilds the same state.

Real NVIDIA Nemotron inference through Nebius Token Factory has been tested in a keyed spike under
a 0.25 USD cap. After a prompt fix, 37 of 52 citations matched their source exactly; the rest
differed only in quote style or layout. See
[docs/feedback/nebius-nvidia.md](docs/feedback/nebius-nvidia.md) and
[ADR 0017](docs/adr/0017-bounded-citation-normalisation.md).

Not done yet:

- the evaluation run against frozen ground truth ([docs/evaluation](docs/evaluation/README.md));
- the hosted demo.

This README will say when each one works.

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

Kalyth clones the repository bare, over HTTPS, into `.kalyth/repos`. It never executes it.

```bash
pnpm ingest --repo https://github.com/fastapi/full-stack-fastapi-template --ref 0.12.0
pnpm ingest --repo https://github.com/fastapi/full-stack-fastapi-template --ref b1125d8839482cb7bbae603ddc6d0081bf87532e
```

The second run advances the project's source snapshot. Claims whose evidence changed are refreshed
or reported stale (`GET /api/v1/projects/:id/freshness`, MCP `assess_freshness`).

## Demo

`pnpm demo:setup` builds `.kalyth/demo.db` from scratch: the pinned FastAPI template, analysed at
tag 0.12.0. [docs/demo/walkthrough.md](docs/demo/walkthrough.md) is the script for the video. It
follows a change request through a person's decision, a coding agent's work over MCP, and the
claims that go stale when the repository advances. `pnpm demo:agent` is a scripted stand-in agent
for rehearsals.

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
| `KALYTH_GROUNDING_PYTHON_STRINGS` | off | `1` accepts swapped Python string quotes in citations ([ADR 0017](docs/adr/0017-bounded-citation-normalisation.md)) |

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
- [docs/demo/walkthrough.md](docs/demo/walkthrough.md): the demo script.

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

## License

Apache-2.0. See [LICENSE](LICENSE).
