# Demo walkthrough (video under 3 minutes)

The video follows one change through Kalyth on the pinned holdout repository,
`fastapi/full-stack-fastapi-template`. The change is "add multi-tenancy". The path runs from the
analysed code to alternatives, a person's decision, a coding agent's work, and what the model
learns when that work comes back.

Target length 2:50. The hackathon limit is under 3:00, and the video must be public on YouTube.

## Set up

The video uses the committed demo template (`deploy/demo/template.json`): the template analysed at
tag 0.12.0 with analyzer 0.3.0. Its ids are fixed, so the recorded Nemotron run replays exactly.
A fresh `pnpm demo:setup` analysis gets new ids, and no recording matches it.

```bash
pnpm install && pnpm build
```

```bash
KALYTH_DB=.kalyth/video.db pnpm project:import deploy/demo/template.json
```

The agent's task repository is a clone of the template at 0.12.0. Put it outside the Kalyth
checkout, so Claude Code does not read Kalyth's own instructions while it works:

```bash
git clone https://github.com/fastapi/full-stack-fastapi-template ../kalyth-video-task
```

```bash
git -C ../kalyth-video-task switch -c multi-tenancy 0.12.0
```

```bash
KALYTH_DB=.kalyth/video.db KALYTH_PROVIDER=replay KALYTH_REPLAY_DIR=deploy/demo/recordings pnpm dev:server
```

In PowerShell, set each variable first, for example `$env:KALYTH_DB = ".kalyth/video.db"`.

Open the printed `http://127.0.0.1:4317/#token=...` link. The page moves the session token out of
the URL at once. Do not record the terminal while it shows that link. Restarting the server issues a
new token. In Tasks, register the absolute path of `../kalyth-video-task` as the task repository.

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
| 0:00 to 0:15 | Title, then Situation | The problem; "Needs you" and the system line for the template analysed at 0.12.0 | Coding agents and people lose the reasons behind a design. Kalyth keeps an engineering model where every fact points at the code it rests on. |
| 0:15 to 0:35 | Canvas, then the Inspector on `Item` | Find `Item` with the canvas search; the drawing opens on `models.py`. The Inspector shows its basis (observed), its fields and its evidence `backend/app/models.py` at 84c5a9e | Static analysis only; nothing in the repository runs. Every claim carries its basis and its evidence. Note on screen: "Analysis precomputed and imported". |
| 0:35 to 1:00 | New change, then the change thread | Request "Add multi-tenancy: every user and item belongs to an organisation." with the focus User, then Item. NVIDIA Nemotron on Nebius Token Factory proposes four alternatives (A4 a hybrid of A1 and A2), their direct changes and the questions that decide between them; commit them | The model proposes. Kalyth checks every citation against the pinned source. Nothing lands until a person commits it. |
| 1:00 to 1:20 | Canvas, impact lens | "Show on canvas" for A1: its six direct changes numbered on the drawing, the three new elements it proposes, and the 27 more it reaches | Impact is computed by traversal, not guessed. |
| 1:20 to 1:40 | Comparison, then accept | Trade-offs and "What changes for people" marked as the model's interpretation, evidence below; nothing chosen until the person picks a column; accept A1 with a reason, its two open questions carried with it | People decide, and the decision keeps what is still open. |
| 1:40 to 2:10 | Hand off, then Claude Code | Compile the context package; create the task and mark it ready in the thread; copy the prompt for the agent; Claude Code claims the task, reads the package, commits with the task trailer and reports; git verifies the report. Cut Claude Code's run down in editing and say so on screen | The agent gets the context it needs at one revision, and its report is checked against git, not taken on trust. |
| 2:10 to 2:35 | Reconcile | "Compared 84c5a9e with the commit", for Claude Code's commit. On the rehearsal's prepared commit it showed User and Item gaining `org_id` and now referencing Organisation, the items handlers changed in their own source, what the commit did not touch, and the evidence the work itself moved; Claude Code's commit decides what appears | When the work comes back, the model learns what the code now says, and what the decision still lacks. It never claims the code runs correctly. |
| 2:35 to 2:50 | README | Limitations (FastAPI and SQLModel only; behaviour is not observed); NVIDIA Nemotron through Nebius Token Factory; Apache-2.0; the repository link | Open source. |

