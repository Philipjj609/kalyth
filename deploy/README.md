# Deploying the hosted demo

The design and its limits are in [ADR 0019](../docs/adr/0019-hosted-demo.md). **Nothing here is
done without Philip's go-ahead** (amendment 1), and every step that creates a paid resource is
marked **paid: go-ahead needed**. Fly.io cannot cap spending, so the configuration and the audit
below are what keep the cost to about 14 USD through 15 December.

Philip runs these commands himself, with his own `flyctl` login, or asks Claude to run one named
step. No Fly.io token is kept in the repository, in GitHub or in CI.

## Prices

From [Fly.io's pricing page](https://docs.fly.io/about/pricing), read on 24 October 2026:

| What | Price |
|---|---|
| Machine `shared-cpu-1x` with 1 GB, while running | 6.70 USD a month |
| A stopped or suspended machine | its root filesystem only, 0.15 USD per GB a month |
| Volume | 0.15 USD per GB a month of provisioned size, even while the machine is stopped |
| Outbound traffic, North America and Europe | 0.02 USD per GB; inbound is free |
| Dedicated IPv4 | 2 USD a month; shared IPv4 and IPv6 cost nothing |

There is no platform fee, and a new organisation has no free allowance. Fly.io bills each
organisation separately.

## A dedicated organisation

The demo lives in its own Fly.io organisation, not in Philip's personal one:

- **Its own invoice.** Fly.io bills per organisation, so the demo's costs stay separate from
  anything else, and the invoice so far shows the demo alone.
- **Its own private network.** Fly.io connects the apps of one organisation over a private network.
  In a separate organisation, the demo can reach none of Philip's other apps, and they cannot reach
  it.
- **A clean audit.** `deploy/fly-audit.mjs` checks that the app sits in that organisation, and that
  nothing else does.

## Before the first deployment (free)

1. Build and run the image locally. It needs no key: recorded presets work, and live runs are off.
   The server listens on every interface inside the container, and the port is published on this
   machine's loopback address only.

   ```bash
   docker build -t kalyth-demo:local .
   docker run --rm -p 127.0.0.1:8080:8080 -e KALYTH_DEMO_HOST=127.0.0.1:8080 -e KALYTH_DEMO_LISTEN=0.0.0.0 kalyth-demo:local
   ```

2. Install `flyctl` and log in, as Philip: `fly auth login`.
3. Create the organisation with Philip's login: `fly orgs create kalyth`. If Fly.io gives it a
   different slug (organisation names are unique across Fly.io), use that slug wherever these steps
   say `kalyth`. Philip adds a payment method to the new organisation in the dashboard; nothing is
   billed until a step below creates a resource.
4. Create the app inside it: `fly apps create kalyth-demo --org kalyth`. An app without a machine
   or volume costs nothing. If the name is taken, change `app` and `KALYTH_DEMO_HOST` in `fly.toml`
   to match.
5. Set the secrets. Philip types these himself; they never appear in chat, documents or logs.
   Without a machine, nothing runs yet.

   ```bash
   fly secrets set -a kalyth-demo KALYTH_DEMO_JUDGE_CODE=<at least 16 characters>
   ```

   The Nebius key and the operator's consent wait until the live-run step below.

## Paid steps: go-ahead needed

6. **Paid: go-ahead needed. Volume, 1 GB, 0.15 USD a month:**
   `fly volumes create kalyth_demo_data --size 1 --region ams -a kalyth-demo`. It holds the spend
   ledgers, the template and the visitors' sandboxes (at most 640 MB, enforced by the server).
7. **Paid: go-ahead needed. One machine, 6.70 USD a month while running, plus traffic at 0.02 USD
   per GB** (at most 3 GB a day, enforced by the server):
   `fly deploy --ha=false --local-only -a kalyth-demo`. `--local-only` builds the image on this
   machine, so Fly.io creates no remote builder (another machine and volume in the organisation).
   Then confirm one machine: `fly scale count 1 -a kalyth-demo`.
8. **Free:** `node deploy/fly-audit.mjs kalyth-demo kalyth` must report only the expected
   resources.
9. **Live runs. Nebius spend, go-ahead needed** (within the 0.50 USD staging share of ADR 0019):

   ```bash
   fly secrets set -a kalyth-demo KALYTH_NEBIUS_API_KEY=<the demo's own key> KALYTH_DEMO_NEBIUS_CONSENT=<template project id>
   ```

   The template project id is printed by the server at startup, and is in
   `deploy/demo/template.json`. Setting the consent variable is the operator's consent to send that
   public project's excerpts to Nebius. Without the key or the consent, live runs stay off. Setting
   secrets restarts the machine, which starts every visitor afresh.

## Staging checklist (26 October)

Run after step 8, before the demo is announced. All of these are free.

- [ ] The audit passes: `node deploy/fly-audit.mjs kalyth-demo kalyth`.
- [ ] No dedicated IPv4: `fly ips list -a kalyth-demo` shows a shared IPv4 and IPv6 only.
- [ ] The demo answers: `curl -s https://kalyth-demo.fly.dev/api/v1/health` gives
  `{"status":"ok",…,"mode":"demo"}`, and the page opens in a browser.
- [ ] **The volume is writable by the server.** The server runs as the `node` user.
  `fly ssh console -a kalyth-demo -C "ls -la /data /data/work"` shows the owner. At staging on
  25 October, Fly.io mounted the volume as the image's user ("Mounting /dev/vdc at /data w/ uid:
  1000"), so no `chown` was needed. If a later deployment fails at startup with `EACCES` on
  `/data`, the volume's root is owned by root and needs a one-time `chown`.
- [ ] **Disk space.** `fly ssh console -a kalyth-demo -C "df -h /data"`. The sandbox limit assumes
  that at least about 720 MB of the 1 GB volume is usable (640 MB of sandboxes, the template, the
  ledgers and writes in flight). At staging the volume showed 974 MB, of which about 909 MB usable.
- [ ] **A client cannot choose its own address.** The per-address limits trust `Fly-Client-IP`, and
  Fly.io's documentation does not say whether its proxy replaces a value the client sends. Start
  21 sessions, each with a different forged value; the server allows 20 new sessions an hour per
  address:

  ```bash
  for i in $(seq 1 21); do curl -s -o /dev/null -w "%{http_code} " -X POST -H "x-kalyth-ui: 1" -H "content-type: application/json" -d '{}' -H "Fly-Client-IP: 192.0.2.$i" https://kalyth-demo.fly.dev/api/v1/demo/session; done; echo
  ```

  A `429` by the 21st means the proxy replaced the forged values, so they all counted against the
  real address: safe. Twenty-one `201` mean a client can choose its own key, which must be fixed
  before public testing. The sessions this creates expire after a day without use. At staging on
  25 October the proxy replaced them: after six earlier sessions from the same address, the 15th
  forged request was refused with `429`.
- [ ] **Idle suspension.** Leave the demo without visitors for 15 minutes, then
  `fly machine list -a kalyth-demo`. `suspended` means the health checks do not keep the machine
  awake, so it is billed mostly while in use. `started` means something keeps it running: the cost
  is then the full 6.70 USD a month, which the budget already assumes. The next request should
  wake a suspended machine within a second. At staging on 25 October the machine was `suspended`
  after 15 idle minutes, and the next health check answered in 0.82 seconds.
- [ ] The secrets are set, by name only: `fly secrets list -a kalyth-demo`.

## A deploy token, only if automation needs one

Releases are manual: Philip, or Claude at his request, runs `fly deploy` from a checked-out
commit. A push to GitHub deploys nothing. CI only builds the image, and no workflow uses a secret
or `flyctl`. At staging on 25 October, the app had no tokens (`fly tokens list -a kalyth-demo`),
and every release was made by Philip's own login (`fly releases -a kalyth-demo`).

Nothing needs a token today. If a script ever has to deploy, Philip creates a token scoped to this
one app, with a short expiry (Fly.io's default is 20 years):

```bash
fly tokens create deploy -a kalyth-demo --name "kalyth demo deploy" --expiry 72h
```

It is passed to that one run through the environment, never written to the repository, GitHub or
CI. Fly.io's documentation does not say whether a deploy token can create machines or volumes, so
treat it as able to spend. Revoke it when the run is done: `fly tokens list -a kalyth-demo`, then
`fly tokens revoke <token id>`.

## Every week, and after every deployment

- `node deploy/fly-audit.mjs kalyth-demo kalyth`.
- The invoice so far: Fly.io dashboard, the `kalyth` organisation, Billing.
- The inference allowance: the server's startup line, or `fly ssh console -a kalyth-demo` followed
  by `KALYTH_LEDGER=/data/ledger-public.sqlite node apps/server/src/cli/budget.ts` (and the same for
  `ledger-judges.sqlite`).

## Stopping it

- To pause at once: `fly scale count 0 -a kalyth-demo`. The volume, and with it the spend ledgers,
  stays, at 0.15 USD a month.
- After judging ends on 15 December 2026 at 12:00 PT: `fly apps destroy kalyth-demo`, which removes
  the machine and the volume. Then revoke the demo's Nebius key in the Nebius console, and any
  deploy token that still exists.
