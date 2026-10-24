# Recording the demo video

How the submission video was recorded on 24 October 2026 (KAL-20261023-045, then Philip's choice
of scripted takes recorded below). The shot list is in [walkthrough.md](walkthrough.md); this page
is the setup, the takes, the edit and the checks.

What the video must be:

- **Real, and plain about how it was made.** The app, its data and Claude Code's run are real. The
  browser steps are scripted: a script drives the real app at a person's pace, with a visible
  cursor. Claude Code runs unattended: it is started with Kalyth's prompt and nobody types after
  that. The title card and the agent chapter say both. KAL-045 planned an interactive session that
  a person answers; Philip chose the scripted takes and the unattended run instead, to be captioned
  as such.
- **One session a viewer can follow.** Every page change is a visible click, at normal speed; the
  takes are cut only where time passes (a form being filled, the agent working), with a short
  dissolve. Claude Code's own statements about what it did not run stay in.
- **Free of secrets.** No session link, agent token, home path or email address is ever on screen.
- **Under 3:00.** The cut comes to 2:54.

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
agent works (`worktree`); and Claude Code settings for the session (`claude-settings.json`). It
also installs the template's own checks (ruff and mypy) into the worktree with `uv sync`, so the
agent can check its work; `--no-checks` skips that. The paths hold no user name. It prints the base
commit and the server command. Then:

1. **Start the server** with the printed command, in a terminal you do not record: it prints the
   session link. In PowerShell, set each variable first (`$env:KALYTH_DB = "..."`).
