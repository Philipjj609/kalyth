# Demo walkthrough (video under 3 minutes)

The video follows one change through Kalyth on the pinned holdout repository,
`fastapi/full-stack-fastapi-template`. The change is "add multi-tenancy". The path runs from the
analysed code to alternatives, a person's decision, a coding agent's work, and what the model
learns when that work comes back.

The recorded cut is 2:54. The hackathon limit is under 3:00, and the video must be public on YouTube.

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

| Time | Chapter | What it shows | Narration in brief |
|---|---|---|---|
| 0:00 to 0:33 | Title, 01 The model | Situation for the template analysed at 0.12.0; Canvas, by the left navigation; "Item" typed in the canvas search; the Inspector on `Item`: its basis (observed), its evidence `backend/app/models.py:91-100` at 84c5a9e | Coding agents and people lose the reasons behind a design. Kalyth keeps an engineering model where every fact points at the code it rests on. Static analysis only; nothing in the repository runs. |
| 0:33 to 1:08 | 02 A change | New change, by the left navigation. Request "Add multi-tenancy: every user and item belongs to an organisation." with the focus User, then Item. NVIDIA Nemotron on Nebius Token Factory proposes four alternatives, their direct changes and the questions that decide between them; the person commits them | The model proposes. Kalyth checks every citation against the pinned source. Nothing lands until a person commits it. |
| 1:08 to 1:17 | 03 Impact | "Show on canvas" for A1: its six direct changes, the three new elements it proposes, and the 27 more it reaches | Impact is computed by traversal, not guessed. |
| 1:17 to 1:45 | 04 The decision | Trade-offs marked as the model's judgement, evidence below; the two open questions; accept A1 with a reason | People decide, and the decision keeps what is still open. |
| 1:45 to 2:05 | 05 The hand-off | The context package; the task with its notes, acceptance criteria and base commit; the prompt for the agent | The agent gets the context it needs at one revision. |
| 2:05 to 2:24 | 06 The agent | Claude Code, unattended: it claims the task and reads the package over MCP, edits the models, writes the migration, passes ruff, mypy and an import check, commits with the trailer, reports, and says what it did not run | The agent works from the package and reports what it checked, and what it could not. |
| 2:24 to 2:54 | 07 What came back, end | Situation asks for a review of the report; the report checked against git; reconcile compares 84c5a9e with the commit (User and Item gained `org_id` and reference Organisation, the Organisation link proposed); verification passed and the evidence moved by the work; the repository link and the limits | When the work comes back, the model learns what the code now says. It never claims the code runs correctly. |

## Check before recording

[recording.md](recording.md) lists the off-camera setup, what the agent may do, and the checks
before publishing: no session link, token, home path or email on screen; the scripted browser steps
and the unattended run said on screen; every replayed stretch captioned.

## The recorded run (24 October 2026, the cut's third version)

Claude Code 2.1.309 (claude-opus-5-5) ran unattended in the recording worktree, started with the
thread's prompt and the note on committing that [recording.md](recording.md) gives, for 1 min 5 s
by its own count. From its transcript:

- called `claim_task` and `get_context_package`; read the models and the latest migration; made
  the branch `kalyth/obj_01a16dfd-org-on-user-item` from 84c5a9e;
- added an Organisation table and a nullable `org_id` with an `org` relationship on User and Item,
  and wrote the migration b7e4c2a91d35 after fe56fa70289e;
- ran `uv run ruff check`, `uv run mypy app` (21 files) and an import of `app.models` that also
  configured the mappers: all passed;
- tried `uv run alembic heads`, which don't-ask mode refused, and checked the single head by
  reading the migrations instead;
- committed 33d9dd7 with the task trailer as its last line, and called `submit_execution_report`:
  outcome succeeded, 2 files, the three checks with their counts;
- said it did not run the pytest suite (it needs PostgreSQL), did not run the migration against a
  database, that `alembic heads` was blocked, that the context package's note on `env.py` asks for
  a backfill the acceptance criteria leave out, and that `org_id` has no index yet.

Kalyth's git verification passed and the task moved to review. Reconcile compared 84c5a9e1 with
33d9dd7d: 4 elements and 2 files changed; User and Item gained `org_id` and now reference
Organisation; Organisation is observed and its link was proposed for review;
`backend/app/alembic/env.py` was not changed; the decision's evidence was moved by the work for 5
of its 6 changes.

Two tries before it, without the note, did the same work and passed the same checks, then stopped
at the commit: don't-ask mode refused `git commit -F - <<EOF` in one and a `-m` with a line break
in the other, and the agent did not work around the refusal, so it neither committed nor reported.
The cut's second version used an earlier run (commit a3976e1), which got past the same refusal by
writing the message to a file.

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
