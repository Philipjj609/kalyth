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
  `KALYTH_PROVIDER=replay KALYTH_REPLAY_DIR=...`. The screen must say it is a recorded run.

Until the Nebius budget is approved, rehearse with the mock provider: set
`KALYTH_PROVIDER=mock` the same way as `KALYTH_DB`. A variable set like this wins over `.env`. Everything it writes says
"Mock output", and that output must not appear in the submitted video.

## Shot list

| Time | Screen | What it shows | Narration in brief |
|---|---|---|---|
| 0:00 to 0:15 | Title, then the Overview | The problem | Coding agents and people lose the reasons behind a design. Kalyth keeps an engineering model where every fact points at the code it rests on. |
| 0:15 to 0:35 | Overview | The template analysed at 0.12.0: about 1,060 records and 832 pinned evidence items, all observed | Static analysis only; nothing in the repository runs. Note on screen: "Analysis precomputed with `pnpm demo:setup` (2 s)". |
| 0:35 to 0:55 | Graph, then the Inspector on `Item` | The hierarchy, observed against inferred edges, `backend/app/models.py:87-93 @ 84c5a9e` with its excerpt | Every claim carries its basis and its evidence. |
| 0:55 to 1:25 | Navigator | Request "Add multi-tenancy: every user and item belongs to an organisation", focus `User` and `Item`; NVIDIA Nemotron on Nebius Token Factory returns alternatives, their direct changes and questions; the grounding report; the cost; "Show impact" with typed paths into about 25 modules and 23 endpoints | The model proposes. Kalyth checks every citation against the pinned source and computes impact by graph traversal, not by guessing. |
| 1:25 to 1:40 | Proposals, then the alternatives viewer | Commit the Navigator's proposal, then "Accept this alternative" with a rationale | Nothing a model writes lands until a person commits it. Decisions are accepted by people. |
| 1:40 to 2:10 | Handoff, then Claude Code, then Handoff | Compile the context package for the decision (mandatory part never cut), issue an agent token, `claude mcp add --transport http ...`; Claude Code reads the package and proposes with the package id; "What came back" lists it; commit | The agent gets exactly the context it needs at one revision, and its work comes back as a proposal tied to that package. |
| 2:10 to 2:30 | Terminal, then the Navigator's Situation panel | `pnpm ingest --ref b1125d88...` (about 1.6 s) creates revision 4; 28 observed claims go stale, and so do the two direct changes of the accepted alternative, because `models.py` changed | When the code moves on, Kalyth shows which knowledge, and which decisions, need another look. |
| 2:30 to 2:50 | README | One known limitation (reads and writes between code and data are not inferred yet); the evaluation and its sample size; NVIDIA Nemotron through Nebius Token Factory; the repository link | Open source, Apache-2.0. |

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
