# 0013. Tasks, leases and execution reports verified against git

Date: 2026-10-17. Status: accepted, pending review of the commit-policy addition. Tier B; builds on
ADRs 0006 and 0011 and the Phase 0 review (section 6.4).

## Context

After a decision, the work is done by coding agents outside Kalyth. Kalyth must:

- know who is working on what;
- stop two agents from taking the same task;
- recover when an agent disappears mid-task;
- refuse to treat an agent's "done" as done until the repository shows the work.

None of this may give agents authority over the engineering model, or let them accept their own
work.

## Decision

**Tasks are kernel records.** `core.Task` has a title, a description, acceptance criteria,
optionally the context package and base commit it starts from, a status and a lease.

- Status and lease change only through the operation `setTaskStatus`, so every transition is a
  revision with history and replay.
- `implements` links a task to the decision, alternative or requirement it carries out.
- `requires` links it to tasks or decisions that must come first. `requires` is acyclic.

**The kernel enforces the transitions:**

| From | To |
|---|---|
| `proposed` | `ready`, `cancelled` |
| `ready` | `running`, `blocked`, `cancelled` |
| `running` | `running` (renewed lease), `review`, `failed`, `unknown_outcome`, `ready`, `blocked` |
| `unknown_outcome` | `review`, `ready`, `failed`, `cancelled` |
| `review` | `completed`, `ready`, `failed` |
| `blocked` | `ready`, `cancelled` |
| `failed` | `ready`, `cancelled` |

`completed` and `cancelled` are final.

- `running` carries a lease: id, holder and expiry.
- The lease is kept on `unknown_outcome`, so the last holder can still report, and is cleared
  everywhere else.
- Phase 0's separate `leased` state is folded into `running` with its lease.

**The coordinator** (`packages/tasks`) serves agents. Agents need the new scope `task.work`, which
agent tokens and the local stdio agent now include.

- **Claim.** A task is claimable when it is `ready`, or `running` with an expired lease, or
  `unknown_outcome`. Everything it `requires` must be completed or accepted.
  - An expired lease first becomes `unknown_outcome`.
  - Before a retry, Kalyth searches the task repository for commits carrying the trailer
    `Kalyth-Task: <task id>`. If one exists, the claim is refused: the previous holder may have
    finished, and a report or a person must settle it.
  - The claim returns a lease and a context package for the task.
- **Renew or release.** Only the lease holder can renew or release the lease.
- **Report.**
  - An execution report has an idempotency key, an outcome, a summary, the commit, the files
    changed and the tests run. It is stored as `core.ExecutionReport` with basis `stated`.
  - Kalyth then verifies the commit read-only against the project's task repository: it exists, its
    message has the task trailer, its files changed against the first parent equal the files
    reported, and it descends from the task's base commit when one is set.
  - The result is a `core.Verification` with basis `observed`, from the tool
    `kalyth-git-verifier`, and states its coverage. Tests are reported, never run, so they stay
    stated.
  - A passing verification moves the task to `review`. A failed outcome moves it to `failed`.
    Otherwise it stays `running` with the checks that failed.
  - Only a person moves `review` to `completed`. A tool's success is not taken as the task's.

**Commit policy addition (needs review).** A new tool principal, the task coordinator, holds
`task.coordinate`.

- **What it may commit:** only
  - `setTaskStatus` to `running`, `review`, `failed`, `unknown_outcome` or `ready`;
  - new `core.ExecutionReport` and `core.Verification` records;
  - their `reports` and `verifies` relations;
  - evidence.
- **How:** the agent's request becomes a proposal by the agent, and the coordinator commits it
  after its own checks.
- **What stays with people:** agents still cannot commit anything else. `completed` and
  `cancelled`, like decision status, need a person.

**The task repository** is the local git repository where agents commit their work. A person
registers one per project. Kalyth only reads it, with the same plumbing rules as the analyzer.

## Alternatives

- **Leases as operational records outside the kernel.** They would be lighter, but then who held a
  task and when would be missing from history, and replay would not reproduce it.
- **Letting agents mark tasks complete.** Rejected. The point of the design is that the repository,
  then a person, confirm the work.
- **Running the reported tests.** Rejected for version 1, because Kalyth never runs analysed code.
  Test results are recorded as stated claims.

## Consequences

- An agent that crashes mid-task leaves an expired lease. The next claim finds out from git whether
  the work landed, and refuses a duplicate run if it might have.
- The kernel gains one operation, two object types and three relation types. The web UI's operation list and the authorisation
  rules are updated with them.

