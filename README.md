# Kalyth

Kalyth keeps a persistent, evidence-backed engineering model of a project: typed components, data,
interfaces, constraints, decisions and alternatives, each linked to the source evidence it rests on
and to the revision in which it became true. People and coding agents (Claude Code, Codex and other
MCP clients) read the same model and propose changes to it; people decide.

It is built for the Nebius x NVIDIA Global AI Hackathon (October 2026) and meant to outlive it.

## Status

Phase 1, first vertical slice. What exists and is tested today:

- **Semantic kernel**: typed objects and relations with a registry of allowed endpoints and impact
  rules; claims with an explicit basis (observed, inferred, stated, imported); evidence pinned to a
  commit, git blob and line span; proposals validated against a base revision; authorised commits
  that produce immutable revisions and events; historical reads at any revision.
- **Concurrency**: stale proposals are refused with the references that changed; unrelated
  proposals rebase automatically, and every rebase re-checks cross-object invariants at the head.
- **Integrity**: one SQLite transaction per commit, append-only events enforced by the database,
  and a replay test proving the event log reproduces the stored state.
- **Interfaces**: an HTTP API for the local UI and an MCP server for coding agents, both thin
  adapters over the same services.
- **Repository analyzer**: static tree-sitter analysis of Python and TypeScript repositories
  (modules, imports, libraries, FastAPI routes, SQLModel tables) into observed facts with evidence
  pinned to commit, blob and line span. Nothing from the analysed repository is executed.
- **Staleness**: a source snapshot per repository; when the repository advances, re-observed facts
  are refreshed and vanished ones are reported stale for review, along with anything derived from
  them.

- **Workbench UI (first shell)**: project overview, a hierarchical graph of the model with claim
  basis and freshness shown on every node and edge, a records table, an inspector with pinned
  evidence, proposal review with commit and reject, and revision history. Light and dark themes,
  keyboard navigation.

- **Impact traversal**: from any elements, the elements a change may affect, each with a typed
  path, following the impact rule declared by each relation type (HTTP and MCP `analyze_impact`).
- **Navigator (mock provider so far)**: grounded summaries of an element, and alternatives for a
  change request with the elements each one changes directly. Every citation is checked against the
  pinned source text and fabricated ones are rejected; everything becomes a proposal for a person
  to review. Model calls go through one gateway with a persistent spend cap.

Not working yet: real NVIDIA Nemotron inference through Nebius Token Factory. The adapter is built
and tested without network access, but no call has been made until a budget is approved. Context
packages and task handoff are also still to come. This README will say when each one works. No
hosted demo exists yet.

## Quick start

Requires Node 24 and pnpm 11.

```bash
pnpm install
pnpm check          # lint, typecheck, tests
pnpm build          # build the workbench UI
pnpm dev:server     # API and UI on 127.0.0.1:4317; open the printed http://127.0.0.1:4317/#token=... link
```

`pnpm dev:seed` creates a small sample project; `pnpm dev:web` runs the UI with hot reload (see
[apps/web/README.md](apps/web/README.md)).

Data is stored in `.kalyth/kalyth.db` in the working directory; set `KALYTH_DB` to use another file.

Analyse a repository (cloned bare over HTTPS into `.kalyth/repos`; never executed):

```bash
pnpm ingest --repo https://github.com/fastapi/full-stack-fastapi-template --ref 0.12.0
pnpm ingest --repo https://github.com/fastapi/full-stack-fastapi-template --ref b1125d8839482cb7bbae603ddc6d0081bf87532e
```

The second run advances the project's source snapshot; claims whose evidence changed are refreshed
or reported stale (`GET /api/v1/projects/:id/freshness`, MCP `assess_freshness`).

### Navigator and model providers

The Navigator uses a local mock provider by default: it is free, deterministic and labels everything
it produces as mock output. Start a run from the UI, or over HTTP with
`POST /api/v1/projects/:id/navigator/runs`.

Real inference uses NVIDIA Nemotron models on Nebius Token Factory. Every call passes through a
gateway that refuses it unless all three of these hold:

- the model is in the price catalogue;
- the project has consented to sending content to the provider;
- a spend ledger can reserve the call's worst-case cost under the cap.

The ledger lives in `~/.kalyth/ledger.sqlite` (override with `KALYTH_LEDGER`). Without a cap, no
paid call is possible.

```bash
pnpm budget                                   # show cap, spend and remaining budget
pnpm budget set 0.50 --note "approval reference"
```

To use Nebius, copy `.env.example` to `.env` (git-ignored), set `KALYTH_PROVIDER=nebius` and your
own `KALYTH_NEBIUS_API_KEY`, then grant consent for the project in the UI. The key stays in the
server process; it is never sent to the browser, stored in run records or logged. See
[ADR 0010](docs/adr/0010-provider-gateway-grounding-and-navigator.md).

### Connect a coding agent over MCP

The MCP server runs over stdio. Node runs the TypeScript sources directly; no build step is needed.

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

Agents get read tools (including `analyze_impact` and `assess_freshness`) and `propose_change`.
There is no commit or accept tool: proposals wait for a person to review and commit them. Nor is
there a tool that spends money: Navigator runs are started by a person in the UI.

## Concepts in brief

| Concept | Meaning |
|---|---|
| Revision | Every commit creates exactly one new project revision. Any revision can be read later. |
| Proposal | Typed operations against a base revision. Stored as pending or invalid, never applied silently. |
| Claim basis | `observed` (a tool saw it in pinned source, within stated coverage; not runtime verification), `inferred` (a hypothesis with confidence), `stated`, `imported`. |
| Evidence support | Groups of evidence: items in a group are jointly required, groups are alternatives. |
| Decision status | Changed only by a dedicated operation, and only by a person acting directly. |

The architecture decisions are in [docs/adr](docs/adr/README.md) and the kernel contract summary in
[docs/contracts/kernel.md](docs/contracts/kernel.md). The executable contracts are the zod schemas in
[packages/contracts](packages/contracts/src).

## Repository layout

```
packages/contracts   shared zod schemas and types (kernel, API, MCP)
packages/core        semantic kernel, SQLite store, application services
packages/analyzer    static repository analysis and ingest (tree-sitter, git objects)
packages/gateway     provider gateway: model catalogue, spend ledger, consent, providers
packages/navigator   grounded summaries and change alternatives, as proposals
apps/server          HTTP API, MCP server and ingest CLI over the services
apps/web             workbench UI (React, React Flow)
docs/adr             architecture decision records
```

## License

Apache-2.0. See [LICENSE](LICENSE).
