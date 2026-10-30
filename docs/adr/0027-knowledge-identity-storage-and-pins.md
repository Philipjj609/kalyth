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

**Embedded pinned content.** When a project creates a pin, the pinned version's canonical content
is copied into the project's own content store, keyed by `versionSha256`, in the same
transaction. It is immutable and never removed while anything cites it. So a project never needs a
library to be present to stay valid, and its export carries the content (section 6).

**Resolution order** for a pin:

1. the project's embedded content, by `versionSha256`;
2. the local library, at the pinned revision, when it is present (used to fill the embedded copy
   if it was ever lost);
3. a snapshot cache, then a remote publisher (later).

Every step verifies the hash before returning anything.

**Advancing a library.** When a LibraryUse moves to a newer revision, new pins embed the new
versions beside the old ones. Old pins, and the assessments that cite them, keep resolving to the
old content. So history and superseded assessments stay readable, and a diff between versions is
always possible.

### 2. Identity

- **Library:** its project id (`prj_…`), with a human label `publisher/name` that is not used for
  identity.
- **Knowledge item:** `(library, id)`, where `id` is the object or relation id, stable across
  revisions of that library.
- **Version:** `(library, id, revision)`, with `versionSha256`, the SHA-256 of the item's
  canonical form v1 at that revision (section 2a). `versionHash: "v1"` is stored beside the hash,
  so that a later form needs a new version, not a silent change.

Two libraries never share identity. "Rollback" in library A and "rollback" in library B are
different items, whatever their names.

### 2a. Canonical form v1, frozen

**What it covers.**

- Objects: `type`, `typeVersion`, `maturity`, `attributes` and `claim`. The claim holds `basis`,
  and `supports`, each group with `allOf` and its `review`.
- Relations: `type`, `typeVersion`, `properties` (for example `effect` and `note` of `affects`),
  `claim`, and `from` and `to`, as ids local to the library. Relations carry no maturity in v1; a
  relation is as mature as the review of its own claim.
- Each cited piece of evidence appears as `{ evidence: id, evidenceSha256 }`. `evidenceSha256` is
  the hash of the evidence record's own canonical form, including `SourceMeta` and its
  SourceVerification.
- It excludes anything computed on read (dispute, freshness) and every timestamp except those
  inside reviews and verifications.

**How it is written** (RFC 8785, JSON Canonicalization Scheme, with three restrictions):

1. Object keys sorted by UTF-16 code units, with no whitespace. Strings escaped as RFC 8785 and
   `JSON.stringify` do.
2. Every string and key in Unicode NFC, normalised at write time. A string with an unpaired
   surrogate is refused.
3. JSON numbers only for safe integers (|n| ≤ 2⁵³ − 1): revisions, versions, counts. Every other
   number is a **canonical decimal string**:
   - no sign for positive values;
   - no leading zeros before a non-zero digit;
   - no trailing zeros after the point, and no trailing point;
   - `-0` written as `0`;
   - no exponent.

   Values are normalised at write time, so the canonicaliser never parses numbers.

The bytes hashed are the UTF-8 encoding of that text. `null` and `false` are written; absent
optional fields are omitted, never written as `null`.

**Test vectors** (computed with the reference implementation; any implementation must reproduce
them, on every platform):

