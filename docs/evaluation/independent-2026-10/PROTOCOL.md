# Independent evaluation of Kalyth, October 2026: protocol

Status: designed, not run. Written on 24 October 2026 by a Claude Opus 5.5 session that does not
implement Kalyth. Revised on 25 October 2026 for version 2 of the truth (section 5). Nothing here
has been run. The exact steps are in [RUNBOOK.md](RUNBOOK.md).

## 1. The question

Does a coding agent make a demanding, cross-cutting change more completely and more correctly with
Kalyth's context package and MCP tools than with a plain prompt, or with retrieved repository
files? The other conditions stay the same: the agent, the model, the task and the budget.

This is the comparison the canonical contracts ask for (04, Transactions, Context and Capability
Contracts, section B): "compare same model with ordinary prompt, retrieved docs, and semantic
context", with an equivalent task, budget and evidence sources.

The answer is reported whatever it is. Section 10 defines in advance what counts as Kalyth not
helping.

## 2. What this reuses, and what the harness cannot express

Reused as it is:

- **The truth rule of ADR 0012.** The truth is fixed and hashed before anything runs on it, and it
  is never edited toward Kalyth's output.
- **The harness's lexical retrieval** (`packages/eval/src/retrieval.ts`: BM25 over 60-line chunks,
  lockfiles and binaries excluded). It builds the context of the retrieval arm.
- **The harness's scorer** (`packages/eval/src/score.ts`, `scoreFiles`). It gives file-level
  recall, precision and invented paths.
- **The demo hand-off** (`docs/demo/walkthrough.md`, `docs/demo/recording.md`,
  `pnpm demo:recording`). It provides the recorded Navigator run on the template, the
  task-and-package flow, the Claude Code invocation, and the settings that limit what the agent
  may do.
- **Context packages and MCP** (ADR 0011), **tasks and git verification** (ADR 0013) and
  **reconcile** (ADR 0024). They are used only in the Kalyth arm, exactly as a user would use
  them.

What `pnpm eval` cannot express. Each gap is handled by the RUNBOOK's commands, not by new code:

| Gap | How this protocol handles it |
|---|---|
| Its conditions are single model calls through Kalyth's gateway (Nebius, OpenRouter or the mock). There is no coding agent, no edits and no commits. | The three arms are Claude Code runs. `pnpm eval` itself is not run: it needs paid inference, which is not authorised. |
| One truth file holds one repository and commit. | `ground-truth.json` holds two scenarios, each with its own repository and commit. Each scenario carries a `harness` block in the harness's `impacted`/`newFiles` shape, so a harness truth file can be derived if the single-call comparison is ever authorised. |
| One set of truth paths. | Required and acceptable files: recall uses required files, precision uses both. `scoreFiles` is called twice. Both numbers are diagnostic (section 6). |
| Scores files only. | Elements, claims and scope are scored by a blind reviewer against the truth's checklists. Behaviour is scored by hidden acceptance checks. |
| Tokens and latency come from gateway call records. | Taken from Claude Code's `stream-json` result event, and from the plan's usage meter. |
| No blinding and no human scoring. | Arms are relabelled and scrubbed before review (section 7). |

Reconcile is not used to score. It can only compare commits for a Kalyth task, so it would
measure arm K with a tool the other arms do not get. The Kalyth arm runs it as part of its normal
flow, and its result is reported beside the scores.

## 3. Scenarios

Both scenarios are in [`ground-truth.json`](ground-truth.json), with their request, the person's
notes, acceptance criteria, decision, files, elements, required changes, acceptance checks and
what cannot be known statically.

### (a) `autogen-studio-user-scoping`: an unseen repository

**Change.** Make every AutoGen Studio endpoint act as the authenticated user. Today the routes
trust a `user_id` query parameter or body field. Run and message reads and the settings update
have no ownership check at all. The run WebSocket registers a connection before checking who it
belongs to, so a stranger's connection replaces the owner's and, when it is refused, stops the
owner's run. The change touches 21 endpoints, which today sit in six route files; an
implementation may instead put the check in one shared place. It also touches a data rule the
code hides: messages are stored without a user, so a message belongs to whoever owns its run.

