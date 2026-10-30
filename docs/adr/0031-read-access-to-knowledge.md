# 0031. Read-only access to knowledge and assessments (K4)

Date: 2026-10-30. Status: Proposed, for review. Builds on ADRs 0002 (one service layer), 0006
(authorisation), 0007 (MCP), 0026 to 0030 and the K3 amendments of ADR 0028.

## Context

K1 to K3 built knowledge libraries, pins, applicability and assessments as services. K4 makes them
usable by agents and other clients, read-only, through MCP and HTTP, without adding curation or
remote writes. An agent must be able to tell from each result whether it is current, stale,
unsupported or unresolved, and must never read `conditionsMet` as advice.

## Decision

### 1. One table, two interfaces

`apps/server/src/knowledge-api.ts` lists eight operations. Each is one service call with one input
contract (`packages/contracts/src/knowledge-read.ts` and `assessment.ts`), and each becomes:

- an MCP tool of the same name, annotated read-only and non-destructive;
- an HTTP route `POST /api/v1/knowledge/<name>`, taking the same input as its JSON body.

| Operation | Service | Reads |
|---|---|---|
| `search_knowledge` | `searchKnowledge` | a library at head, or every library a project uses at the revision it uses |
| `get_knowledge` | `getKnowledge` | one item at a library revision |
| `get_method` | `getMethod` | a `knowledge.Method`, read like `get_knowledge` |
| `list_library_uses` | `listLibraryUses` | a project's LibraryUses, presence and revisions behind |
| `get_pin_status` | `getPinStatus` | resolution and freshness of every pin (K2) |
| `assess_applicability` | `assessApplicability` | a verdict computed now; nature required (ADR 0028 A3) |
| `list_assessments` | `listAssessments` | recorded assessments with freshness |
| `get_assessment` | `getAssessment` | one recorded assessment with explanation and inputs |

**Contract differences.** The routes are `POST` although they only read, because their inputs are
structured (for example a pin-status preview map); they change nothing and are safe to retry. An
input that fails its schema is refused by MCP before the service runs and by the service for HTTP,
with the same error code (`invalid`, HTTP 422) and slightly different messages; successful results
are byte-identical, which the parity test checks.

### 2. Authorisation

Every operation runs the caller's ordinary checks: `project.read` on the project, and on every
library it reads. Reading a project does not grant reading the libraries it uses. `search_knowledge`
lists libraries it could not search ("not readable by this caller", "not present in this store")
and returns nothing from them. Over MCP, the caller is the connected agent principal with origin
`agent`, as for every tool (ADR 0007).

A consequence worth review: an agent token is issued for one project (ADR 0011), so an agent
connected over HTTP MCP cannot read the libraries its project uses unless a person also grants it
`project.read` on them. The local stdio agent has global read and is not affected.

### 3. How to read a result

Results of `get_knowledge`, `assess_applicability` and the assessment operations carry `readAs`:

```
readAs { recommendation: false, current, supported, resolved, note }
```

- `recommendation` is always `false`.
- `current`: an assessment's freshness (ADR 0029 §3); for knowledge, whether the revision read is
  the library's head; a computed assessment is current by definition.
- `supported`: for knowledge, at least one support group still counts; for an assessment, the item
  declares something that must hold (ADR 0028 A3).
- `resolved`: no condition was unknown for lack of a correspondence or for incompatible
  dimensions; unresolved pins are reported by `get_pin_status` and make assessing fail with a named
  reason.
- `note`: the same in words, including missing values, disputes, maturity, scenario status and
  conflict state.

Explanations stay complete and bounded: conditions evaluated with parameters, scope and nature,
other natures as context, missing values, maturity and dispute, library revisions and hashes read,
alternatives in other libraries and any settlement. `get_knowledge` lists at most 100 relations and
50 sources, and says how many relations it left out. Sources carry their attribution; locator
verification is reported apart from quote match (ADR 0030 A9).

### 4. A settled conflict stays visible

Explanations gain `conflict { state: none | unsettled | settled, note }`. When an accepted decision
settles a disagreement between libraries, the verdict follows the chosen guidance, but the state is
`settled`, the other libraries' verdicts stay in `alternatives`, and the note says the decision
chose what to follow without proving the other wrong. The evaluator version moves to 3.

## Verification

- Parity: each of the eight operations, called through MCP and HTTP on one store, returns the same
  canonical JSON, or the same error code.
- Access: a caller without `project.read` on a library sees it listed as not searched and is refused
  `get_knowledge`; a stranger is refused every operation; routes need the session token.
- A Claude Code round trip on 30 October 2026 (Claude Code 2.1.309, stdio MCP, `--strict-mcp-config`,
  only four Kalyth tools allowed, built-in tools denied) against the multi-game example: it called
  `list_library_uses`, `search_knowledge`, `assess_applicability` twice and `list_assessments`
  without errors, and reported the lockstep verdict for the shooter as `conditionsNotMet` from the
  element-scoped parameter, the authoritative server as `unknown` and underspecified, every result
  current, `recommendation: false`, and the knowledge as proposed. `pnpm knowledge:example` seeds
  the same data into `KALYTH_DB`.

## Not in K4

No writes of any kind beyond what existed; no curation tools; no UI or CLI for these operations (the
CLI order Philip set is knowledge search and read, pin status, applicability, then methods);
no remote or cross-store reads (K6). The hosted demo is unchanged and not redeployed.
