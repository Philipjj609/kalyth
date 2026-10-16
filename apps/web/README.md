# @kalyth/web

The Kalyth workbench: one app shell with Overview, Graph, Records, Proposals and History views and
an Inspector. React 19, Vite 8, Tailwind CSS 4, TanStack Query, React Flow 12 with dagre layout.
It talks only to the local HTTP API (`/api/v1`) and imports its types from `@kalyth/contracts`.

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
prints this dev URL when the UI is not built). Vite proxies `/api` to the API with `changeOrigin`
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
src/views      Overview, Records, Proposals, History, project list
src/app        shell, URL state (?project=&view=&rev=&sel=), session, theme
```

The visual language for epistemic status is defined once in `src/model/semantics.ts`: every
basis, freshness status, proposal status and origin has a text label, a description and a tone.
Basis is also encoded as the edge dash pattern and node border (solid observed, dashed inferred,
dotted stated, double imported); colour never carries meaning alone.

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
