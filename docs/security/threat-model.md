# Threat model (local mode)

Date: 2026-10-19. Covers local mode, as shipped on `main`. The hosted demo's additions are proposed
in [ADR 0019](../adr/0019-hosted-demo.md) and will move here once it is built. Reporting: see [SECURITY.md](../../SECURITY.md).

## Scope and assumptions

Kalyth runs on one person's machine, for that person. The server binds to 127.0.0.1. The person
and their operating system account are trusted; anyone who can read their files or terminal can
read their Kalyth data too, and that is out of scope.

What is worth protecting:

- the project models in the ledger database (`~/.kalyth/ledger.sqlite` by default);
- source excerpts kept as evidence;
- provider API keys and the money they can spend;
- the UI session token and agent tokens;
- the person's own repositories, which Kalyth reads.

Who or what is not trusted:

1. **Web pages** open in the person's browser.
2. **Analysed repositories**: their files, commit messages and git configuration.
3. **Coding agents** connected over MCP, which may themselves be steered by injected text.
4. **Model providers and model output.**
5. **Files** handed to the import command.

## 1. Web pages: the HTTP API and UI

Threats: cross-site requests, DNS rebinding, token theft, script injection in the UI.

- The server listens on 127.0.0.1 only.
- Every request is checked for its `Host` header (`127.0.0.1:<port>` or `localhost:<port>`), which
  defeats DNS rebinding. Any `Origin` header must be the same two origins.
- Every `/api/` request needs the per-launch session token as a bearer token, compared in constant
  time. The routed pattern is checked as well as the raw path, so an encoded path cannot route
  around it. Only `/api/v1/health` is open.
- The token is 24 random bytes, new on every launch. The UI receives it in the URL fragment, which
  browsers never send to a server, keeps it in `sessionStorage` for that tab, and removes it from
  the address bar and history.
- The UI is served with a strict Content-Security-Policy: same-origin scripts only, no inline
  script, `frame-ancestors 'none'`. Also `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and
  same-origin opener and resource policies. React escapes all text; nothing uses raw HTML.
- Static files are confined to the web root, and dot segments are rejected.
- The request body limit is 2 MB.

Remaining risk: the startup line prints the full UI URL, token included, to the terminal. Anyone who
can read that terminal can use the API until the server stops. That is accepted for local mode.

## 2. Analysed repositories

Threats: code execution through git or parsers, hostile git configuration, secrets in the source,
and text written to steer a model or an agent.

**Nothing from a repository is executed.**

- Kalyth reads repositories with git plumbing only:
  - `rev-parse`, `ls-tree`, `cat-file`, `diff-tree`, `merge-base` and `log`;
  - no checkout, no hooks, no filters, no pager.
- Every git call sets `core.fsmonitor=false`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`.
- Refs that come from outside are passed after `--end-of-options`, so they are never read as
  options. Commit shas are also validated as 40 hex characters at the API boundary.
- Cloning (for `pnpm ingest` and `pnpm demo:setup`) makes a bare clone, over https only
  (`protocol.allow=never` with `protocol.https.allow=always`). A bare clone has no working tree, so no checkout filters, LFS
  smudge or submodules run.
- Python and TypeScript are parsed with tree-sitter compiled to WebAssembly. Nothing is evaluated.
  Files over 512 KB are skipped. Symlinks and submodules are not followed, and each skip is
  reported as a coverage limitation.

**Secrets.** An excerpt that matches a known secret pattern is stored as its hash only, with a
redaction marker, so it never reaches the content store, a model or an export. The patterns cover:

- private keys;
- AWS access keys;
- GitHub, Slack and Kalyth agent tokens;
- `sk-` style API keys;
- secrets assigned to variables named like keys, tokens or passwords.

This screen guards against accidentally capturing committed credentials. It is not a complete
secret scanner: high-entropy strings without a known shape are not caught.

**Injected instructions.** Every model prompt states that excerpts and labels are untrusted data and
that instructions inside them must be ignored. More importantly, model output has no authority of
its own:

- it can only become a proposal of inferred claims;
- every citation is checked against the pinned excerpts (ADR 0010, ADR 0017);
- a person reviews and commits.

An injected statement that survives as a grounded citation can still mislead the person reviewing
it. That review is the control.

## 3. Coding agents over MCP

Threats: an agent reading or changing projects it should not, committing its own work, spending
money, or claiming work it did not do.

