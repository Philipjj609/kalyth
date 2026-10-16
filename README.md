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

Not built yet: the repository analyzer, the Navigator and NVIDIA Nemotron inference through Nebius
Token Factory, the workbench UI, context packages and task handoff. They are planned for the next
gates; this README will say when each one works. No hosted demo exists yet.

## Quick start

Requires Node 24 and pnpm 11.

```bash
pnpm install
pnpm check          # lint, typecheck, tests
pnpm dev:server     # HTTP API on http://127.0.0.1:4317/api/v1 (prints a session token)
```

Data is stored in `.kalyth/kalyth.db` in the working directory; set `KALYTH_DB` to use another file.

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

Agents get read tools and `propose_change`. There is no commit or accept tool: proposals wait for a
person to review and commit them.

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
apps/server          HTTP API and MCP server over the services
docs/adr             architecture decision records
```

## License

Apache-2.0. See [LICENSE](LICENSE).
