# 0009. Source snapshots, the repository analyzer and claim freshness

Date: 2026-10-16. Status: accepted. Gate G2; builds on ADRs 0005 and 0008.

## Context

Observed facts come from a repository at a commit. When the repository moves on, some facts still
hold, some move, and some disappear. The kernel must say which is which without guessing and
without silently deleting knowledge that people may have built decisions on.

## Decision

**Analyzer.** `packages/analyzer` reads git objects only (`ls-tree`, `cat-file --batch`; no checkout,
no hooks, nothing executed) and parses Python and TypeScript with tree-sitter. It observes systems
(repository), containers (directories with `pyproject.toml` or `package.json`), modules, module
imports, external libraries, FastAPI routes with full paths (router prefixes and `include_router`
chains, constant prefixes folded when unambiguous), and SQLModel tables. Every fact cites line
spans pinned to the commit and git blob, with the SHA-256 of the exact span text. Each import
statement or route definition is a separate support group (R2), so a dependency stays supported
while any one import of it remains. Coverage and limitations (unfolded prefixes, unresolved imports,
syntax-error nodes, conditional mounts) are written into each observation (R4).

**Source snapshot.** `core.SourceSnapshot` records, per repository, the commit the project reflects
and the blob of every analysed file. Advancing it is an ordinary change set, so history keeps every
earlier picture.

**Ingest.** The analyzer turns facts into one proposal against the current head: new facts are
created; re-observed facts whose evidence or attributes changed get a refreshed observed claim
(`updateObject`, or the new `updateRelation` operation); facts no longer observed are left as they
are. It commits with a tool principal holding only `ingest.observed`, so only observed records can
land. Re-ingesting the same commit produces no proposal.

**Freshness** is a read model, not stored state. Source-span evidence is fresh while the snapshot
maps its path to the same blob. A claim is `current` when every support group is fresh, `weakened`
when some groups are stale but one is entirely fresh, `stale` when none is, `unknown` when its
repository has no snapshot, and `not-applicable` without evidence. Staleness then propagates along
`derivedFrom` as `derived-stale`. Nothing is retired or revoked automatically; stale claims and the
decisions derived from them are review items for people.

## Consequences

- On the pinned demo repository, ingesting tag 0.12.0 produced 236 objects, 822 relations and 832
  evidence records in about a second. Advancing to b1125d88 refreshed 247 facts, created 8, left 783
  unchanged and marked 28 claims stale: the removed `*_pre_start.py` scripts and their tests, the
  dropped `tenacity` and `next-themes` dependencies, a removed test utility and their relations.
- Facts are matched to existing records by natural keys (module path, endpoint method and path,
  entity name, library ecosystem and name) and only among records this analyzer observed, so
  records people created are never overwritten.
- Limits: reads, writes and component grouping are not inferred yet; one ingest is one proposal
  (large repositories may need batching); queries use a 1000-row page per type for now.
