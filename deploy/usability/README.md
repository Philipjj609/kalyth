# Newcomer session: project and recording

`clinic-bookings.json` is the project the newcomer session starts from (see
`docs/usability/idea-first-session.md`): "Clinic bookings", its idea, and nothing else. Its ids are
fixed, so a Navigator run recorded against it replays exactly when the tester asks for the same
thing on the day.

## Recording (once, after Philip's go-ahead: it spends about 0.02 USD)

Run from the repository root. The key stays in `.env` and is never printed.

```bash
KALYTH_DB=.kalyth/usability-record.db pnpm project:import deploy/usability/clinic-bookings.json
```

```bash
KALYTH_LEDGER=.kalyth/ledger-usability-recording.sqlite pnpm budget set 0.05 --note "<approval entry>"
```

```bash
KALYTH_DB=.kalyth/usability-record.db KALYTH_LEDGER=.kalyth/ledger-usability-recording.sqlite KALYTH_PROVIDER=nebius KALYTH_RECORD_DIR=deploy/usability/recordings node --env-file=.env apps/server/src/http/main.ts
```

Open the printed link, open Clinic bookings, choose **Sketch from the idea**, grant consent when
asked, and choose **Propose alternatives** without changing the text. The exchange lands in
`deploy/usability/recordings`. Stop the server and delete `.kalyth/usability-record.db*`.

## The session (no spend)

```bash
KALYTH_DB=.kalyth/usability.db pnpm project:import deploy/usability/clinic-bookings.json
```

```bash
KALYTH_DB=.kalyth/usability.db KALYTH_PROVIDER=replay KALYTH_REPLAY_DIR=deploy/usability/recordings pnpm dev:server
```

The first run replays only if its text is the idea as written; the Navigator form starts with it
filled in. A different request has no recording and fails with a clear message. Afterwards delete
`.kalyth/usability.db*`.