## Amendment, 2026-10-19

A test of the handoff on 2026-10-19 (an agent claims a task over MCP, commits with the trailer,
reports, and Kalyth checks the report) showed that one commit is not the unit of work, and that a
commit can pass verification while git may still lose it. The verifier, `kalyth-git-verifier`
0.2.0, and the coordinator change as follows. No task state is added.

**Verification over the work.**

- When the task has a base commit, the work is the range from the base to the reported commit.
  The files changed are the net difference between the base tree and the commit tree, so work done
  in several commits, a fix-up included, is reported as one piece. A report that names only a
  fix-up's files fails and lists the files it left out.
- The reported commit must still descend from the base. When it does not, files and commits are
  read from their merge base, so the verdict says what differs, and the descent check fails.
- The trailer is still required on the reported commit, and only there.
- The verdict lists the commits in the range, newest first, as the check `commits in range`. At
  most 500 are read.
- Without a base, the files are the commit's own against its first parent, as before.
- Reported paths are normalised (separators, `./`, empty segments) and stored that way, so what
  people see is what was compared.

**Reachability.** A new check, `on a branch or tag`, fails unless a branch or tag (`refs/heads/`,
`refs/tags/`) contains the commit. A commit on no ref passes `commit exists` today and can be
removed by garbage collection tomorrow.

**Coverage.** The coverage recorded with each verification states exactly what the checks read,
and what they do not: tests are reported and never run; what the changes do, trailers on other
commits in the range, who wrote the commits, whether the files are within the task's scope and
whether the commit was pushed are not checked.

**Reading the task repository.** `packages/tasks` reads it through its own reader, under the
analyzer's plumbing rules: shas are validated as 40 hex before they reach git, refs follow
`--end-of-options`, and only `rev-parse`, `cat-file`, `merge-base`, `diff-tree`, `rev-list` and
`for-each-ref` run. Each check's detail is one line, with control and bidirectional characters
escaped and its length bounded, so a hostile path or ref name cannot add a line to the stored
summary or push it past its limit.

**Reports and retries.**

- A report on a task that is not `running` or `unknown_outcome` is refused as `conflicting`, with
  the task's state ("the task is in review: ..."), before any lease is compared. Renewing and
  releasing are refused the same way.
- A retry with the same idempotency key returns the original verdict and its checks, read back
  from the stored verification summary.

**The MCP error shape.** Input that does not match an MCP tool's schema is answered in Kalyth's
envelope, `{ error: { code: "invalid", message, issues } }`, with each zod issue as
`schema.<code>`, like every other failure. Tools still advertise their zod schemas as JSON Schema;
the same schema is checked in the handler instead of by the SDK, so nothing reaches a service
unparsed. The existing code `invalid` is used; no error code is added.

**Lease expiry at read time.** The task read model computes `leaseExpired` when a task is read,
from the lease's expiry and the current time, and returns it over HTTP and MCP; nothing is
written. The task stays `running` until the next claim moves it to `unknown_outcome` and checks
git. The web app's task view now says plainly that the lease has expired and that the next claim
checks git for a commit first.

## Amendment, 2026-10-20

Two rules change for reconciliation (ADR 0024, proposed). The transition table does not.

**Recorded findings.** When a claim finds commits that carry the task trailer, it is still
refused, and the coordinator now records them on the task as its `finding` (at most 5, newest
first).

- `setTaskStatus` may carry a finding, only with `unknown_outcome`. On an expired lease the claim
  records it with the move to `unknown_outcome`. On a task already in `unknown_outcome` the kernel
  accepts `unknown_outcome` again only to record a newer finding; that is not a transition, and the
  lease is kept. The same finding is not recorded twice.
- The kernel keeps the finding while the task stays in `unknown_outcome` and clears it when the
  task leaves that state. `finding` is a reserved attribute of `core.Task`: it starts absent and
  `updateObject` cannot change it.
- Only the task coordinator, a tool principal with `task.coordinate`, may commit a finding, because
  it says what git showed. A person's proposal that carries one is refused.

**Reports a person files.** Besides the lease holder, a person acting directly with
`proposal.create` and `proposal.commit` may report on a task that is `ready`, `running` with an
expired lease, or `unknown_outcome` (HTTP `POST /tasks/:id/reports`). The report names a commit and
the files changed, records `filedBy` instead of a lease, is verified by the same verifier and
committed by the coordinator. A pass moves the task to `review`; from `ready` the person first
takes the task with a short lease of their own, as a claim would. A failing verdict changes no
status. Agents still report only under their lease, over MCP.