**The one role exception.** At the pinned commit the only role check in the backend is in
`web/routes/ws.py`, `run_websocket`: a user whose token's `roles` include `"admin"` passes the
run-owner check, so an admin may open any run's WebSocket. No HTTP route checks roles:
`require_admin` and `require_roles` exist in `web/auth/dependencies.py`, but no route uses them,
and no auth provider assigns `admin` (roles default to `["user"]`). Version 2 keeps this exception,
explicitly and no wider: it applies to the run WebSocket only, it is checked with ownership before
the connection is registered, and no HTTP endpoint gets any role exception. The task text, the
truth, the hidden checks (A-C15, A-C16) and the reviewer's sheet all say this.

**Static, not runtime-verified.** Everything above was read from the source at the pinned commit;
none of it has been run. The vulnerability is reported as observed in source until the hidden
checks fail on the base commit (RUNBOOK section 3), and the report says which facts are static and
which a check showed at run time.

**Repository.** `microsoft/autogen` at `004749e6b7102c8fd317b9b1499ce5807223c278` (16 October
2026), subtree `python/packages/autogen-studio`. MIT (`LICENSE-CODE`). Kalyth has never been run
on it.

**Selection criteria and candidates.** Three candidates were shallow-cloned read-only into
`C:\kalyth-eval\`; none of their code was run.

| Criterion | Langflow (`langflow-ai/langflow`) | ZenML (`zenml-io/zenml`) | AutoGen Studio (chosen) |
|---|---|---|---|
| Licence | MIT | Apache-2.0 | MIT |
| Maintenance | very active (22 Oct) | active (14 Oct) | maintenance mode: 4 commits to the monorepo in 2026, 2 of them security fixes to Studio (March); latest commit 16 Oct |
| Size | 4,930 Python and 2,732 TypeScript files; 62 tables; about 380 routes | 2,501 Python files; 52 tables; 270 routes | 73 Python and 125 TypeScript files; 9 tables; 34 routes |
| Inside Kalyth's coverage | tables and routes yes; reads in routes yes | tables and routes yes; **reads and writes no**: routers call `zen_store()` 438 times and never `select`, so all data access sits in a 17,000-line store | tables, routes and WebSockets yes; data access partly (see below) |
| Tests without external services | SQLite, but a very large dependency install | SQLite store | SQLite (`test_db_manager.py`); no route tests exist |
| A broad change that is not already there | weak: audit events, Casbin roles, teams, shares and SSO already exist | weak: workspaces and RBAC exist | strong: user scoping is missing, and every route and the WebSocket need it |
| Ground truth writable reliably in one session | no | no | yes |

- **Langflow was rejected** for size and because the obvious cross-cutting changes (audit logging,
  authorisation, tenancy) already exist. A truth over about 380 routes could not be written
  reliably before the runs, and each agent run would cost several times the usage budget.
- **ZenML was rejected** because its data access lives behind a store object the analyzer does not
  follow. The comparison would mostly measure that gap, and the repository is also very large.
- **AutoGen Studio fails one criterion: it is maintained, not actively developed.** It was chosen
  anyway, because it meets every criterion that bears on the result: a real, used, permissive
  application Kalyth has never seen, the right size, inside the analyzer's coverage, tests on
  SQLite, and a security change that is genuinely missing. If Philip requires active
  development, a fourth candidate needs his go-ahead to clone (decision D1).

Kalyth's other test repositories (fastapi, excalidraw and saleor, ADR 0025) were excluded because
they shaped the analyzer.

**How much is outside Kalyth's coverage.** This comes from reading the analyzer's rules; the run's
step 0 records the analyzer's own coverage report.

- Inside:
  - all 9 tables, 6 of them affected;
  - all 34 routes, 21 of them affected; the two WebSocket routes are recorded with method `ANY`;
  - all modules and imports.
- Outside, and what the change hinges on:
  - the authentication dependency that decides the user;
  - the `filters` dictionaries of `DatabaseManager`, which carry the ownership rule today;
  - writes through `db.upsert` and `db.delete(...)`;
  - the `/api` mount prefix;
  - the WebSocket manager's in-memory state;
  - runtime auth configuration.

So Kalyth can point at every affected endpoint and table, but it cannot see the rule being
changed. That is a fair, demanding test of what static evidence is worth.

### (b) `template-tenancy-complete`: the harder change on the holdout

**Change.** Implement multi-tenancy completely:

- an Organisation table, with `org_id` NOT NULL on User and Item;
- a migration that backfills existing rows into "Default";
- items shared within an organisation, and 404 across organisations;
- superusers stay global;
- organisation assignment on every path that creates a user or an item: a superuser's
  `POST /users/`, signup, the private endpoint and `init_db`;
- `org_id` cannot be changed, and it appears in the public schemas;
- tests.

The demo's agent did only the models and the migration. This is the full change, and the
template's own tests must change with it.

**Repository.** `fastapi/full-stack-fastapi-template` at tag 0.12.0,
`84c5a9e11a9e58262599e3d772f5386924e02ca7`. This is the commit of the demo template and of the
recorded Navigator run.

**Decision.** The decision comes from the recorded replay; there is no live call. Alternative A1,
"Explicit org on both User and Item", is accepted. Its three open questions are answered with the
recorded options that agree with A1:

- superusers stay global;
- PostgreSQL in production and in tests;
- existing data goes into a single default organisation.

A stricter variant, organisation-scoped superusers, would make every user endpoint change. It was
not chosen. It contradicts A1's own text ("superusers bypass the org filter"), so arm K's package
would contain a line the person overruled, and the other arms would not. That would confound the
comparison.

**Caveat.** The template is not unseen. Kalyth's analyzer was developed on it and the demo uses it,
so (b) is in-sample. It tests the full Kalyth flow, including the Navigator's recorded
alternatives. Scenario (a) carries the weight of the conclusion (section 10).

**Coverage.** All 23 routes and both tables are inside the analyzer's coverage. Outside it:

- the `CurrentUser` dependency;
- the private router's runtime switch (`FASTAPI_ENV`);
- migrations as schema operations;
- PostgreSQL behaviour;
- the frontend's calls.

## 4. Arms

Every arm runs the same agent:

- Claude Code, one pinned version, the same model (Claude Opus 5.5 unless Philip chooses
  otherwise, decision D3) and the default effort;
- non-interactive (`claude -p`) in a fresh clone of the pinned commit, with history cut at that
  commit and no remote;
- the same permission settings: edits inside the clone, git without push, remote or config, the
  scenario's checks, no web tools, and nothing outside the clone;
- the same limits: `--max-turns` and a wall-clock timeout;
- the same runtime and test environment: one machine, one Python and one set of installed
  packages per scenario, recorded once and used by every arm and by the scorer (RUNBOOK
  section 2).

Every arm also gets the same task text: the scenario's request, the person's notes, the acceptance
criteria, a commit instruction and the report format of RUNBOOK section 5.

| Arm | Adds to the shared task text | MCP |
|---|---|---|
| **P**, plain prompt | nothing | none (`--strict-mcp-config`, empty config) |
| **R**, retrieved files | the top BM25 chunks for the request, at most 60,000 characters, from the harness's retrieval | none |
| **K**, Kalyth | the task's `agentPrompt` from Kalyth, which tells it to claim the task, read the context package (compiled with `maxChars` 60,000) and report; Kalyth's MCP tools (impact, objects, relations, evidence, packages, tasks) | Kalyth only, with a one-day agent token for one project |

- **Same budget.** R's retrieved text and K's package have the same character ceiling. P gets no
  pre-loaded context. All arms can still read the repository themselves, as real agents do.
- **Information parity.** Arm K's decision and task contain nothing the shared task text lacks,
  except what Kalyth derives itself: the analysis, impact paths, the package, and on (b) the
  recorded Navigator alternatives. On (a) the stated decision names only the six tables the
  request names. Philip states it before the runs.
- **What K carries beyond context.** It also carries a process: claim, branch, trailer and report.
  That costs turns and may improve self-reporting. P and R get the same report format, so
  self-reporting is compared on equal terms. The process cost shows up in turns and tokens.
- **No live Navigator.** Kalyth runs with `KALYTH_PROVIDER=mock` for (a), and in replay-only mode
  for (b).

## 5. Ground truth

- File: [`ground-truth.json`](ground-truth.json), format `kalyth-independent-eval/1`, version 2,
  frozen on 25 October 2026. Version 1 was committed in 9d22c08.
- **SHA-256 of the file:** `a7918daba624b8d84bf42be3a91e126953e01b13e3a1e609aafb43f778a3fe20`.
- SHA-256 of each scenario, as `JSON.stringify` of the parsed object:
  - `autogen-studio-user-scoping`: `9de2413b3f63dde1fb48915875c745191a67561efa6f58c36ee57f569522c4a5`
  - `template-tenancy-complete`: `9abe2e5347c21cab041627194b4a7de226e62db5550ee1ac5249d2a764e388ec` (unchanged from version 1)
- Version 1, now superseded: file `f8328f6ef917896bc2581836a4a6d7a724124715096826a481196a2e2b382696`.

**Changes from version 1.** ChatGPT reviewed version 1 independently (Drive queue
KAL-20261025-051). It approved scenario (a) in principle, with two corrections, and version 2
applies both to scenario (a) only. The file's `changelog` records them.

1. The file sets of (a) are diagnostic (`files.role`). Authorisation may be centralised, so a
   correct implementation may change fewer or different files. Correctness rests on the hidden
   checks and on element and endpoint completeness (section 6).
2. v1 asked for authenticated-user-only access, yet said the WebSocket's admin exception "may
   stay". That was a contradiction. The exception is now kept explicitly, as the narrow
   WebSocket-only exception the source shows (section 3), and HTTP routes get none. The request,
   the notes, the criteria, A-E21, A-R7 and the new A-R9 are aligned with it. The check setup
   adds carol, an admin who owns no rows, and two checks: A-C15 (the admin may connect to the run
   WebSocket) and A-C16 (no admin bypass on HTTP).

**Independence.** The truth was written from each repository's source at its pinned commit, read
with git and grep, before any run.

- Kalyth's analyzer, impact traversal, context compiler and agents were not run on either
  scenario, and no package for either was read.
- For (b), the writer read the recorded A1 alternatives, because the decision is taken from them,
  and the walkthrough's account of earlier agent runs. The `independence` field says so.

**Countersignature (decision D2).** ADR 0012 and decision D13 ask a reviewer other than the
implementer to freeze the truth. This truth was written by a Claude session that does not
implement Kalyth, but it is the same model family as the implementer and the agent under test.

ChatGPT reviewed version 1 at Philip's request and asked for the corrections above. Philip either
approves version 2 as it stands (`countersignedBy` stays `null` in the file, so the hash does not
change; the approval is recorded in the queue with the hash), or asks for version 3. Any new
version is a new file with a new hash, recorded before any run.

**Errata.** The truth may be wrong, for example if an arm finds an element that is truly affected
and the truth misses it. If so:

1. The blind reviewer flags it with code evidence.
2. A corrected version is published with that evidence and applied to every arm.
3. Scores are reported under both versions.

A correction is never made because Kalyth's output differs from the truth.

## 6. Metrics, and who scores them

"Auto" means a deterministic command from the RUNBOOK, run by the run session on saved artefacts,
so it can be reproduced. "Reviewer" means the blind reviewer (section 7).

| # | Metric | Definition | Scored by |
|---|---|---|---|
| M1a | Files against the truth's file sets (**diagnostic only**) | `changed` = existing files the final commit changes against the base (`git diff --name-only`). File recall = `scoreFiles(changed, required).recall`, and its `missed` list. File precision = `scoreFiles(changed, required ∪ acceptable).precision`. New files are listed and not scored. These numbers show where an arm made its change, not whether it is correct, and enter no verdict. For (a) the sets are marked diagnostic in the truth: an arm that centralises authorisation and changes fewer or different files loses nothing for it. | Auto |
| M1b | **Elements found and missed** (primary) | Units: (a) the 21 `codeChange` endpoints. (b) the 8 `codeChange` endpoints, 3 entities, 2 new relations, 3 functions, the migration and the public schemas: 18 units. Each unit is marked *correct*, *partial or wrong*, or *untouched* from the diff, by its behaviour: a change in shared code the unit's handler calls (a dependency, a manager, the database layer) counts for every unit it fixes, and the file it sits in does not matter. On (a), A-E21 is correct only if the existing admin-role exception is kept and widened to nothing, and an HTTP endpoint that lets any role reach another user's rows is wrong. Element recall = (correct + partial) / units. Element correctness = correct / units. | Reviewer |
| M1c | Stated impact | The files and elements the arm's report names as affected, scored like M1a (files, diagnostic) and M1b (elements). This credits finding without implementing. Report paths that do not exist are *invented*: `scoreFiles(...).unsupported`. | Auto (files), Reviewer (elements) |
| M2 | Wrong or unsupported claims | Every factual statement in the report about the code, the behaviour or the checks run is classed as: *supported*; *wrong*, contradicted by the base or final code or the run log; or *unsupported*, with no evidence in the transcript (for example "tests pass" when none ran). Count wrong + unsupported, plus invented paths. | Reviewer, with Auto for paths and the command log |
| M3 | Changes outside the task's scope | Auto: files changed outside required ∪ acceptable, with lines changed, listed for the reviewer and not counted. Reviewer: each such file, and any behaviour change the request did not ask for (a changed response shape, a new endpoint, an edited old migration, a frontend change, a role exception beyond the WebSocket's), is classed *harmful*, *unnecessary* or *justified extra*. A file changed to carry the requested scoping in one place is judged by what it does, not by its path. Harmful and unnecessary are counted. A justified extra that shows the truth is wrong triggers the errata process; a different placement of the same change does not. | Auto and Reviewer |
| M4 | **Verification outcome** (primary: hidden-check pass rate) | Hidden acceptance checks passed out of the total (section 8). Also: base tests that passed still pass; the arm's own tests pass; ruff (and mypy for (b)); git checks (a commit exists, descends from the base, the tree is clean, nothing is committed outside the repository, no secrets). For K only, Kalyth's verifier verdict and the reconcile summary are reported and not compared. | Auto |
| M5 | Said what it could not see | (i) Every check the report says it ran appears in the transcript with that result (yes/no). (ii) The report names what it did not run or verify (yes/no). (iii) The truth's `staticallyUnknowable` items the report raises, or an equivalent: n of 6 for (a), n of 5 for (b). | Reviewer, with Auto for (i) |
| M6 | Tokens, time and review effort | Input, output and cache tokens, equivalent cost, turns and wall time from Claude Code's result event; the change in plan usage per run (`get_usage`, coarse). Reviewer minutes per diff, and a 1 to 5 rating of "would merge after small fixes". For K, the person's setup minutes (decision, package, task) are reported separately. | Auto, Reviewer |

The primary outcomes, fixed now, are M1b element recall and M4 hidden-check pass rate on
scenario (a). Correctness rests on these two: the behavioural hidden checks, and element and
endpoint completeness. Everything else is secondary, and the file numbers (M1a, M1c files) are
diagnostic only. All numbers are reported per run and as mean and range per arm, with no claim
of statistical significance.

## 7. Blinding and the reviewer

- **Relabelling.** Before review, each run's diff, report and command log is relabelled X, Y or
  Z by a random permutation. The key is sealed: its SHA-256 is recorded in the run log, and the
  key stays with the run session until all reviewer scores are saved.
- **Scrubbing.** A scrub step replaces text that names Kalyth: "Kalyth", "context package", the
  MCP tool names, `ctx_` and `obj_` ids, `Kalyth-Task:` trailers and branch names. Style can still
  give an arm away; this is a stated threat.
- **What the reviewer sees.** The base commit, the scrubbed diff, report and command log, the
  truth, and the scoring sheet. Not the transcripts.
- **Who reviews (decision D5).**
  - Recommended: Philip, about 20 to 30 minutes per run.
  - Alternatives: ChatGPT, or a separate Claude session with Philip spot-checking one run in
    three. Both are named in the report.

## 8. Run plan (summary; the steps are in RUNBOOK.md)

1. **Before any run.**
   - Philip makes the decisions in section 11.
   - The truth hash is checked.
   - The hidden acceptance checks are written from the truth's `acceptanceChecks`, stored outside
     every clone, and run against the base commit. The scoping checks must fail there and the
     happy-path checks pass. Their hash is recorded before any arm runs, so they are frozen before
     anyone has seen an arm's output.
   - The environments and Kalyth are prepared, and the step 0 coverage is recorded. The base
     commit's own tests are run once in the shared environment, to show that they actually run;
     which pass is recorded, and only those count in M4.
   - Nothing is changed after the first arm starts, except a check bug shown on the base commit.
     Such a fix is applied to all arms and reported.
2. **Order.** Runs are sequential. For repetition r, the arm order is the Latin-square row
   r = 1: P R K, r = 2: R K P, r = 3: K P R. Scenario order alternates by repetition: a then b,
   b then a, a then b. The small variant draws one arm order at random and records the draw.
3. **Each run** starts from a fresh clone, and for K from a fresh Kalyth database prepared the
   same way. Its prompt, settings, transcript, final diff, report and usage are saved.
4. **Scoring.** Auto metrics first; then relabelling and scrubbing; then review; then unsealing;
   then the report.

### Variants and usage

Claude Code runs draw on Philip's plan, so the estimates are in percentage points (pp) of the
weekly "all models" limit. They are calibrated on two readings:

- the demo agent run: 18 turns, an equivalent of 0.70 USD;
- this design session: about 25 turns at roughly 300,000 tokens of context moved the weekly meter
  by about 2 pp, with another session running in parallel.

A real agent run here is expected to take 40 to 70 turns at a 50,000 to 100,000 token context:
about **1 to 1.5 pp** on (a) and **1.5 to 2.5 pp** on (b). The 5-hour window moved about six times
faster than the weekly meter, so runs should be spaced.

| Variant | Runs | Agent runs | Preparation and checks | Orchestration and auto scoring | Claude review | Total |
|---|---|---|---|---|---|---|
| **Full** | 2 scenarios × 3 arms × 3 | about 29 pp | about 4 pp | about 4 pp | about 3 pp (0 if Philip reviews) | **about 40 pp (30 to 55)** |
| Medium | 2 scenarios × 3 arms × 1 | about 10 pp | about 4 pp | about 2 pp | about 1 pp | about 17 pp (12 to 22) |
| **Small** | scenario (a) × 3 arms × 1, `--max-turns 40`, 20-minute timeout | about 3.5 pp | about 1.5 pp (checks for (a) only) | about 1 pp | 0 (Philip reviews) | **about 6 pp (4.5 to 8)** |

- **Timing.** The weekly meter read 59% when this was written, and optional work stops at 70 to
  75%. The small variant fits this week. The full variant does not, and belongs after the reset
  on 30 October, 04:00 UTC.
- **Stop rule for every variant.** Read the meter before and after each run. Pause if a single
  run moves it by more than 2.5 pp (a) or 3.5 pp (b), if the 5-hour window passes 85%, or if the
  total would pass the share Philip set. The report states every pause and every run not made.
- **The small variant's limits.** One run per arm is anecdotal. It answers whether the setup works
  and whether there is a large difference on the unseen repository. It cannot show a small
  difference (section 10).

## 9. Threats to validity

1. **One model family throughout.** The truth writer, the agent under test, Kalyth's implementer
   and possibly the reviewer are all Claude. Shared blind spots could make the truth match what
   Claude would do anyway. Mitigations: Philip's countersignature, a human reviewer, and hidden
   checks written from the truth rather than from any arm.
2. **The writer knows Kalyth.** The writer knows the analyzer's coverage and read the recorded A1.
   Mitigations: scenario (a) was chosen against stated criteria before any Kalyth run, its
   coverage gaps are stated, not avoided, and the truth comes from code.
3. **(b) is in-sample.** The analyzer was developed on the template, and the demo recordings exist
   for exactly this request. Treat (b) as a check of the full flow, not of generalisation.
4. **Small samples and nondeterminism.** At most 3 runs per arm and scenario, and the agent's
   output varies from run to run. Claude Code and model updates during the window could shift
   results, so the version is pinned and recorded.
5. **The arms differ in more than context.** K adds a claim-and-report process and MCP calls,
   which use turns. R's prompt is longer. Equal turn and time limits may cut one arm shorter than
   another. Both are visible in M6.
6. **Leakage.** The agent's training data may include both repositories; this helps every arm.
   Web tools are denied, so no arm can look up an upstream fix, and clones hold no later history.
   AutoGen's `.github/copilot-instructions.md` tells agents to install .NET and run network
   commands. It is untrusted data, and the settings deny those commands in every arm.
7. **Truth errors.** A missed or wrong element biases recall against arms that did it right. The
   reviewer's "justified extra" class and the errata process (section 5) surface these.
8. **The hidden checks can be buggy.** They are validated on the base commit, which shows only
   that they fail where they should. On the full variant, a reference implementation by the
   preparing session (about 2 pp more) would also show that they pass where they should.
9. **Imperfect blinding** (section 7), and **one reviewer**: review minutes and merge ratings are
   subjective.
10. **AutoGen Studio is in maintenance mode** and has no route tests. Arms must write the first
    ones, which favours arms that write tests well, equally across arms.
11. **Windows and permission friction.** Earlier runs lost commits to don't-ask refusals of
    heredocs. Every arm gets the same commit note: write the message to a file and use
    `git commit -F`.

## 10. What counts as Kalyth not helping

For each scenario, B is the better of arms P and R by mean element recall (M1b), with ties broken
by hidden-check pass rate (M4). Then:

- **Kalyth helped:**
  - K's element recall is at least 0.10 above B's;
  - its pass rate is no more than 0.05 below B's;
  - its harmful or unnecessary out-of-scope changes (M3) and wrong or unsupported claims (M2) are
    not higher than B's by more than 1 per run on average.
- **Kalyth hurt:**
  - K's recall or pass rate is 0.10 or more below B's; or
  - its harmful or unnecessary changes or its wrong claims are higher by 2 or more per run.
- **Kalyth did not help:** neither K's recall nor its pass rate exceeds B's by 0.10, and it did
  not hurt. A gain that costs at least 1.5 times B's tokens is reported with that cost beside it.
- **The overall result.** It is read from scenario (a), the unseen repository: if Kalyth did not
  help or hurt there, the overall result is that Kalyth did not help, whatever (b) shows. Scenario
  (b) is reported beside it as the in-sample result.
- **The small variant.** It uses the same rules on single runs and is labelled anecdotal.
  Differences of fewer than 2 element units or 2 hidden checks count as no difference.

The report lists every number, including the runs that make Kalyth look worse, and states the
threats above that apply. It labels results from single runs as anecdotal, and keeps facts read
from the source apart from those a check showed at run time. For arm K it reports the person's
time (decision, package, task and per-run setup) beside the agent's. The coordinating session
files it in the Drive queue under KAL-20261024-048.

## 11. Decisions for Philip before any run

- **D1. Scenario (a).** Accept AutoGen Studio, which is maintained but not actively developed, or
  authorise a fourth clone to find an actively developed alternative.
- **D2. The truth.** ChatGPT reviewed version 1 (KAL-20261025-051). Approve version 2 (hash in
  section 5), or ask for version 3. This must happen before any run.
- **D3. Usage, variant and model.**
  - The share of weekly usage: small, about 6 pp, this week; or full, about 40 pp, after the
    30 October reset; or medium.
  - The model: Opus 5.5, or Sonnet 5.5 for lower usage, the same for every arm.
- **D4. Running third-party code**, outside Kalyth's static analysis:
  - installing AutoGen Studio's dependencies into a disposable environment, and running its tests
    and the hidden checks;
  - running the template's tests and migrations against a PostgreSQL 17 container in Docker;
  - whether the agents may run tests themselves (equal across arms), or only static checks with
    the scorer running the tests. Recommended: tests on SQLite for (a); static checks only for
    (b), as in the demo.
- **D5. The blind reviewer:** Philip (recommended), ChatGPT, or a Claude session with spot checks.
- **D6. The arm-K decisions.** For (a), state the decision as written in the truth's `decision`
  block. For (b), accept A1 in the UI yourself with the answers in the notes. Kalyth accepts
  decisions only from people.
- **D7. Timing:** before the 29 October submission (small variant only), or after it.
