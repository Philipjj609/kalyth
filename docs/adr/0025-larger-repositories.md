# 0025. Larger repositories

Date: 2026-10-20. Status: Accepted (technical lead; routine, within ADRs 0009, 0021 and 0020).

## Context

Kalyth had been run on the FastAPI template (156 modules) and on itself (275). To check the canvas
on larger, unfamiliar code, three public repositories were cloned (depth 1, read only, with
Philip's go-ahead) and analysed: fastapi/fastapi (1,179 Python files, 2,788 elements), excalidraw
(683 TypeScript files, 759 elements, 4,686 relations) and saleor (4,380 Python files, 4,444
elements, 26,888 relations). Every one of them failed somewhere before the canvas:

- **The ingest could not be committed.** A proposal holds at most 5,000 operations; these needed
  6,000 to 60,000.
- **Different things became one element.** Entities were keyed by class name and endpoints by
  method and path. fastapi's tutorial code declares `Hero` and `GET /items/` hundreds of times,
  so one element ended up contained by many modules, which the kernel rightly refused. Any
  monorepo where two services both declare `User` does the same.
- **Test code became API.** saleor's tests use `@mock.patch("…")`, which the analyzer read as
  1,177 `PATCH` endpoints.
- **Route prefixes multiplied.** fastapi's tests include routers into routers many times over;
  resolving every path overflowed the stack.
- **The model was read 1,000 records at a time.** The web client and the ingest stopped at the
  API's page, so the canvas was partial and a re-ingest would plan against a partial model.

On the canvas, the two Python repositories opened as one closed box (a single container holding
everything), and once opened, saleor's 38 packages had 314 import links between them, laid out as
a sheet five screens wide.

## Decision

Analyzer (0.3.0) and ingest:

- **Ingest in parts.** The plan lists evidence, then elements, then relations, then the source
  snapshot, so references only point backwards. The ingest commits it in parts of at most 5,000
  operations and swaps local refs from earlier parts for the ids they created. The snapshot comes
  last, so the model says it reflects the new commit only once every observation has landed. An
  interrupted ingest leaves valid observations, and running it again completes them.
- **Scoped keys for repeated names.** An entity or endpoint whose name (or method and path) is
  declared more than once carries `scope` (its module, or its handler) and a key that includes it.
  A name declared once keeps its plain key, so existing models are unchanged. `scope` is optional
  and additive on `software.DataEntity` and `software.Endpoint`, which stay at version 1.
- **Routes only from routers.** A route decorator counts only when its receiver resolves to a
  FastAPI app or `APIRouter`, defined in the file or imported. Others are counted as
  `decoratorsNotOnARouter`.
- **Bounded prefixes.** Each router's prefixes are computed once, without repeats, and at most 16
  are kept (`routerMountsCapped` when more).
- **Paged reads.** Object and relation queries take an `after` cursor; the ingest and the web
  client read every page (the client up to 50,000 records per list, and says if it stops short).

Canvas:

- **A box that is most of its level opens.** A container or package that holds at least 80% of
  its level's members opens on the first view, the largest first, while the view stays within 48
  items. A level that already shows its parts (the template's three containers, excalidraw's
  eleven) stays as it was. Hidden folders (`.semgrep/`, `.github/`) never open by themselves.
- **Import links between packages are drawn, thinned.** Imports between two modules remain detail.
  Imports between packages or frames are drawn, but each frame keeps only its strongest one. A
  frame that most of its sibling frames import (at least 5, and at least half) is a hub: its links
  are not drawn and it says "imported by N" instead. Selecting a frame draws all its links exactly.

## Results

| Repository | Ingest | First view, before | First view, after |
| --- | --- | --- | --- |
| fastapi | refused, then 3 s | 3 nodes: one closed box | its four packages; tests, docs and scripts point into `fastapi/` |
| excalidraw | 3 s | 11 containers and their links | unchanged |
| saleor | 16 s | 3 nodes: one closed box | 38 domain packages, 25 links, hubs labelled |

Projection and layout take under 100 ms even with everything open (4,775 nodes for saleor).
Loading saleor's 31,000 records takes 0.6 s.

## Not done

- The TypeScript analyzer treats workspace imports (`@kalyth/core`) as external libraries when no
  `paths` mapping names them, so Kalyth's own containers show few links between them. Fixing it
  changes analyzer output, so it waits for the D5 re-recording batch.
- Django models and GraphQL resolvers are not recognised: saleor's model shows modules, imports and
  libraries, but no data entities or endpoints.
- Task, report and decision reads in the task coordinator still read up to 1,000 records each;
  those counts stay small.

## Review follow-ups (KAL-20261021-039)

- **Identity through scoping.** A plain key that becomes scoped when a second declaration appears
  (and plain again when it goes) would have left the old element stale beside a new one. The ingest
  now matches a fact whose key matches no element by its declaration: an entity's name and file, an
  endpoint's method, path and handler, a container's manifest directory. It re-keys that element,
  so it keeps its id and what refers to it. A fixture walks User and GET /users/ from unique to
  duplicated across two services and back. The same rule fixed a defect the fixture exposed: a
  repository whose container is its root folder (named after the repository) could not be
  re-ingested, because its key could not be read back from its name.
- **Partial ingest is explicit.** The first part of an ingest in parts marks the current snapshot
  `pending` (the newer commit and the number of parts); the last part clears it. Meanwhile
  freshness still measures against the old snapshot, the workbench shows a banner, and a context
  package compiled then says so. A test interrupts the ingest after every part. The old snapshot
  stands, nothing is duplicated, another project is untouched, and running the ingest again gives
  exactly the uninterrupted result. A first ingest has no snapshot to mark: its records stay
  unchecked until the last part creates one. Staging the parts out of sight until the end would be
  the longer-term design.
- **Fields.** A field declared on a base class names it (`inheritedFrom`); fields beyond 200 are
  counted (`fieldsOmitted`). They are annotations in source, not the runtime schema.
- **Coverage, not completeness.** Decorators that are not on a FastAPI app or router, router
  prefix caps and omitted fields are listed in the analysis limitations, and the coverage statement
  says that routes come only from FastAPI apps and routers. A fixture covers an imported router
  alias, routers included into routers, and a method named like an HTTP verb on something else.
- **Thinning is drawing only.** Every relation stays in the model; the canvas says how many import
  links it does not draw, and selecting an element, or turning on every import, draws them.