## Check before recording

- [ ] `.kalyth/video.db` was imported fresh from `deploy/demo/template.json`, and the server was
      started afterwards with `KALYTH_PROVIDER=replay`.
- [ ] The task repository is registered, outside the Kalyth checkout, on a branch at 0.12.0.
- [ ] The Nemotron run is labelled "recorded, replayed free". No "Mock output" badge is on screen.
- [ ] Claude Code is logged in (`claude /login`) and connected with an agent token that expires in
      1 day. Revoke it after recording.
- [ ] No session token, agent token or API key is visible in the final cut. The Handoff view shows a
      new agent token once, so blur it or revoke it immediately.
- [ ] Browser zoom suits 1080p: 150 %, which gives the 1280 by 720 layout the rehearsal used. One
      theme is used throughout. Other tabs and notifications are closed.
- [ ] Anything precomputed, replayed or cut down is disclosed on screen, as the Phase 0 plan
      requires.

## Rehearsal

Rehearsed on 2026-10-23 for the release candidate, on a fresh import of the template, replaying the
recorded run, at 1280 by 720.

**No coding agent took part.** Claude Code is not logged in on this machine yet, so a scripted
stand-in took its place over MCP, with an agent token labelled "RC rehearsal agent". The stand-in
claimed the task, fetched the package, committed a change and reported. It did not write the
change: Claude Opus, as technical lead, wrote that A1 change into the task repository beforehand,
without reading the package, and the stand-in only committed it with the trailer, under the author
"RC rehearsal agent". So steps 6 and 7 rehearse Kalyth's side of the hand-off (claim, lease,
report, git verification, reconcile) on a plausible commit. They say nothing about how Claude Code
reads the package, what it changes or how it reports. Claude Code's own commit will differ, and so
will what reconcile shows; the 2:10 shot must show the result of that commit, not this one.

1. **Navigator run:** replayed in about 4 s: four alternatives; 25 citations exact and 4 normalised
   of 39, 9 rejected.
2. **The person's commit:** r2, with three open questions, two of them deciding.
3. **Acceptance of A1** with its two deciding questions open: r3.
4. **Context package:** 39 items, 42,392 characters, at r3.
5. **Task:** created at r4 and marked ready at r5 from the thread.
6. **The stand-in's report** (scripted, not Claude Code): partial, with the prepared commit e368ada;
   git verification passed all five checks.
7. **Reconcile of the prepared commit:** about 2 to 5 s, r8. It compared 84c5a9e with e368ada: 6 elements and 3 files
   changed. User and Item gained `org_id` and reference Organisation; GET and POST
   `/api/v1/items/` changed in their own source; `backend/app/alembic/env.py` was not changed; the
   link from the proposed Organisation to the observed one was proposed for review. The next step
   then reads "Check the work against the decision, then complete the task", because the evidence
   of 5 changes moved with the work itself.

Fixed after the rehearsal: the header showed "$0.0000 left" for a free provider; an alternative's
lead could break inside a dotted name such as `app.current_org_id`; a task had to be marked ready
in the Tasks view; evidence the task's own commit moved was reported as if it moved on its own; the
Navigator form was cramped beside an open Inspector.

Not rehearsed: Claude Code itself (see above), and `pnpm demo:agent`, which only proposes
constraints and does not claim, commit or report.

Still open: Nemotron proposed `User.org_id` and `Item.org_id` as entities of their own, so
reconcile shows them as "same file only" while User and Item show the field added. This is a
semantic-modelling limitation, not a reconcile defect: the model has no typed way to propose a
field of an existing entity. A typed fix (a field change on the entity) needs a prompt and schema
change, and so a new recording; it waits until after the release candidate. The run detail
names the requester by principal id. The Inspector lists an entity's fields as raw JSON under
Attributes, which reads poorly in the 0:15 shot.
