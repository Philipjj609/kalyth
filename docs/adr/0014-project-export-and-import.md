# 0014. Project export and import

Date: 2026-10-18. Status: accepted. Tier B; builds on ADRs 0003 (event log) and R3 from the
Phase 0 review.

## Context

A project's engineering model should belong to its owner: copyable to another machine, keepable
outside Kalyth, and checkable. The event log already rebuilds every revision (R3), so it is the
natural basis for a portable file.

## Decision

**An export is one JSON file** (`kalyth.project-export`, format 1) holding:

- the project summary;
- every event of the project, in order, exactly as stored;
- the content bodies the evidence refers to. Bodies redacted at ingest travel as null with their
  redaction reason, so a secret never leaves the store;
- the principals the history names (id, kind, display name), so history keeps its attribution;
- `stateSha256`: the hash of the revisioned state the events rebuild. JSON columns are hashed by
  content, so reformatting or key-sorting the file does not change it.

Proposals, grants, agent tokens, context packages, Navigator runs, the budget ledger and the task
repository setting are not exported. They are operational, derived or secret.

**Who exports.** Only a person acting directly, with `project.read`: the HTTP route
`GET /projects/:id/export` (the UI's Export button) and the local command
`pnpm project:export --project <id>`. MCP has no export tool, so no agent or relayed text can
trigger a bulk copy.

**Import is a local command** (`pnpm project:import <file>`) into the store `KALYTH_DB` names.
There is no HTTP import. In one transaction it:

1. validates the file against the contract, and refuses events that carry fields outside it;
2. checks consistency: the first event creates the project, revisions run 1 to head without gaps,
   every content body matches its hash and id, and every excerpt the events refer to is present;
3. refuses if the project already exists in the store;
4. adds missing principals without grants, replays the events, copies the events and content;
5. recomputes the state hash and rolls everything back unless it equals `stateSha256`.

An imported project is byte-for-byte the exported one: the same events, rows and content.

**Trust.** The file is not signed, and replay writes history directly, without the checks
proposals get. The import checks catch damage and inconsistency, not a forged history. Import only
files you trust, as you would a database backup.

## Alternatives

- **A SQLite file copy.** Simpler, but it carries the whole store (other projects, tokens, grants)
  and cannot be checked against anything.
- **Re-proposing every change on import.** It would re-run the kernel's checks, but the original
  revisions, authors and times would be lost, and history could not be reproduced exactly.
- **Signing exports.** Useful once exports move between people; deferred with multi-user support.

## Consequences

- R3 gains an end-to-end check that users can run: export, import elsewhere, compare hashes. The
  demo project (4 revisions, 283 object versions, 1,052 relation versions, 925 evidence records, 362 content
  bodies; 2.2 MB) exports and imports in under a second each.
- Event schema changes must keep old exports importable through the existing upcasting rule.
