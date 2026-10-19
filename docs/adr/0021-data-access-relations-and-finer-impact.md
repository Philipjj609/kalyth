# 0021. Data access relations and finer impact

Date: 2026-10-19. Status: accepted (technical lead); the `writes` impact rule awaits ChatGPT's
review. Builds on ADRs 0005, 0008, 0009 and
0010; lifts the "reads and writes are not inferred yet" limit of ADR 0009.

## Context

A product audit on 2026-10-19 used the FastAPI full-stack template at tag 0.12.0. Impact from the
`User` data entity and from the `Item` data entity was the same 49 elements. Both sets included
unrelated endpoints such as `GET /api/v1/utils/health-check/` and `POST /api/v1/utils/test-email/`.

The analyzer emitted no `reads` or `writes` relations and nothing linked entities to each other.
`traceImpact` therefore reached endpoints only through its definition rule:

1. An entity reaches the module that defines it (`backend/app/models.py`).
2. That module reaches every module that imports it, through `dependsOn`.
3. Each of those modules reaches every endpoint it exposes.

Both entities live in `models.py`, so their impact could not differ. This weakened the comparison
of alternatives and inflated context packages. In one package, 54,000 of 60,000 characters were
impacted elements, mostly endpoints.

## Decision

**Reads and writes (Python).** For each FastAPI route, the analyzer reads the handler's body. It
also reads repository functions the handler calls, one or two levels deep (route →
`crud.update_user` → helper). It records these SQLModel and SQLAlchemy patterns:

- **Reads:**
  - `select(Entity)` and `select(Entity.column)`;
  - `.select_from(Entity)`, `.join(Entity)` and `.query(Entity)`;
  - `session.get(Entity, ...)`.
- **Writes:**
  - an entity instance passed to `session.add`, `add_all`, `merge` or `delete`, whether written
    inline (`Entity(...)`, `Entity.model_validate(...)`) or held in a typed variable;
  - `x.sqlmodel_update(...)` on a typed variable;
  - the statements `delete(Entity)`, `update(Entity)` and `insert(Entity)`.

A receiver counts as a session only when its name looks like one (`session`, `db`,
`db_session`, `self.session`) or its parameter is annotated with a `Session` type.

A variable gets an entity type from one of three sources:

- a parameter annotation, including through module-level aliases such as
  `CurrentUser = Annotated[User, Depends(get_current_user)]`;
- `session.get(Entity, ...)`;
- the return annotation of a repository function it was assigned from.

Names are resolved only through the repository's own imports and definitions, following
re-exports. When the analyzer cannot resolve a name, type or receiver, it emits no relation.

**Evidence.** Each `reads` and `writes` relation is an observed claim, built like the analyzer's
other facts. Its support group cites these spans, all jointly required (R2):

