# Kernel contracts (version 0.1)

The executable contracts are the zod schemas in `packages/contracts/src`. This page explains them;
when the two disagree, the schemas win and this page has a bug.

## Identifiers

`<prefix>_<32 hex digits of a UUIDv7>`. Prefixes: `prj` project, `obj` object, `rel` relation,
`evd` evidence, `cnt` content, `prp` proposal, `chg` change set, `evt` event, `pcp` principal,
`grt` grant. Ids are stable across revisions and never reused. Inside one proposal, `$name` local
refs let operations refer to records the same proposal creates.

## Records

- **Object version**: id, type (`pack.Type`), type version, stance, lifecycle, attributes (strict
  per type), claim, revision, retired reason.
- **Relation version**: the same plus `from`, `to` and properties. Endpoint types, stance, cycles
  and cardinality are checked against the relation registry.
- **Evidence**: an immutable source pointer. Source spans carry repository, commit, path, git blob
  and line span. Excerpts are stored separately and referenced by `{contentId, sha256}`.
- **Claim**: basis, optional confidence (inferred only), observation (observed only), method and
  model provenance, `supports` (groups of jointly required evidence; groups are alternatives),
  `contradictedBy`, `derivedFrom`. See ADR 0005 for the rules.

## Operations

`createObject`, `updateObject` (shallow merge, `null` removes a key), `retireObject`,
`createRelation`, `updateRelation` (properties merge and/or a replacement claim), `retireRelation`,
`recordEvidence`, `setDecisionStatus`. Evidence operations apply
first, the rest in the order given.

Example proposal:

```json
{
  "projectId": "prj_…",
  "baseRevision": 3,
  "rationale": "Analyzer: backend container and its auth module",
  "ops": [
    { "op": "recordEvidence", "ref": "$ev", "evidence": {
      "source": { "kind": "sourceSpan", "repo": "fastapi/full-stack-fastapi-template",
        "commit": "b1125d8839482cb7bbae603ddc6d0081bf87532e", "path": "backend/app/api/deps.py",
        "blobSha": "…", "span": { "startLine": 30, "endLine": 46 } },
      "excerpt": "def get_current_user(…)", "collectedBy": { "tool": "kalyth-analyzer", "toolVersion": "0.1.0" } } },
    { "op": "createObject", "ref": "$deps", "type": "software.Module", "stance": "asIs",
      "attributes": { "path": "backend/app/api/deps.py", "language": "python" },
      "claim": { "basis": "observed", "supports": [{ "allOf": ["$ev"] }],
        "observation": { "tool": "kalyth-analyzer", "toolVersion": "0.1.0", "coverage": "Python files tracked at the pinned commit" } } }
  ],
  "idempotencyKey": "analyzer-run-12-batch-1"
}
```

## Source snapshots and freshness

`core.SourceSnapshot` objects record, per repository, the commit a project reflects and the git blob
of each analysed file. `assessFreshness` (HTTP `GET /projects/:id/freshness`, MCP
`assess_freshness`) reports each claim as `current`, `weakened`, `stale`, `derived-stale`,
`unknown` or `not-applicable`. It is computed on read and never changes state (ADR 0009).

## Impact

`analyzeImpact` (HTTP `GET /projects/:id/impact?seed=...`, MCP `analyze_impact`) walks active
relations from seed elements in the direction each type's `impact` rule declares. It also follows
`contains` from an endpoint or data entity up to the module that defines it. Every reached element
carries a shortest typed path and its nearest seed. The result is deterministic and bounded by depth
and node count (ADR 0010).

## Situation

`getSituation` (HTTP `GET /projects/:id/situation`, MCP `get_situation`) lists what needs a person's
attention: open decisions with their alternatives, open questions, pending proposals, freshness
counts and the first 100 stale claims. It is computed on read. Pending proposals are listed as they
are now, whatever revision is asked for.

## Context packages and agent tokens

`compileContext` (HTTP `POST /projects/:id/context`, MCP `compile_context_package`) builds a
content-addressed package (`ctx_` + 32 hex digits of its SHA-256) at one revision. Its parts:

