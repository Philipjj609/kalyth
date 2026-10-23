# Idea-first session with someone new to Kalyth

A 35-minute moderated session at Philip's machine. One person who has not seen Kalyth uses it
to go from an idea to work a coding agent could start. We learn where the journey is unclear,
and whether they can tell what Kalyth observed, what a model suggested and what they decided.

## What counts as this test

Only a session with a person new to Kalyth counts. Claude's own walk through the journey on an
empty install (20 October) found and fixed obvious stalls, but it is not usability testing: Claude
knows the product. Keep two tests apart:

- **The newcomer session** (this kit): does the journey make sense to someone who has not seen
  Kalyth? Real Navigator output, recorded or live, is preferred.
- **A live run with the real model**: does Nemotron's output for an idea hold up? This needs
  inference spend and its own go-ahead.

If the session uses the mock, or any scripted example, say so to the tester and in the findings.

## Who

Someone who builds, commissions or manages software, and has not used or been told about Kalyth.
Not a Kalyth contributor. Tell them it is a test of the tool, not of them.

## Setup (Philip, before the session)

1. Start from a clean database, so nothing from earlier work shows:

   ```bash
   KALYTH_DB=.kalyth/usability.db KALYTH_PROVIDER=mock pnpm dev:server
   ```

2. **Model output.** The session needs real Navigator output; the mock's placeholder names
   ("Visit 8569") would distract. A recorded run replays only for the exact project and request
   it was recorded with, so:
   - **Preferred:** the D5 re-recording includes one idea-first run for the "Clinic bookings"
     project (about 0.02 USD, asked for with D5). Import that project before the session
     (`pnpm project:import <file>`) and start the server with the recordings. The tester then
     opens the project instead of creating it.
   - **Fallback:** a live Nebius run during the session, with consent granted in the UI and a
     cap Philip sets (one run costs roughly 0.01 to 0.02 USD).
   - If neither is available, run the session with the mock and tell the tester that the
     options are placeholders; judge the flow, not the content.
3. Open the browser at the session link the server prints, full screen, light theme.
4. Have this sheet and the observation table below at hand. Record the screen only with the
   tester's agreement.

## Briefing (read as written)

> "Thanks for helping. This is a tool for planning changes to software. I'd like to see how you
> use it without help, so I'll mostly stay quiet. Please think aloud: say what you're looking
> at, what you expect, and what surprises you. There are no wrong answers; anything confusing is
> the tool's fault. You can stop at any time."

Do not explain what Kalyth is, what the Navigator is, or what "observed", "inferred" or "stated"
mean. If they ask, answer: "What do you think it means?" Give a hint only after two minutes of
being stuck, and note it.

## Tasks

Give one task at a time, on a card. Stop a task after its time limit.

| # | Task (as given) | Limit | Done when |
| --- | --- | --- | --- |
| 1 | "You have an idea: a small clinic wants patients to book, move and cancel appointments online, and reception to fill gaps from a waiting list. Use Kalyth to get some options for building it." | 8 min | The alternatives are in front of them and committed (or they explain why not). |
| 2 | "Choose the option you would go with, and record why." | 8 min | An alternative is accepted with a reason. |
| 3 | "Get the work ready for a coding agent." | 7 min | A context package is compiled and a task created; they find the prompt for the agent. |
| 4 | "Tell me what Kalyth now knows about this system, and how sure it is." | 5 min | They open the canvas or a record and describe it. |
| 5 | "Is anything here already built?" | 2 min | They answer, and say how they know. |

## What to watch (observation table)

For each task note: completed unaided / with a hint / not completed; time; where they
hesitated; what they misread; and quotes.

Watch especially for:

- **Where they start.** Do they find "Sketch from the idea" on the Situation page?
- **Proposals.** Do they understand that nothing is in the model until they commit or accept?
- **Choice.** On the comparison, do they read the trade-offs and "What changes for people" as the
  model's judgement, and the direct changes as evidence? Do they look for a recommendation?
- **Questions.** Do they answer the deciding question before accepting, or accept with it open,
  and do they understand what happens to it?
- **Hand-off.** Do they understand that this project has no code yet, and what the agent prompt
  is for?
- **Kinds of knowledge.** In tasks 4 and 5, can they tell proposed (to-be, dashed) from observed,
  and inferred from stated, in their own words? Does anyone believe something is built?

## Debrief (5 minutes)

1. "In your own words, what is this tool for?"
2. "What was the most confusing moment?"
3. "Which things on the screen would you trust, and which would you check?"
4. "Would you use this for a real change? Why, or why not?"
5. "If you could change one thing, what would it be?"

## Success for the release candidate

- Tasks 1 to 3 are done without a hint.
- The tester explains, unprompted or in the debrief, that the options came from a model and that
  nothing is built yet.
- No one leaves believing Kalyth changed code or verified that it runs.

Anything that blocks a task, or a misreading of what is observed, built or decided, is a
finding: Claude files it in the Review Queue with the screen, the quote and a proposed fix.

## Privacy

The session stores only what the tester types, in the local `usability.db`. Delete it after the
session (`.kalyth/usability.db*`). Do not record personal details in the findings; refer to the
tester as "the tester".
