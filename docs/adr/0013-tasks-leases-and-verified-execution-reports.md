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