- **Mandatory, never truncated:** invariants, constraints, accepted decisions, acceptance criteria
  and the agent policy.
- **Optional:** items ranked by typed distance, cut at the size limit with omissions and retrieval
  calls.

If the mandatory part exceeds the limit, the package is `blocked` with `context_overflow` and a
suggested split. Packages are read back by id, over HTTP or MCP (`get_context_package`), or as
`kalyth://context/{id}`, and listed per project (`list_context_packages`). A proposal may name the
package it answers (`contextPackageId`); adapters check that it exists in the same project.

Agent tokens are issued, listed and revoked by a person with `grant.manage`, through HTTP
`/projects/:id/agent-tokens` and `/agent-tokens/:id/revoke`. Each token gives an agent principal
`project.read`, `proposal.create` and `task.work` on one project until it expires, and is the only
credential `/mcp` accepts (ADR 0011).

## Tasks

A `core.Task` changes status and lease only through `setTaskStatus`, along `TASK_TRANSITIONS`
(ADR 0013). People create and move tasks through ordinary proposals and read them over HTTP
(`GET /projects/:id/tasks`, `GET /tasks/:id`). Agents with `task.work` use MCP only:

- `claim_task` returns a lease, the context package to read and the commit trailer
  `Kalyth-Task: <task id>`. It is refused while another agent holds the task or its requirements
  are unmet. An expired lease moves the task to `unknown_outcome`; it is resumed only when no commit
  in the task repository carries its trailer.
- `renew_task_lease` and `release_task` need the current lease.
- `submit_execution_report` records the report as stated. When it names a commit, the git verifier
  checks that the commit exists, carries the trailer, changes exactly the files reported and
  descends from the task's base commit, and records the check as an observed `core.Verification`.
  A pass moves the task to `review`. Reported tests are recorded, not run.

Each task view carries `createdAt` and `updatedAt`, and each of its reports `reportedAt`. They are
the commit times, read from the project history, of the revisions that created the task, wrote its
current version (its last status, lease or attribute change) and recorded the report. A new report
alone does not change `updatedAt`. Nothing extra is stored for them.

The task coordinator commits these lifecycle records and nothing else; only a person acting
directly moves a task to `completed` or `cancelled`. The task repository, the local clone agents
commit to, is registered per project by a person with `grant.manage`
(`PUT /projects/:id/task-repository`); Kalyth only reads it.

## Navigator output

A Navigator run (HTTP only, started by a person) ends in one pending proposal by the Navigator
principal, which may only read and propose:

- **Summaries:** `core.Assertion` records with `concerns` relations.
- **Alternatives:** a `core.Decision`, its `core.Alternative` records (`alternativeOf`), `impacts`
  relations from an alternative to the elements it changes directly (`properties.change`), and
  `core.Question` records (`concerns`).

Every claim is `inferred`, with model provenance, confidence and validated citations as support
(ADR 0010).

## Proposal lifecycle

`pending` → `committed` | `rejected` | `stale` | `conflicting`; `invalid` when validation fails at
submission. Stale and conflicting are terminal: re-read and propose again. Rules: ADR 0004.

## Results

Success: `{status: "committed", projectId, revision, changeSetId, eventId, rebasedFrom, refs}`.
`refs` maps each local ref the proposal named to the id it resolved to, for example
`{"$task": "obj_…"}`, so a client can open what it just created without reading the proposal back.
It is empty when the proposal named no refs, and for results stored before refs were kept. In a
stored proposal, each resolved create operation keeps its `ref` beside the id.
Failure: `{code, message, issues[], requiredScopes?, currentRevision?, changedRefs?, retryAfterMs?}`
with codes `invalid`, `unauthenticated`, `unauthorized`, `stale`, `conflicting`, `not_found`,
`budget_exceeded`, `retryable`.

## Events

`project.created` (v1) and `changeSet.committed` (v1). Change-set events carry complete resolved
writes and are sufficient to rebuild revisioned state (ADR 0003).