| Input | Canonical text | SHA-256 |
|---|---|---|
| `{b:2, a:1, c:[true, null, "x"]}` | `{"a":1,"b":2,"c":[true,null,"x"]}` | `ee78b758140705c9412a940a152d297a342a670a702f44047a9baefea5579abb` |
| `{name: "café"}` (decomposed) | `{"name":"café"}` (NFC) | `645fa443126a8954fc6d871912b8fc67bc2ee8feae417efe55546251962ca74d` |
| `{name: "café"}` (composed) | `{"name":"café"}` | `645fa443126a8954fc6d871912b8fc67bc2ee8feae417efe55546251962ca74d` |
| keys `é, z, a, 😀 (U+1F600), U+FFFF` | `{"a":3,"z":2,"é":1,"😀":4,"￿":5}` (UTF-16 order puts the surrogate pair before U+FFFF) | `e1abf7154a7a32ac09084702cc92b4b40b49f79d52e7037765805487abd60163` |
| a parameter value, `100.0 ms` | `{"kind":"point","unit":"ms","value":"100"}` | `160785619d37a878bda7cd9778f67534b4a9e84ae3ce2cef0768081d703694a3` |
| a `document` evidence record with `SourceMeta` (quote policy none) | `{"kind":"document","locator":"chapter 7","meta":{…},"uri":"urn:isbn:9780000000000","version":"2nd edition"}` | `85802ce60c18d2d21c9b2833a2624be58ce4542bb3863be315bf2b64aa34653e` |
| a `knowledge.Pattern` citing that evidence by `{evidence, evidenceSha256}` | (full text in the test fixture) | `a03662070ef94e049585876c25107cb33d6ab7c1048a1744d514407877a158bd` |

Decimal normalisation vectors: `0.10` → `0.1`; `+5` → `5`; `-0.0` → `0`; `1.500` → `1.5`;
`0100` → `100`; `-2.50` → `-2.5`.

The fixtures, with the full inputs, live with the implementation in K2. The table above is
normative, and a change to any hash in it is a change to the canonical form.

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

### 5a. When a referenced version is unavailable or corrupted

| Situation | Behaviour |
|---|---|
| The library is not present | Pins resolve from embedded content. Only actions that need the library's current head are refused, with that reason: moving a LibraryUse, and a method run's selection beyond the pins. |
| Embedded content is missing, but the library or a snapshot has the version | It is restored into the store after the hash checks, and the restoration is logged. |
| No copy with the right hash exists anywhere | The pin is `unresolved: "unknown-revision"` or `"unknown-target"`. Claims citing it show "evidence unavailable". Assessments that depend on it are stale, with that reason. Reassessing and method runs that need it are refused. |
| A copy exists but its hash differs | `unresolved: "hash-mismatch"`, reported as corruption with both hashes. The copy is never used, and never replaced by another version. A person restores it from an export or a snapshot that verifies. |
| Import of an export with a mismatched pinned hash | The import is refused as a whole (ADR 0014), naming the pin. |

Kalyth never substitutes another version, never drops the pin, and never turns an unresolved pin
into a verdict.

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
- I6. Creating a pin embeds its content in the same transaction; embedded content is immutable and
  kept while cited.
- I7. A resolver returns only content whose hash verifies; otherwise it returns a named failure.

## Migration consequences

- A new evidence kind extends a union; old stores and exports are unaffected.
- `core.LibraryUse` and `core.Correspondence` are new core types, version 1.
- Export format 2 is a breaking change for readers of exports; format 1 import stays supported,
  and the version is checked on import.
- The canonical form v1 and its test vectors are frozen by section 2a. K2 must reproduce them before
  it writes the first pin.
- Strings are normalised to NFC and decimals to canonical form at write time, for knowledge content
  and parameters. Existing project data is untouched, since nothing old is hashed this way.
- Embedded pinned content adds rows to each project's content store; it is never garbage-collected
  while cited.
- Snapshot caches are new files beside the store, and are read-only; deleting one only makes pins
  resolve from the project's own export or the local store.

## Test cases (for K2)

1. The canonical-form vectors of section 2a reproduce exactly on Linux and Windows, and across a
   store reopen. A non-NFC string is stored as NFC, an unpaired surrogate is refused, and a
   non-canonical decimal is normalised at write.
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
9. With the library deleted, a project's pins still resolve from embedded content, and moving its
   LibraryUse is refused with the reason "library not present".
10. After a LibraryUse moves, an old pin still resolves to the old content, and a superseded
    assessment still shows its explanation.
11. Corrupting embedded content gives `hash-mismatch`, the dependent assessments go stale with that
    reason, and reassessment is refused.

## Trade-offs left open

- Requiring explicit correspondences is laborious when two libraries overlap heavily. A model may
  propose correspondences in bulk, but each one is committed by a person.
- Embedding pinned content makes exports larger. That is the price of self-contained replay.
- Remote publishing, signing and trust in publishers are out of scope here.
