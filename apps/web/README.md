# @kalyth/web

The Kalyth workbench: one app shell with Overview, Graph, Records, Proposals, History, Navigator
and Handoff views and an Inspector. React 19, Vite 8, Tailwind CSS 4, TanStack Query, React Flow 12 with dagre layout.
It talks only to the local HTTP API (`/api/v1`) and imports its types from `@kalyth/contracts`.

Screenshots against the sample seed (1440x900): [overview](docs/screenshots/01-overview-light.png),
[graph with an expanded container](docs/screenshots/02-graph-dark.png),
[default collapsed graph](docs/screenshots/06-graph-collapsed-light.png),
[evidence groups and a redacted excerpt](docs/screenshots/03-inspector-evidence-dark.png),
[proposals](docs/screenshots/04-proposals-light.png), [history](docs/screenshots/05-history-light.png).

## Run it against the server (production build)

```bash
pnpm build            # builds apps/web/dist
pnpm dev:seed         # optional: a hand-written sample project (see below)
pnpm dev:server       # serves the API and the UI on http://127.0.0.1:4317
```

The server prints `kalyth ui:  http://127.0.0.1:4317/#token=<token>`. Open that link. The UI moves
the token from the URL fragment into `sessionStorage` (this tab only) and removes it from the
address bar; fragments are never sent to the server or in a Referer header. The token changes on
every server launch; an old tab then shows a "Session expired" screen. Opening the new link in the
same tab, or pasting the token there, continues.

`pnpm dev:seed` and `pnpm dev:server` both run in `apps/server`, so they share
`apps/server/.kalyth/kalyth.db`. Set `KALYTH_DB` to use another file.

## Develop with hot reload

```bash
pnpm dev:server       # terminal 1: API on 127.0.0.1:4317
pnpm dev:web          # terminal 2: Vite on http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173/#token=<token>` with the token the server printed (the server also
prints this dev URL when the UI is not built). Vite proxies `/api`, and `/mcp` for agents, to the
server with `changeOrigin`
(so the Host check passes) and rewrites the `Origin` header only for requests from the dev server's
own origin; any other origin passes through and is refused by the API. Use `KALYTH_API_URL` and
`KALYTH_WEB_PORT` to change the target or the port.

## Security model in the browser

- Served with a strict Content-Security-Policy: same-origin scripts, styles, fonts and
  `connect-src 'self'`; no inline scripts or styles (React sets styles through the CSSOM, which CSP
  allows). See `apps/server/src/http/static.ts`.
- The token is sent only as `Authorization: Bearer` to same-origin `/api/` URLs. The UI shell and
  assets need no token; Host and Origin checks still apply to every request.

## Structure

```
src/api        HTTP client (error envelope, token), TanStack Query hooks, freshness parsing
src/model      pure display logic: labels, formatting, status semantics, records table, operations
src/graph      projection (records -> nodes/edges, grouping, collapse) and dagre layout, both pure
               and unit-tested; React Flow nodes, edges and the Graph view (lazy-loaded)
src/inspector  claim, evidence groups, provenance, relations, attributes
src/navigator  Navigator view (ADR 0010): provider, budget and consent strip, change request form,
               runs, run report (model calls, grounding), alternatives and impact; header chip and
               the Inspector's "Summarise with Navigator"
src/handoff    Handoff view (ADR 0011): choose a decision or elements, the context package, agent
               tokens and setup, the prompt and the round trip
src/views      Overview, Records, Proposals, History, project list
src/app        shell, URL state (?project=&view=&rev=&sel=&run=&proposal=&package=), session, theme
```

## Navigator

The Navigator view (key `6`, `?view=navigator&run=nav_…`) talks to `/api/v1/projects/:id/navigator`,
`/navigator/runs`, `/api/v1/navigator/runs/:runId` and `/impact`. A 404 on the status route means the
server has no Navigator, and the view, header chip and Inspector action stay hidden or explain so.
Runs are polled about once a second while running. Everything a run produces is one proposal, read
with `GET /api/v1/proposals/:id` and parsed in `src/model/navigator.ts`; output from the `mock`
provider carries a "Mock output" badge wherever it appears. Propagated impact is computed by the
server's traversal on demand ("Show impact"), never stored. Amounts are integer micro-dollars,
shown as USD with four decimals.

The Situation panel at the top reads `GET /api/v1/projects/:id/situation` (open decisions with
their alternatives, open questions, pending proposals, stale claim counts); its type lives in
`src/api/situation.ts` until `Situation` is published in `@kalyth/contracts`. Once a run's proposal
is committed, a person can accept one alternative: the UI proposes `setDecisionStatus` operations
against the head (the decision and the chosen alternative accepted, the others rejected) and
commits them (`src/api/decide.ts`). Stale or conflicting commits leave that proposal pending and
show the error as the Proposals view does.

The visual language for epistemic status is defined once in `src/model/semantics.ts`: every
basis, freshness status, proposal status and origin has a text label, a description and a tone.
Basis is also encoded as the edge dash pattern and node border (solid observed, dashed inferred,
dotted stated, double imported); colour never carries meaning alone.

## Handoff

The Handoff view (key `7`, `?view=handoff&package=ctx_…`) hands an accepted decision, or chosen
elements, to a coding agent. It compiles a context package with `POST /api/v1/projects/:id/context`
(always at the head), reads one with `GET /api/v1/context/:packageId`, lists accepted decisions with
`GET /api/v1/projects/:id/decisions?status=accepted`, and issues, lists and revokes agent tokens with
`/api/v1/projects/:id/agent-tokens` and `/api/v1/agent-tokens/:id/revoke`. A 404 on the decisions or
token routes means the server has neither, and the view says so. Display and request logic is pure
and lives in `src/model/handoff.ts`.

Agents connect to `<page origin>/mcp` with an agent token; the view gives the Claude Code command,
the Codex `config.toml` entry and the prompt that names the package id and the revision to propose
against. The token is shown once, right after it is issued. It is held only in the panel's component
state: never in the URL, `localStorage`, `sessionStorage` or the TanStack Query caches (issuing is
not a react-query mutation for this reason), and it is dropped when the person leaves the view.
"What came back" lists pending proposals whose base revision is the package revision, with a link
to review each in Proposals.

## Freshness

`GET /api/v1/projects/:id/freshness?revision=N` is read defensively (`src/api/freshness.ts`). A 404
means "not available" and the UI shows no freshness at all rather than guessing. The types there
mirror the announced response and should be replaced by `@kalyth/contracts` imports once the
schema is published.

## Tests

`pnpm test` at the root runs the `web` Vitest project (`apps/web/vitest.config.ts`) alongside the
node project. Web tests are pure and run in node; a test that needs a DOM can opt in per file with
a `@vitest-environment` comment.

## The sample seed

`apps/server/src/dev/sample.ts` creates "Sample: fullstack app" through the services: a system,
three containers (one to-be), 23 modules (one retired), endpoints, data entities, libraries, a
decision with two alternatives, a requirement and a constraint, five revisions (one rebased), and
proposals in every review state (pending, committed, rejected, invalid, stale). Its source spans
and excerpts are invented and say so in their observation coverage.
