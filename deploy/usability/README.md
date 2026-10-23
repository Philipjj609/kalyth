# Newcomer session: project and recording

`clinic-bookings.json` is the project the newcomer session starts from (see
`docs/usability/idea-first-session.md`): "Clinic bookings", its idea, and nothing else. Its ids are
fixed, so a Navigator run recorded against it replays exactly when the tester asks for the same
thing on the day.

## Recording

`recordings/` holds the session's first run: Nemotron's answer to "Sketch from the idea" for this
project, recorded on 23 October 2026 under the D5 approval (KAL-20261023-041) for 0.0201 USD.
Recording again spends money and needs a new go-ahead and a capped ledger of its own:

```bash
KALYTH_LEDGER=<ledger> pnpm budget set 0.05 --note "<approval entry>"
```

```bash
KALYTH_SESSION_RECORDING_LEDGER=<ledger> KALYTH_SESSION_NEBIUS_CONSENT=prj_01a167652db9705d82d5c35fd4ae3427 node --env-file=.env apps/server/src/demo/record-session.ts
```

It makes exactly the request the workbench makes from "Sketch from the idea". The key stays in
`.env` and is never printed.

## The session (no spend)

```bash
KALYTH_DB=.kalyth/usability.db pnpm project:import deploy/usability/clinic-bookings.json
```

```bash
KALYTH_DB=.kalyth/usability.db KALYTH_PROVIDER=replay KALYTH_REPLAY_DIR=deploy/usability/recordings pnpm dev:server
```

The first run replays only if its text is the idea as written; the Navigator form starts with it
filled in. Replays need no budget cap and cost nothing; the run says "recorded, replayed free". A
different request has no recording and is refused with that reason. Afterwards delete
`.kalyth/usability.db*`.