- the route span (the endpoint's own evidence);
- every function on the call path, as a whole-function span;
- any alias or return annotation that typed a variable.

Different paths to the same access are alternative groups. Freshness is unchanged: a claim is
current while each cited file keeps its blob.

**References.** A new software relation type, `references`, runs from one data entity to another
with impact `targetToSource`: a change to `User` may affect `Item`, which refers to it. The
analyzer emits it in two cases:

- **Foreign keys.** `Field(foreign_key="user.id")` and `ForeignKey(...)`, including inside
  `sa_column=Column(...)`. The target table is resolved through `__tablename__` or SQLModel's
  lower-cased class name, and must be unique.
- **Scalar relationships.** `owner: User | None = Relationship(...)`, when the target resolves.

The analyzer skips three cases:

- A collection relationship (`items: list[Item]`) is the inverse view of a key the other entity
  holds.
- A relationship whose target holds a foreign key to the source is the inverse side.
- A relationship with `link_model` or `secondary` goes through a link table, which carries its own
  keys.

Recording both directions would form a cycle and merge the two entities' impact again.

**Endpoint parameters.** `software.Endpoint` gains an optional attribute, `parameters`, holding
`{name, in, type?}` in signature order. `in` is one of `path`, `query`, `body`, `header`, `cookie`
or `unknown`, and `type` is the annotation as written. FastAPI's rules decide `in`:

1. An explicit `Path`, `Query`, `Body`, `Form`, `File`, `Header` or `Cookie`, as a default or in
   `Annotated` metadata, wins.
2. A name in the route path is `path`.
3. A scalar, an enum or no annotation is `query`.
4. A model class, sequence, mapping or `UploadFile` is `body`.
5. A type the analyzer cannot resolve is `unknown`.

Parameters filled by `Depends` or `Security`, directly or through an alias, are dependencies and
are left out, as are `Request`, `Response`, `WebSocket`, `BackgroundTasks` and similar.

A re-ingest after an agent adds a `q` filter refreshes the endpoint with the new parameter.

The type stays at version 1. The field is optional and additive, so every stored endpoint version
and every export is valid as it stands. Three facts make a version bump unnecessary:

- `typeVersion` is stamped when an object is created and kept on update;
- nothing selects a schema by it;
- import (ADR 0014) replays writes without re-validating attributes.

A bump would also be misleading: endpoints refreshed in place would keep version 1 while carrying
the new field. Version bumps are kept for incompatible changes, which would need migration change
sets (ADR 0003).

**Impact rule.** `traceImpact` applies the definition rule to a data entity only when no active
`reads` or `writes` relation targets the entity at the revision. This is a fallback for code the
analyzer could not resolve. When access relations exist, impact follows them and `references`
instead of the defining module's importers. Endpoints keep the definition rule, and the traversal
stays breadth-first with ties broken by relation id.

**`writes` propagates from the data to its writers only** (technical lead, 19 October). Its impact
rule changes from `both` to `targetToSource`, like `reads`. A change to an entity affects the code
that writes it. With `both`, impact also ran from a writer to every other entity it writes, then to
that entity's readers. So `Item` reached `User` and all of `User`'s readers through
`DELETE /api/v1/users/{user_id}`, which deletes a user's items. The cost: seeding a writer no longer
reaches the data it writes. A change to how an endpoint writes data is a behavioural effect that
static impact does not claim to follow. For ChatGPT's review.

**Ingest and version.** Ingest matches existing `reads`, `writes` and `references` relations by
natural key, so re-ingesting a commit is still idempotent. The analyzer's version becomes 0.2.0.
The coverage note names the heuristics and their limits.

## Alternatives

- **Following FastAPI dependencies.** `Depends(get_current_user)` really reads `User`. But nearly
  every endpoint authenticates, so `User` would reach almost all of them, and through the
  endpoint definition rule every endpoint again. Deferred. If it returns, it needs a distinct
  marker, since an authentication read is cross-cutting.
- **Access relations from modules.** Relations such as `crud.py writes User` would bring tests,
  scripts and `init_db` back into an entity's impact, and also every importer of `crud.py`.
  Deferred.
- **Dropping the definition rule for entities altogether.** Entities whose use the analyzer cannot
  resolve would then have no impact at all. The fallback keeps today's behaviour for them.
- **A real type checker (pyright or mypy).** More precise, but it is a separate toolchain that
  needs the project's environment. ADR 0008 chose tree-sitter only.
- **Endpoint type version 2.** Rejected for the reasons under Endpoint parameters.

## Consequences

- **On the template at 0.12.0** (commit 84c5a9e1):

  | | Before | After |
  |---|---|---|
  | Elements reached from `User` | 49 | 29 (21 endpoints) |
  | Elements reached from `Item` | 49 | 20 (15 endpoints) |
  | Health-check or test-email reached | from both | from neither |

  The ingest adds 15 `reads`, 14 `writes` and 1 `references` relation (`Item` references `User`),
  for 852 relations instead of 822. Every endpoint now carries its parameters. Only `User` reaches
  the login, password-recovery and private endpoints.
- **Remaining over-approximation.** An endpoint still reaches its module, and the module every
  endpoint it exposes. `Item` reaches `DELETE /api/v1/users/{user_id}`, which deletes items, and
  through `users.py` the other user endpoints.
- **Recall.** For an entity with access relations, code that is not a route handler is no longer
  reached through the models module. This includes tests, scripts, `init_db` and the crud module
  itself. Module-level access relations would restore it.
- **Known blind spots:**
  - FastAPI dependencies are not followed: `GET /users/me` has no `reads User`.
  - Loop variables, comprehension results and untyped variables are not typed.
  - Methods and class-based repositories are not followed.
  - Calls more than two levels below the handler are not followed, and are counted in the
    limitations.
  - Session receivers are recognised by name or annotation.
  - Raw SQL is not read.
  - Entities are still only SQLModel `table=True` classes.
- **TypeScript.** No TypeScript support was added. The TypeScript analyzer extracts no endpoints
  or entities, so there is nothing to connect yet.
- **Existing data changes only on re-ingest.** Existing exports, evaluation results and the hosted
  demo (`deploy/demo/template.json` and its recordings) are affected only by re-ingesting. They
  carry no access relations, so the fallback applies and their impact is unchanged. Re-ingesting
  an existing project adds the new relations and refreshes every endpoint, in one ordinary
  proposal.
- **Follow-ups for their owners.** The web app has no description for `references` yet and shows
  its generic text for unknown types. The Navigator's context reader does not load `references`.
