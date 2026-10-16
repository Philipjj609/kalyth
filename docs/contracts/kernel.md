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

## Proposal lifecycle

`pending` → `committed` | `rejected` | `stale` | `conflicting`; `invalid` when validation fails at
submission. Stale and conflicting are terminal: re-read and propose again. Rules: ADR 0004.

## Results

Success: `{status: "committed", projectId, revision, changeSetId, eventId, rebasedFrom}`.
Failure: `{code, message, issues[], requiredScopes?, currentRevision?, changedRefs?, retryAfterMs?}`
with codes `invalid`, `unauthenticated`, `unauthorized`, `stale`, `conflicting`, `not_found`,
`budget_exceeded`, `retryable`.

## Events

`project.created` (v1) and `changeSet.committed` (v1). Change-set events carry complete resolved
writes and are sufficient to rebuild revisioned state (ADR 0003).
