# Recording the demo video

How the submission video is recorded (KAL-20261023-045). The shot list and narration are in
[walkthrough.md](walkthrough.md); this page is the setup, the takes, the edit and the checks.

What the video must be:

- **A genuine, interactive Claude Code hand-off.** A person starts Claude Code, pastes the task's
  prompt and answers it; Claude Code claims the task over Kalyth's MCP interface, changes the code,
  commits and reports, and Kalyth verifies the commit with git and reconciles its model. No
  scripted stand-in appears, and the session is never called unattended.
- **Honest about takes and cuts.** The video is edited from separate takes. A cut between takes is
  shown as a cut, with a caption where time passed; a shortened or sped-up stretch says so.
  Claude Code's own statements about what it did not run stay in.
- **Free of secrets.** No session link, agent token, home path or email address is ever on screen.
- **Under 3:00.** The plan below comes to 2:55 at most.

## Before recording (off camera)

```bash
pnpm install && pnpm build
```

```bash
pnpm demo:recording setup
```

This creates `C:/kalyth-recording` (on Linux and macOS, `/tmp/kalyth-recording`): its own Kalyth
database holding the demo template, so the recorded Nemotron run replays; a clone of the template
at 0.12.0 with no git remote (`repo`); a worktree on the branch `agent/multi-tenancy` where the
agent works (`worktree`); and Claude Code settings for the session (`claude-settings.json`). The
paths hold no user name. It prints the base commit and the server command. Then:

1. **Start the server** with the printed command, in a terminal you do not record: it prints the
   session link. In PowerShell, set each variable first (`$env:KALYTH_DB = "..."`).
2. **Open a clean browser window** on that link, with a throwaway profile and no address bar:
   `chrome --user-data-dir=C:/kalyth-recording/chrome --app=<the session link>`. The page moves
   the session token out of the URL at once. Maximise it on a 1920 by 1080 display, set the zoom to
   150 % and the theme to light, and keep both for every take.
3. **Register the task repository** in Tasks: `C:/kalyth-recording/repo`.
4. **Connect Claude Code.** In Agents and packages, issue a token labelled "Claude Code
   (recording)" that expires in 1 day, and copy it. In a terminal run `pnpm demo:recording
   connect` and paste it: the input is hidden, and the token goes only into
   `C:/kalyth-recording/mcp.json`, outside the worktree. Click "I have copied it" so the token
   leaves the page.
5. **Prepare the terminal you will record:** a clean window, a large font, sized to the frame,
   in `C:/kalyth-recording/worktree`. Do not start Claude Code yet.
6. Turn on Focus assist (no notifications) and close everything else.

### What the agent may do

`claude-settings.json` accepts edits inside the worktree and allows, without asking, Kalyth's MCP
tools, git and `python -m py_compile`. It refuses reading or editing the MCP config and the
settings, and commands that could show the machine, the environment or another project, or reach
the network: `docker`, `env`, `printenv`, `ps`, `curl`, `git push`, `git remote`, `git config` and
others. Anything else, such as reading outside the worktree or running the template's tests (they
need a database), asks the person; decline what the task does not need. A dry run on 23 October
confirmed that the MCP call, reads inside the worktree and `py_compile` run, and that `docker`,
`env` and reading `mcp.json` are refused.

Git itself can run other programs through aliases and `-c` options, so these rules keep honest
mistakes off camera; they are not a sandbox. The worktree has no remote, and the person watches the
session.

## Takes

**Take A, the browser (material for 0:00 to 1:50).** Follow the walkthrough to the hand-off:
Situation; the canvas and the Inspector on `Item`; New change with the request "Add
multi-tenancy: every user and item belongs to an organisation." and the focus User, then Item (any
other text or order has no recording); commit the alternatives; "Show on canvas" for A1; the
comparison; accept A1 with a reason. Then in the thread: compile the context package, create the
task with these acceptance criteria and the base commit that setup printed,

- An Organisation table exists, and User and Item each have a nullable org_id that references it.
- One Alembic migration adds the table and both columns, and its downgrade removes them.
- Only the models and that migration change: backfill, NOT NULL and query filtering are later
  tasks.

mark it ready, open "Prompt for a coding agent" and copy it.

**Take B, Claude Code (1:50 to 2:15).** Start Claude Code with the command `connect` printed:

```bash
claude --mcp-config C:/kalyth-recording/mcp.json --strict-mcp-config --settings C:/kalyth-recording/claude-settings.json
```

Check its first screen for anything personal before it is recorded. Paste the prompt and let it
work: it should claim the task, read the package, edit the models, write a migration, commit with
the task trailer and submit its report. Answer what it asks; decline what the task does not need.
Keep recording until its final summary, including what it did not run.

**Take C, the browser again (2:15 to 2:55).** In the thread: the agent's report and its git
verification; "Reconcile with" the commit; the comparison (fields added to User and Item, the
Organisation link proposed, what the commit did not touch, the evidence the work moved). Then the
README's Limitations on GitHub at the tag v0.1.0-rc.1.

## The edit

| Time | From | Caption on screen |
|---|---|---|
| 0:00 to 0:10 | Title card | Kalyth: an evidence-backed engineering model for people and coding agents |
| 0:10 to 0:35 | Take A: Situation, canvas, Inspector | Analysis precomputed: fastapi/full-stack-fastapi-template at 0.12.0 |
| 0:35 to 1:00 | Take A: New change, thread | Nemotron run recorded on Nebius Token Factory on 23 Oct 2026, replayed |
| 1:00 to 1:15 | Take A: impact lens | |
| 1:15 to 1:35 | Take A: comparison, accept | |
| 1:35 to 1:50 | Take A: package, task, ready, prompt | |
| 1:50 to 2:15 | Take B: Claude Code | Claude Code, interactive session, shortened from m:ss; each cut marked |
| 2:15 to 2:40 | Take C: report, verification, reconcile | Back in Kalyth, after the agent's report |
| 2:40 to 2:55 | Take C: README | Static analysis; behaviour not observed; open source (Apache-2.0) |

Shorten Take B by cutting while Claude Code works, not by dropping steps: claim, package, the
edits, the commit with its trailer, the report and its final words all stay. Mark each cut, and
label any speed-up (for example "2x").

## Before publishing

- [ ] No frame shows the session link, an agent token, a home path, an email address or another
      project. Step through the first seconds of every take and every cut.
- [ ] Every replayed, precomputed, shortened or sped-up stretch is captioned. The Nemotron run shows
      "recorded, replayed free", and no "Mock output" badge appears.
- [ ] Claude Code's statements about checks it did not run are in the cut.
- [ ] The video is public on YouTube and under 3:00.

Afterwards: `pnpm demo:recording teardown`, revoke the token in Agents and packages, and delete
`C:/kalyth-recording` once the footage is final.