- **Agent tokens.**
  - Each is `kalyth_at_` followed by 32 random bytes, shown once.
  - Only its SHA-256 hash is stored.
  - It expires, can be revoked, and is bound to one project with the scopes `project.read`,
    `proposal.create` and `task.work`.
  - Only a person acting directly, with `grant.manage` on that project, can issue, list or revoke
    tokens.
- **Separate credentials.** `/mcp` accepts agent tokens only, and `/api/` accepts the session token
  only. The UI token never works for an agent.
- **What agents can do.**
  - Agents read and propose. They cannot commit proposals, accept decisions, grant provider
    consent or start model runs.
  - A task's lifecycle is committed by the task coordinator. Only a person completes or cancels a
    task (ADR 0013).
- **Execution reports.**
  - Reports are checked against git: the commit exists, carries the `Kalyth-Task` trailer for that
    task, changes exactly the reported files, and descends from the task base.
  - Test results are the agent's own claim; Kalyth does not run them, and the verifier's recorded
    coverage says so (R4).
- **Isolation tests.** These pin that an agent token cannot read or claim work in another project.

Remaining risk: the stdio MCP server (`pnpm mcp:stdio`) runs as a local agent with the agent scopes on
every project, because the person starts it themselves. To confine an agent to one project, connect
it over HTTP with an agent token instead.

## 4. Model providers and spend

Threats: content sent to a provider without consent, uncontrolled spend, leaked keys.

- **Who starts spend.** Only a person acting directly can start a Navigator run or grant provider
  consent. Agents cannot do either.
- **The gateway** is the only path to a provider (ADR 0010). It applies its checks in this order,
  before any request leaves the machine:
  1. the model must be in the catalogue with the capabilities the run needs;
  2. the project must have consented to that provider;
  3. a worst-case reservation must fit the budget cap.

  A cap of zero refuses every paid call. Actual cost is settled after the call.
- **Keys.**
  - Keys come only from the environment or the git-ignored `.env`; `.env.example` lists names
    only.
  - The key is sent only in the `Authorization` header, over https, with redirects refused, and is
    scrubbed from any error text.
  - Recordings (`KALYTH_RECORD_DIR`) keep the model's response and a hash of the request, never
    the prompt or the key. Responses quote source text, so a recording is as sensitive as the
    project.
  - CI scans the full git history with gitleaks on every push to `main` and every pull request.
- **The OpenRouter test provider** (ADR 0016) accepts only `:free` model ids:
  - it checks the public model metadata for structured output support and a zero price;
  - it sends `require_parameters` with no fallbacks;
  - it stops itself for the rest of the process if a call reports any charge.

  It is for public repositories and synthetic tests only.

## 5. Export and import

- **Export** (`GET /projects/:id/export`, `pnpm project:export`) is for a person acting directly,
  with `project.read`. The file holds the project's events and stored excerpts; redacted excerpts
  stay hashes. Treat it like the database itself.
- **Import** (`pnpm project:import`) is a command-line action only; there is no HTTP route. The file
  is trusted input, like restoring a backup. Even so, it is validated against the export schema,
  unknown fields are refused, and the rebuilt state must hash to the exported `stateSha256`
  (ADR 0014).

## Supply chain

- Dependencies are pinned by `pnpm-lock.yaml`. `pnpm audit --prod` reported no known
  vulnerabilities on 2026-10-19.
- The CI secret scanner is a checksum-verified gitleaks release.

## Findings from the 2026-10-19 review

Fixed:

- `merge-base --is-ancestor` now passes refs after `--end-of-options`, like the other git calls.
  The refs were already validated as shas, so this is defence in depth.
- The task id is escaped before it is matched in the commit trailer. Task ids are UUIDs, so this
  too is defence in depth.
- New tests pin task isolation between projects, and that refs are read as revisions and task ids
  literally.

Accepted, noted:

- Reading a context package from a project the caller cannot read answers `unauthorized` rather
  than `not_found`, which reveals that the id exists. The ids cannot be guessed, so this reveals
  nothing useful.
- The session token is printed to the local terminal (section 1).
- The stdio MCP server has agent scopes on every project (section 3).
- The ledger database is not encrypted at rest. It relies on the operating system's file
  permissions.

Not covered by this model:

- the hosted demo, proposed in ADR 0019;
- multi-user deployments;
- running untrusted code. Kalyth never does it, so there is no sandbox.
