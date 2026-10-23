# Demo walkthrough (video under 3 minutes)

The video follows one change through Kalyth on the pinned holdout repository,
`fastapi/full-stack-fastapi-template`. The change is "add multi-tenancy". The path runs from the
analysed code to alternatives, a person's decision, a coding agent's work, and what goes stale when
the code moves on.

Target length 2:50. The hackathon limit is under 3:00, and the video must be public on YouTube.

## Set up

```bash
pnpm install && pnpm build
pnpm demo:setup --force        # .kalyth/demo.db: the template analysed at tag 0.12.0 (about 2 s)
KALYTH_DB=.kalyth/demo.db pnpm dev:server
```

In PowerShell, set the variable first: `$env:KALYTH_DB = ".kalyth/demo.db"; pnpm dev:server`.

Open the printed `http://127.0.0.1:4317/#token=...` link. The page moves the session token out of
the URL at once. Do not record the terminal while it shows that link. Restarting the server issues a
new token.

**Model output.** Nemotron output in the video must come from Nebius Token Factory. Either:

- **live:** the Navigator run happens on camera, with `KALYTH_PROVIDER=nebius`, a key in `.env`, a
  ledger cap and consent for the project; or
- **replayed:** the run is recorded once (`KALYTH_RECORD_DIR=...`), then replayed on camera with
  `KALYTH_PROVIDER=replay KALYTH_REPLAY_DIR=...`. Replays need no budget cap and cost nothing;
  the run says "recorded, replayed free", which counts as saying on screen that it is recorded.

Until the Nebius budget is approved, rehearse with the mock provider: set
`KALYTH_PROVIDER=mock` the same way as `KALYTH_DB`. A variable set like this wins over `.env`. Everything it writes says
"Mock output", and that output must not appear in the submitted video.

## Shot list

The change runs through one change thread: the Situation page leads into it, the canvas shows
where it lands, and reconciliation shows what the code now says.

| Time | Screen | What it shows | Narration in brief |
|---|---|---|---|
| 0:00 to 0:15 | Title, then Situation | The problem; "Needs you" and the system line for the template analysed at 0.12.0 | Coding agents and people lose the reasons behind a design. Kalyth keeps an engineering model where every fact points at the code it rests on. |
| 0:15 to 0:35 | Canvas, then the Inspector on `Item` | The drafting view: backend, frontend, the libraries; `Item` with its fields and its evidence `backend/app/models.py` at 84c5a9e; the provenance block (observed) | Static analysis only; nothing in the repository runs. Every claim carries its basis and its evidence. Note on screen: "Analysis precomputed with `pnpm demo:setup`". |
| 0:35 to 1:00 | New change, then the change thread | Request "Add multi-tenancy: every user and item belongs to an organisation"; NVIDIA Nemotron on Nebius Token Factory proposes alternatives with direct changes and the questions that decide between them; commit them | The model proposes. Kalyth checks every citation against the pinned source. Nothing lands until a person commits it. |
| 1:00 to 1:20 | Canvas, impact lens | One alternative's direct changes numbered on the drawing, and what they reach | Impact is computed by traversal, not guessed. |
| 1:20 to 1:40 | Comparison, then accept | Trade-offs and "What changes for people" marked as the model's interpretation, evidence below; nothing chosen until the person picks a column; accept with a reason, the open question carried with it | People decide, and the decision keeps what is still open. |
| 1:40 to 2:10 | Hand off, then Claude Code | Compile the context package; create a task; copy the prompt for the agent; Claude Code claims the task, reads the package, commits with the task trailer and reports; git verifies the report | The agent gets the context it needs at one revision, and its report is checked against git, not taken on trust. |
| 2:10 to 2:35 | Reconcile | "Compared base with commit": User and Item gained `org_id` and now reference Organisation; handlers changed in their own source; what the commit did not touch; anything not this task's | When the work comes back, the model learns what the code now says, and what the decision still lacks. It never claims the code runs correctly. |
| 2:35 to 2:50 | README | Limitations (FastAPI and SQLModel only; behaviour is not observed); NVIDIA Nemotron through Nebius Token Factory; Apache-2.0; the repository link | Open source. |

The reconcile shot needs a task commit in a task repository: rehearse with the multi-tenancy
commit used in the reconciliation test (alternative A4, users routes left out), or with Claude
Code's own commit if the live hand-off works.

## Check before recording

- [ ] `pnpm demo:setup --force` has just run, and the server was started afterwards.
- [ ] The Nemotron run is live, or replayed and labelled as recorded. No "Mock output" badge is on
      screen.
- [ ] Claude Code is connected with a token that expires in 1 day. Revoke it after recording.
      If the scripted stand-in agent (`pnpm demo:agent`) is used instead, the screen says so.
- [ ] No session token, agent token or API key is visible in the final cut. The Handoff view shows a
      new agent token once, so blur it or revoke it immediately.
- [ ] Browser zoom suits 1080p. One theme is used throughout. Other tabs and notifications are
      closed.
- [ ] Anything precomputed or replayed is disclosed on screen, as the Phase 0 plan requires.

## Rehearsal

The flow was rehearsed on 2026-10-17 against the demo database with the mock provider and the
scripted agent. Timings are server time:

1. **Navigator run:** 3 alternatives and 7 direct changes; the fabricated citation was rejected.
2. **The person's commit:** r2.
3. **Acceptance:** r3.
4. **Context package:** 54,208 characters (5,797 mandatory), 48 items.
5. **Agent's proposal:** linked to the package and listed under "What came back".
6. **Advance to the pinned commit:** revision 4 in 1.6 s, with 30 stale claims, 2 of them the
   decision's direct changes.