2. **Register the task repository** in Tasks: `C:/kalyth-recording/repo`.
3. **Connect Claude Code.** In Agents and packages, issue a token labelled "Claude Code
   (recording)" that expires in 1 day, and copy it. In a terminal run `pnpm demo:recording
   connect` and paste it: the input is hidden, and the token goes only into
   `C:/kalyth-recording/mcp.json`, outside the worktree. Click "I have copied it" so the token
   leaves the page.
4. Open Claude Code once in the worktree, off camera, to accept the folder trust prompt.
5. Turn on Focus assist (no notifications) and clear the display you record.

### What the agent may do

`claude-settings.json` accepts edits inside the worktree and allows, without asking, Kalyth's MCP
tools, git, `cd`, `python -m py_compile`, and `uv run` for ruff, mypy and python. It refuses
reading or editing the MCP config and the settings, and commands that could show the machine, the
environment or another project, or reach the network: `docker`, `env`, `printenv`, `ps`, `curl`,
`git push`, `git remote`, `git config` and others. In an interactive session anything else asks the
person. In the unattended run (don't-ask mode) anything else is refused; that run also allows
`echo`, and edits inside the worktree.

These rules keep honest mistakes off camera; they are not a sandbox. Git can run other programs
through aliases and `-c` options, and the checks run code the agent wrote (`import app.models`
imports its models; mypy reads the project's configuration), so code from the agent could read the
token's file. What limits the token is its scope, one project, and its one-day expiry; revoke it
when the recording is done. The worktree has no remote.

## Takes

Each take is captured with ffmpeg from one 1920 by 1080 display, nothing else on it, at 30 frames a
second. The scripts that drive the takes live outside the repository for now; each writes a cue
sheet (the time of each step, the screen box of what it shows, and each cursor move, click and
keystroke) that the edit uses. Each browser take is first run headless against a throwaway copy,
since a take changes Kalyth's state and cannot be repeated on the same database.

**Take A, the browser.** A Playwright script opens the session link in a clean Chrome profile,
full screen at 150 % with the light theme, and works through the change as one session, moving
between pages by clicking them in the left navigation: Situation; Canvas, where it types "Item" in
the search and opens the Inspector, then scrolls to the evidence; New change with the request "Add
multi-tenancy: every user and item belongs to an organisation." and the focus User, then Item (any
other text or order has no recording); commit the alternatives; "Show on canvas" for A1, and back
to the change; the comparison; accept A1 with a reason; compile the context package; create the
task with its notes, these acceptance criteria and the base commit that setup printed,

- An Organisation table exists, and User and Item each have a nullable org_id that references it.
- One Alembic migration adds the table and both columns, and its downgrade removes them.
- Only the models and that migration change: backfill, NOT NULL and query filtering are later
  tasks.

mark it ready and open "Prompt for a coding agent". The task's notes name the checks that can run
here (ruff, mypy, an import check) and say the pytest suite needs PostgreSQL; the prompt quotes them.

**Take B, Claude Code.** Windows Terminal, full screen on the same display, starts Claude Code in
the worktree with the prompt as its first message:

```bash
claude --mcp-config mcp.json --strict-mcp-config --no-chrome --settings claude-settings-unattended.json --permission-mode dontAsk --append-system-prompt "In this session shell heredocs and quoted arguments that span lines are refused. Commit with git commit and one -m option per paragraph, each on a single line, with the Kalyth-Task trailer as the last -m." "<the task prompt Kalyth wrote>"
```

The first line on screen says the run is unattended, and the command shows the appended note. The
note is there because don't-ask mode refuses a heredoc or a quoted argument with a line break in
it, and two earlier tries stopped at exactly that: one at `git commit -F - <<EOF`, one at a `-m`
whose trailer paragraph had a line break. Both times the agent did the work, ran its checks and
then, refused, did not commit or report; each try was thrown away with its environment and take A
recorded again. The environment is cleaned first, so nothing of the recording machine's own
session shows, and Claude Code's temporary files go under the recording folder. The capture stops
once Claude Code's transcript shows its turn has ended.

**Take C, the browser again.** Situation, where "Needs you" now asks for a review of the agent's
report; "Open the change"; "Go to agent work": the report and its git verification; "Reconcile
with" the commit; the comparison (fields added to User and Item, the Organisation link proposed,
what the commit did not touch); the evidence the work moved, in the change's status.

## The edit

The cut is assembled with HyperFrames from the takes. The recording sits inset on the brand
background; a camera follows the cursor, easing toward where the next click lands and holding
while something is read; one-line captions sit below the frame, never over it, with the chapter's
name beside them. A take is cut only where time passes, with a 0.3 s dissolve: a focus being
picked, the reason and the task form being typed, marking the task ready, the walk back from the
canvas, the agent working, and the analyser running.

| Time | Chapter | From |
|---|---|---|
| 0:00 to 0:03 | Title | "Recorded 24 Oct 2026. Browser steps scripted; the app, its data and the agent's run are real." |
| 0:03 to 0:33 | 01 The model | Take A: Situation, the canvas, the Inspector's basis and evidence |
| 0:33 to 1:08 | 02 A change | Take A: the request, the Nemotron run ("recorded once; replays free"), the alternatives, the person's commit |
| 1:08 to 1:17 | 03 Impact | Take A: A1 on the canvas |
| 1:17 to 1:45 | 04 The decision | Take A: the comparison, the open questions, acceptance with a reason |
| 1:45 to 2:05 | 05 The hand-off | Take A: the context package, the task, the prompt |
| 2:05 to 2:24 | 06 The agent | Take B: claim and package, the edits, the migration, the checks, its final message |
| 2:24 to 2:50 | 07 What came back | Take C: the report and its verification, reconcile, the evidence moved |
| 2:50 to 2:54 | End | The repository link, Apache-2.0, the limits in one line |

In chapter 06 each shot frames the lines it is about. One of the agent's commands, `uv run
alembic heads`, was refused in don't-ask mode, and Claude Code printed a tip after the commit;
both are kept out of view. The agent says in its final message that the refused check did not
run, and that line is in the cut.

## Before publishing

- [ ] No frame shows the session link, an agent token, a home path, an email address or another
      project. Step through the first seconds of every take and every cut.
- [ ] The scripted browser steps and the unattended run are said on screen, and every replayed
      stretch is captioned. The Nemotron run shows "recorded, replayed free", and no
      "Mock output" badge appears.
- [ ] Claude Code's statements about checks it did not run are in the cut.
- [ ] The video is public on YouTube and under 3:00.

Afterwards: `pnpm demo:recording teardown`, revoke the token in Agents and packages, and delete
`C:/kalyth-recording` once the footage is final.
