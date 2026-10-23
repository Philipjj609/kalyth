# Demo walkthrough (video under 3 minutes)

The video follows one change through Kalyth on the pinned holdout repository,
`fastapi/full-stack-fastapi-template`. The change is "add multi-tenancy". The path runs from the
analysed code to alternatives, a person's decision, a coding agent's work, and what the model
learns when that work comes back.

Target length 2:55 at most. The hackathon limit is under 3:00, and the video must be public on YouTube.

## Set up

[recording.md](recording.md) has the setup (`pnpm demo:recording setup`), the takes, the edit
and the checks before publishing. It uses the committed demo template (`deploy/demo/template.json`):
the template analysed at tag 0.12.0 with analyzer 0.3.0. Its ids are fixed, so the recorded
Nemotron run replays exactly; a fresh `pnpm demo:setup` analysis gets new ids, and no recording
matches it.

**Model output.** The Nemotron run is replayed: it was recorded once against Nebius Token Factory
on 23 October 2026 (KAL-20261023-041) and costs nothing to replay. It replays only for the exact
request below, with the focus User then Item, in that order. Any other request has no recording and
is refused with that reason. The run says "recorded, replayed free", which counts as saying on
screen that it is recorded.

## Shot list

The change runs through one change thread: the Situation page leads into it, the canvas shows
where it lands, and reconciliation shows what the code now says.

| Time | Screen | What it shows | Narration in brief |
|---|---|---|---|
| 0:00 to 0:10 | Title, then Situation | The problem; "Needs you" and the system line for the template analysed at 0.12.0 | Coding agents and people lose the reasons behind a design. Kalyth keeps an engineering model where every fact points at the code it rests on. |
| 0:10 to 0:35 | Canvas, then the Inspector on `Item` | Find `Item` with the canvas search; the drawing opens on `models.py`. The Inspector shows its basis (observed), its fields and its evidence `backend/app/models.py` at 84c5a9e | Static analysis only; nothing in the repository runs. Every claim carries its basis and its evidence. Note on screen: "Analysis precomputed and imported". |
| 0:35 to 1:00 | New change, then the change thread | Request "Add multi-tenancy: every user and item belongs to an organisation." with the focus User, then Item. NVIDIA Nemotron on Nebius Token Factory proposes four alternatives (A4 a hybrid of A1 and A2), their direct changes and the questions that decide between them; commit them | The model proposes. Kalyth checks every citation against the pinned source. Nothing lands until a person commits it. |
| 1:00 to 1:15 | Canvas, impact lens | "Show on canvas" for A1: its six direct changes numbered on the drawing, the three new elements it proposes, and the 27 more it reaches | Impact is computed by traversal, not guessed. |
| 1:15 to 1:35 | Comparison, then accept | Trade-offs and "What changes for people" marked as the model's interpretation, evidence below; nothing chosen until the person picks a column; accept A1 with a reason, its two open questions carried with it | People decide, and the decision keeps what is still open. |
| 1:35 to 2:15 | Hand off, then Claude Code | Compile the context package; create the task and mark it ready in the thread; copy the prompt for the agent; Claude Code claims the task, reads the package, commits with the task trailer and reports; git verifies the report. An interactive session, recorded as it ran: shorten it by marked cuts and say so on screen (recording.md) | The agent gets the context it needs at one revision, and its report is checked against git, not taken on trust. |
| 2:15 to 2:40 | Reconcile | "Compared 84c5a9e with the commit", for Claude Code's commit. On the rehearsal's prepared commit it showed User and Item gaining `org_id` and now referencing Organisation, the items handlers changed in their own source, what the commit did not touch, and the evidence the work itself moved; Claude Code's commit decides what appears | When the work comes back, the model learns what the code now says, and what the decision still lacks. It never claims the code runs correctly. |
| 2:40 to 2:55 | README | Limitations (FastAPI and SQLModel only; behaviour is not observed); NVIDIA Nemotron through Nebius Token Factory; Apache-2.0; the repository link | Open source. |

## Check before recording

[recording.md](recording.md) lists the off-camera setup, what the agent may do, and the checks
before publishing: no session link, token, home path or email on screen, and every replayed,
precomputed, shortened or sped-up stretch captioned.

## Rehearsal

Two rehearsals on 2026-10-23, each on a fresh import of the template in its own throwaway database,
replaying the recorded run, at 1280 by 720. The person's steps were the same in both:

1. **Navigator run:** replayed in about 4 s: four alternatives; 25 citations exact and 4 normalised
   of 39, 9 rejected.
2. **The person's commit:** r2, with three open questions, two of them deciding.
3. **Acceptance of A1** with its two deciding questions open: r3.
4. **Context package:** 39 items, 42,392 characters, at r3.
5. **Task:** created at r4 and marked ready at r5 from the thread.

### First run: a scripted stand-in, not a coding agent

Claude Code was not logged in yet. A scripted stand-in (agent token "RC rehearsal agent") claimed
the task, fetched the package, committed a change and reported over MCP. It did not write the
change: Claude Opus, as technical lead, wrote that A1 change beforehand without reading the
package, and the stand-in committed it with the trailer. Git verification passed; reconcile of that
prepared commit (e368ada, which also scoped the items routes) found 6 elements and 3 files changed.
This run tested Kalyth's side of the hand-off only, and found the defects listed below.

### Second run: Claude Code, over Kalyth's MCP

After Philip logged Claude Code in (claude.ai, Pro plan), Claude Code 2.1.309 ran the task
non-interactively, in the task repository, with Kalyth's own prompt from the thread and nothing
else:

```bash
claude -p "<the thread's prompt>" --mcp-config <file with the Kalyth endpoint and a 1-day agent token> --strict-mcp-config --permission-mode acceptEdits --output-format stream-json --verbose --allowedTools mcp__kalyth "Bash(git:*)" Read Edit Write Glob Grep
```

What Claude Code did, from its transcript (model claude-opus-5-5, 18 turns, 81 s):

- called `claim_task`, then `get_context_package` for the task's package;
- read `backend/app/models.py` and the Alembic history (git, cat, ls), then made its own branch,
  `kalyth/explicit-org-user-item`, from 84c5a9e;
- added an Organisation table and a nullable `org_id` on User and Item, with relationships, and
  wrote an Alembic migration by hand;
- tried to check its work with `uv run` (pytest, ruff, mypy) and `python -m py_compile`; neither
  was allowed in this run, so it ran no checks and said so;
- committed 13f0a1e with the task trailer, and called `submit_execution_report`: outcome partial,
  2 files, no tests, and a summary of what it left out (backfill and NOT NULL, query filtering, API
  schemas, tests) because the task's title did not ask for it;
- ended by asking the person which of those steps to do next.

Kalyth then: git verification passed all five checks and moved the task to review. Reconcile
compared 84c5a9e with 13f0a1e: 4 elements and 2 files changed. User and Item gained `org_id`,
referencing Organisation, and an `org` relationship; Organisation is observed and its link to the
proposed one was proposed for review; the migration was listed as a change the decision does not
name; `backend/app/alembic/env.py` was untouched; nothing changed in the routes, so the decision's
"filter all queries" is visibly not done. The next step read "Check the work against the decision,
then complete the task". The agent token was revoked afterwards.

Claude Code reported an equivalent cost of 0.70 USD. On a claude.ai login that counts against the
plan's usage, not a per-token bill.

What this run showed for the recording:

- **Allow the checks you want shown.** Without `uv` and `python` the agent can only say it ran
  nothing. To show tests, allow them, with the database the template's tests need.
- **Read-only commands run anyway.** Claude Code's defaults let `which` and `docker ps` run,
  although only git was allowed; `docker ps` listed other projects' containers. For the recording,
  deny what should not run (`--disallowedTools "Bash(docker:*)"`) or use a clean machine account.
- **It takes about a minute and a half, unattended.** Cut it down in editing and say so.

Fixed after the rehearsal: the header showed "$0.0000 left" for a free provider; an alternative's
lead could break inside a dotted name such as `app.current_org_id`; a task had to be marked ready
in the Tasks view; evidence the task's own commit moved was reported as if it moved on its own; the
Navigator form was cramped beside an open Inspector; the Inspector listed an entity's fields as raw
JSON (now one line per field, with its type, reference and base class); screens named people and
agents by principal id (now "you", or the principal's name, with the id in the tooltip).

Not rehearsed: `pnpm demo:agent`, which only proposes constraints and does not claim, commit or
report.

Still open: Nemotron proposed `User.org_id` and `Item.org_id` as entities of their own, so
reconcile shows them as "same file only" while User and Item show the field added. This is a
semantic-modelling limitation, not a reconcile defect: the model has no typed way to propose a
field of an existing entity. A typed fix (a field change on the entity) needs a prompt and schema
change, and so a new recording; it waits until after the release candidate.
