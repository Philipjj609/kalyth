# Deploying the hosted demo

The design and its limits are in [ADR 0019](../docs/adr/0019-hosted-demo.md). **Nothing here is
done without Philip's go-ahead** (amendment 1): every step that creates a paid resource is marked.
Fly.io cannot cap spending, so the configuration and the audit below are what keep the cost to
about 14 USD through 15 December.

No Fly.io token is stored in GitHub or CI. Philip runs these commands with his own `flyctl` login,
or asks Claude to run a named step.

## Before the first deployment (free)

1. Build and run the image locally. It needs no key; recorded presets work, and live runs are off.

   ```bash
   docker build -t kalyth-demo:local .
   docker run --rm -p 8080:8080 -e KALYTH_DEMO_HOST=127.0.0.1:8080 kalyth-demo:local
   ```

2. Install `flyctl` and log in: `fly auth login` (Philip).
3. Create the app. An app with no machine or volume costs nothing:
   `fly apps create kalyth-demo`.

## Paid steps: go-ahead needed

4. **Volume, 0.15 USD a month:**
   `fly volumes create kalyth_demo_data --size 1 --region ams -a kalyth-demo`
5. **Secrets.** Philip types these himself; they never appear in chat, documents or logs:

   ```bash
   fly secrets set -a kalyth-demo KALYTH_NEBIUS_API_KEY=<the demo's own key> KALYTH_DEMO_JUDGE_CODE=<at least 16 characters> KALYTH_DEMO_NEBIUS_CONSENT=<template project id>
   ```

   The template project id is printed by the server at startup, and is in
   `deploy/demo/template.json`. Setting the consent variable is the operator's consent to send
   that public project's excerpts to Nebius. Without the key or the consent, live runs stay off.
6. **One machine, about 6.70 USD a month while running:** `fly deploy --ha=false -a kalyth-demo`.
   Then confirm one machine: `fly scale count 1 -a kalyth-demo`.
7. **Audit:** `node deploy/fly-audit.mjs kalyth-demo` must report only the expected resources.

## Every week, and after every deployment

- `node deploy/fly-audit.mjs kalyth-demo`.
- The invoice so far: Fly.io dashboard, Billing.
- The inference allowance: the server's startup line, or `fly ssh console -a kalyth-demo` followed
  by `KALYTH_LEDGER=/data/ledger-public.sqlite node apps/server/src/cli/budget.ts` (and the same for
  `ledger-judges.sqlite`).

## Stopping it

- To pause at once: `fly scale count 0 -a kalyth-demo`. The volume, and with it the spend ledgers,
  stays.
- After judging ends on 15 December 2026 at 12:00 PT: `fly apps destroy kalyth-demo`, which removes
  the machine and the volume. Then revoke the demo's Nebius key in the Nebius console.
