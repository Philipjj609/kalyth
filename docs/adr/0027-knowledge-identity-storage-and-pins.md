# 0027. Knowledge identity, storage, pins and composition across libraries

Date: 2026-10-27. Status: Proposed, for review before any code. Builds on ADRs 0003, 0009, 0014
and 0026.

## Context

A project uses knowledge from one or more libraries (Philip's decision: several from the start,
tested first with one). This needs a stable notion of identity, a reference that cannot drift, a
way to find the referenced content wherever it is stored, and rules for libraries that overlap or
disagree. It must not merge claims silently, and it must keep each project self-contained, so that
export and replay (R3) still work.

The review asked to separate the **logical** kernel, which is one model with one set of rules,
from **physical** storage and the resolution of references between libraries.

## Decision

### 1. One logical kernel, several physical stores

Projects and libraries share the same contracts, registry, validation and event model: one
logical kernel. Where their records live is a separate concern, behind one interface:

```
interface LibraryResolver {
  /** The object or relation version at a revision, verified against its hash, or why not. */
  resolve(pin: KnowledgePin): ResolvedVersion | { unresolved: "unknown-library" | "unknown-revision"
                                                   | "unknown-target" | "hash-mismatch" }
}
```

Three implementations, in order of delivery:

1. **local:** the library is a project in the same store;
2. **snapshot:** a library export (ADR 0014), imported read-only into a separate cache file per
   library and revision, verified by `stateSha256` on import;
3. **remote** (later, its own ADR): fetched from a publisher and cached as a snapshot.

A project never needs a library to be present to stay valid. Its export carries the pinned content
(section 6), so pins resolve from the export itself.

### 2. Identity

- **Library:** its project id (`prj_…`), with a human label `publisher/name` that is not used for
  identity.
- **Knowledge item:** `(library, id)`, where `id` is the object or relation id, stable across
  revisions of that library.
- **Version:** `(library, id, revision)`, with `versionSha256`, the SHA-256 of the item's
  canonical form at that revision. The canonical form is the kernel's canonical JSON (sorted keys,
  no insignificant whitespace, UTF-8, numbers as written). It covers the type and type version,
  attributes, maturity, and the claim's basis, support groups with their evidence ids and reviews.
  It excludes timestamps of reading. This ADR freezes the canonical form, with test vectors.
  Changing it later would invalidate every pin, so that needs a new hash version (`versionHash:
  "v1"` is stored beside the hash).

Two libraries never share identity. "Rollback" in library A and "rollback" in library B are
different items, whatever their names.

### 3. Pins

A new evidence kind:

```
{ kind: "knowledge", library: ProjectId, target: "object" | "relation", id, revision,
  versionHash: "v1", versionSha256 }
```

A pin is immutable, like a source span pinned to a commit. Projects pin objects and relations,
since applicability depends on relations such as `appliesWhen`.

### 4. Using libraries: `core.LibraryUse`

A project declares each library it uses with an object, so that adding, moving and removing
libraries are revisioned, reviewable proposals:

```
core.LibraryUse { library: ProjectId, label, revision, role: "primary" | "supplementary" }
```

- Pins must cite the revision of the matching LibraryUse, or an earlier one. An earlier revision
  is stale (ADR 0029).
- Moving a LibraryUse to a newer revision is a proposal. Before it commits, it shows which pinned
  items changed hash and which assessments would go stale.
- `role` affects only how views order results. It never decides a conflict (section 5).

### 5. Composition and disagreement, without silent merging

- **No implicit equivalence.** Items from different libraries are related only by an explicit
  correspondence, owned by the project (or by a library that composes others):

  ```
  core.Correspondence { a: KnowledgePin, b: KnowledgePin,
                        relation: "sameAs" | "broader" | "narrower" | "related" | "conflictsWith",
                        note }
  ```

  It is `stated` by a person, or `inferred` by a model and then committed by a person.
- **Concepts across libraries.** A condition from library B about B's "players per match" is
  evaluated against a parameter on A's concept only through a `sameAs` correspondence between them,
  whose dimensions are compatible (ADR 0028). Without one, the condition is `unknown`, and the
  explanation says so.
- **Disagreement.** When pinned libraries give opposing guidance on the same element and scenario,
  each library is assessed separately. Opposing guidance means one pattern applying under A and not
  under B, or a `conflictsWith` correspondence. The combined verdict is `conflicting` (ADR 0028),
  with both explanations. Kalyth never picks a winner.
- **Resolution** is a decision, using the existing machinery. A `core.Decision` ("which guidance
  do we follow for real-time synchronisation?") has one alternative per position, and a person
  accepts one, with a rationale. Later assessments cite that decision, and they go stale if it is
  reopened.
- **Libraries composing libraries.** A library may pin another at an existing revision, under the
  same rules. Since pins point only to revisions that already exist, they cannot form a live cycle.
  Freshness propagates one pin deep; deeper chains are reported, not followed.

### 6. Export format 2

A project export gains `knowledge`: for every pinned version, its canonical content, `SourceMeta`
(ADR 0026) and `versionSha256`. Import verifies every hash before it replays. A library export is
an ordinary project export with `kind: "library"`. Format 1 still imports; its projects have no
pins.

## Invariants

- I1. Two items with different `(library, id)` are never treated as one without a committed
  `sameAs` correspondence.
- I2. A pin resolves to content whose hash equals `versionSha256`, or it is reported unresolved;
  it is never resolved to a different version.
- I3. A project's export resolves all of its pins without any library present.
- I4. A pin's revision is no later than its LibraryUse revision.
- I5. No assessment combines verdicts from two libraries without either a `sameAs` path or a
  `conflicting` result.

## Migration consequences

- A new evidence kind extends a union; old stores and exports are unaffected.
- `core.LibraryUse` and `core.Correspondence` are new core types, version 1.
- Export format 2 is a breaking change for readers of exports; format 1 import stays supported,
  and the version is checked on import.
- The canonical form and `versionHash: "v1"` must be fixed, with test vectors, before K2 writes
  the first pin.
- Snapshot caches are new files beside the store, and are read-only; deleting one only makes pins
  resolve from the project's own export or the local store.

## Test cases (for K2)

1. Canonical-form test vectors give the same hash on Linux and Windows, and across a store reopen.
2. A pin to a changed object reports `hash-mismatch`, never the new content.
3. A project exported with pins and imported into an empty store resolves every pin with no
   library present.
4. A pin to a revision later than its LibraryUse is refused.
5. Two libraries with same-named concepts: without a correspondence, a condition from B against a
   parameter on A's concept is `unknown`, explained. With `sameAs`, it evaluates.
6. Libraries A and B with opposing conditions for one pattern give `conflicting`, with both
   explanations. A committed Decision choosing A then gives A's verdict, citing the decision.
7. A library pinning another library: moving the inner pin reports staleness one level up.
8. Moving a LibraryUse lists the changed items and stale assessments before commit.

## Trade-offs left open

- Requiring explicit correspondences is laborious when two libraries overlap heavily. A model may
  propose correspondences in bulk, but each one is committed by a person.
- Embedding pinned content makes exports larger. That is the price of self-contained replay.
- Remote publishing, signing and trust in publishers are out of scope here.
