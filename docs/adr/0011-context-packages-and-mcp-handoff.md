# 0011. Context packages, agent tokens and the MCP handoff

Date: 2026-10-17. Status: accepted. Gate G5; builds on ADRs 0006, 0007, 0009 and 0010.

## Context

A coding agent that picks up an accepted decision needs the right part of the model, at a known
revision, with each item's basis and freshness. Some content must always reach it whatever the
budget: invariants, constraints, the decision itself. The agent must know what was left out and how
to fetch it. It must be able to propose changes and nothing more. The handoff must also work when
the agent is not on this machine's stdio, including the hosted demo.

## Decision

**Context packages** are compiled deterministically by `packages/context`, which reads through the
services like the Navigator. The input is one or more focus elements, an optional task with
acceptance criteria, and a size limit in characters.

When the focus is a decision, it expands to the decision's accepted alternative and the elements
that alternative `impacts`. When the focus is an alternative, it expands to the elements it
`impacts`.

A package has two parts:

- **The mandatory set**, never truncated:
  - project-wide constraints;
  - constraints linked by `constrains` to a focus element;
  - accepted decisions about the focus, with their accepted alternatives and direct changes;
  - the task's acceptance criteria;
  - the agent policy: agents read and propose, and people commit and decide.
- **Optional items**, ranked by typed distance, cut at the limit with an explicit omissions list:
  - the focus elements with their pinned excerpts;
  - elements on the propagated impact path, each with its typed path;
  - the focus elements' direct dependencies;
  - open questions about the focus.

Every item carries its stance, claim basis, confidence where inferred, and freshness at the
package's revision. The package also records the source snapshots and lists MCP calls for fetching
omitted detail.

If the mandatory set alone exceeds the limit, the package is `blocked` with `context_overflow` and a
suggested split of the focus by container.

The package body contains no timestamps or caller-specific data. Its id is `ctx_` plus the first 32
hex digits of the SHA-256 of its canonical JSON, so the same request at the same revision gives the
same id. Packages are stored as immutable operational records outside the event log, and can be read
again by id or as the MCP resource `kalyth://context/{id}`.

**Decisions read model.** `listDecisions` returns decisions with their status, their alternatives
and each alternative's direct changes. Agents use it to find accepted decisions to work from.

**Agent tokens.** A person acting directly, with `grant.manage`, issues a token for one project. The
token's agent principal has `project.read` and `proposal.create` only, and a required expiry of up
to 30 days. Each token is shown once and stored as a SHA-256 hash; it can be listed and revoked.
Tokens look like `kalyth_at_...`, so secret scanners and Kalyth's own excerpt screening recognise
them. Storing them is schema version 2.

**MCP over Streamable HTTP.** `/mcp` on the local server serves the same tool catalogue as stdio
through the SDK's `createMcpHandler`. That handler speaks the 2026-07-28 revision and answers
2025-era clients statelessly.

- Each request needs a valid agent token.
- The UI session token is not accepted there.
- Agent tokens are not accepted on `/api/`.
- The Host and Origin checks apply as for the API.

Every MCP request runs as the token's principal with origin `agent`.

## Alternatives

- **Truncating everything to fit.** Rejected: an agent that silently loses a constraint is worse
  than one that is told to split the task.
- **Per-caller packages.** Rejected: the permission summary would change the content address.
  Callers get their scopes beside the package, not inside it.
- **OAuth 2.1 for remote MCP.** The specification's route, but post-hackathon work. Static,
  scoped, expiring bearer tokens are the version 1 control.
- **Tasks, leases and execution reports verified against git.** These are Tier B and follow if
  Tier A is on schedule on 24 October.

## Consequences

- Agents get a stable, citable package: they propose against its revision, and the kernel reports a
  stale proposal if the head moved.
- The local server now accepts a second kind of credential. Tests cover each boundary: no token,
  an expired or revoked token, an agent token on `/api/`, the session token on `/mcp`, and an agent
  attempting to commit.

## Amendment, 2026-10-17

A proposal may name the context package it answers (`contextPackageId`; schema version 3). The HTTP
and MCP adapters check that the package exists and belongs to the proposal's project before the
proposal is stored, and the Handoff view lists the proposals that name the package first.
Packages compiled for a project can be listed (HTTP `GET /projects/:id/context`, MCP
`list_context_packages`).
