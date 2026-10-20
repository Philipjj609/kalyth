# 0024. Reconciliation after an agent's work

Date: 2026-10-20. Status: Proposed (technical lead review). Builds on ADRs 0011, 0013, 0022 and
0023; part of the direction in ADR 0020 (the "agent report" and "reconcile" stages).

## Context

An agent claims a task, commits with the trailer `Kalyth-Task: <id>` and reports, and Kalyth
verifies the report against git (ADR 0013). After that nothing reconciled the model:

- a person could not file a report, for example for work done outside an agent session;
- a commit git revealed on a re-claim was told only to the agent that tried to claim;
- there was no text to give an external agent to start a task;
- completing a task did not bring what the code now does back into the model.

ADR 0023 keeps decision acceptance, implementation, verification and freshness as separate
facets. Reconciliation must add to them without merging them into one "implemented" state.

## Decision

**A prompt for agents.** The task read model (HTTP `GET /tasks/:id`, MCP `get_task` and
`list_tasks`) carries `agentPrompt`, the text a person pastes into Claude Code or Codex:

- the task id and title, and to use the Kalyth MCP tools;
- call `claim_task` and read the context package with `get_context_package`;
- branch from the task base commit, or work in one commit when there is none;
- change only what the acceptance criteria allow, listed;
- end every commit message with the trailer;
- report with `submit_execution_report`: the lease, the last commit, the files changed and the
  tests run, saying plainly what was not run.

It is computed from the task alone, so it is deterministic. It names tools and never holds a token:
the agent connects with its own credential. The title and criteria are put on one line each with
control and bidirectional characters escaped, so a title cannot add instructions on lines of its
own, and text that matches Kalyth's secret patterns is withheld. The brief named the report tool
`report_task_result`; the prompt names the tool that exists, `submit_execution_report`.

A context package compiled for a task (`task` set) carries a task policy in `mandatory.policy`:
claim, renew, branch from the base, stay within the criteria, use the trailer, report, and propose
model changes only when a person asks. It replaces the generic `propose_change` line. Package
bodies are content-addressed, so these packages get new ids; stored packages are unchanged.

**A person files a report.** `POST /tasks/:id/reports`, for a person acting directly with
`proposal.create` and `proposal.commit`, the scopes a person needs to move a task through a
committed proposal.

- The task must be `ready`, `running` with an expired lease, or `unknown_outcome`.
- The input names a commit (required), the files changed (at least one), a summary, an outcome
  (`succeeded` or `partial`; a failure is recorded with a status change instead) and an
  idempotency key.
- It is verified against git exactly like an agent's report, by the same verifier, and committed
  by the task coordinator. The report's basis is `stated`, proposed by that person, and it records
  `filedBy` instead of a lease.
- A pass moves the task to `review`. The kernel moves a task to review only from `running` or
  `unknown_outcome`, so from `ready` the person first takes the task with a short lease of their
  own, as a claim would, and the review ends it. The transition table is unchanged.
- A failing verdict is recorded and changes no status.

**What git reveals is recorded.** When a claim finds commits that carry the trailer, the task
coordinator records them on the task as its finding (ADR 0013, amendment of 2026-10-20). The task
detail names the commit and offers to review it as a person's report, prefilled with it. Marking
the task ready, failing or cancelling it says that this discards the finding.

**Reconciliation.** `POST /tasks/:id/reconcile`, for a person acting directly with the same
scopes, once the task is in `review` or `completed` with a report git verified.

1. It takes the commit of the latest report whose verification passed.
2. It finds which repository of the model the task repository is: the source snapshot whose commit
   the task repository holds. A model with no snapshot gets one named after the folder, as
   `pnpm ingest` names a local path. A task repository that holds none of the snapshots' commits
   is refused, so a model built from another repository is not mixed with this one.
3. The analyzer re-analyses the task repository at that commit with `ingestRepository`, as its own
   principal (`ingest.observed`), read-only, and its observed proposal is committed as ingest
   commits it. When the model already reflects a later commit that contains the task's commit,
   the analysis is skipped, so the snapshot does not move back.
4. For each decision the task implements (a decision counts its accepted alternatives, or all of
   them while none is; an alternative counts itself):
   - each direct change (`impacts`) is *touched* when a file its target's evidence cites is among
     the verified files changed;
   - each proposed (to-be) element the changes name, or that contains one of them (ADR 0022), is
     matched with an active observed as-is element of the same type and name, compared without
     case, or for an endpoint the same method and path, ignoring a trailing slash.
5. For each match without a `realizes` link, a new principal, the reconciler (`project.read`,
   `proposal.create` only), proposes `realizes` from the observed element to the proposed one:
   basis `inferred`, method `kalyth.reconcile`, confidence `high` when the commit changed the files
   the observed element's evidence cites and `medium` otherwise, derived from both elements. A
   person commits or rejects it. A pending or rejected earlier proposal for the same pair is
   reported instead of proposing again.

The result reports the analysis, the touched changes and, for each proposed element, its match and
link state (`committed`, `pending` or `rejected`). The task detail shows it, with the pending
links linked to Proposals. Nothing here accepts a decision, completes a task or changes a facet by
itself. The hosted demo refuses reconciliation, like repository registration, because it reads a
path on the server.

**Implementation facet detail.** `decisionFacets` adds `touched` and `changes` to
`implementation`: how many of the direct changes considered (as for freshness) the verified
reports touched, computed on read from the files changed of each task's latest report that passed
verification and each change target's evidence paths. Both fields are optional in the contract, so
earlier results still parse; Kalyth always sets them.

## Alternatives

- **Marking the decision implemented when the task completes.** Rejected again (ADRs 0020, 0023):
  touching a file says the commit changed code where the target is evidenced, not that the change
  is right or complete.
- **Committing the `realizes` links automatically.** Rejected: a match by type and name is an
  inference, and the model takes no inference without a person.
- **Prefilling the files changed from git** when a person reviews a found commit. Rejected for
  now: the verifier would then compare git with itself. The verdict names any file the person
  left out.
- **Storing the finding outside the kernel**, like the task repository path. Rejected for the
  reason leases are kernel records: what git showed, and when, would be missing from history.
- **Adding `ready → review` to the transition table** for a person's report. It would be simpler,
  but the table is mirrored in the web app and would let a person skip the lease a claim takes.

## Consequences

- Contracts gain `agentPrompt`, `finding` and `filedBy` on the task read model, `FileReportInput`,
  `ReconcileTaskInput`, `ReconcileResult`, and `implementation.touched` and `changes` on the
  decision facets. All are additive and optional where earlier results or clients exist.
- `core.ExecutionReport` gains an optional `filedBy`, and its `leaseId` becomes optional. Both stay
  version 1: every earlier version is valid as it stands.
- Two tool principals appear in a store when first used: the analyzer (already used by
  `pnpm ingest`) and the reconciler.
- Reconciling at a commit on another line of history than the one the model reflects moves the
  snapshot to that commit. Ingest the main line again after merging.
- The two web requests live in `apps/web/src/tasks` while the shared client is redesigned; they
  can move to `apps/web/src/api` afterwards.
