# 0006. Authorisation, commit policy and instruction provenance

Date: 2026-10-16. Status: accepted. Decision D4 (KAL-20261016-006), provenance rule from KAL-20261016-004.

## Context

Models and agents produce useful proposals but must never gain authority from their own text.
Decisions are accepted by people in version 1.

## Decision

- Principals have a kind (human, agent, model, tool). Grants give scopes per project or globally:
  `project.read`, `project.create`, `proposal.create`, `proposal.commit`, `proposal.reject`,
  `decision.decide`, `ingest.observed`, `grant.manage`. `decision.decide` and `grant.manage` can
  only be granted to human principals.
- Every request carries an instruction origin: human, agent, model, tool or relayed. Only `human`
  means a person acted directly in a first-party interface. MCP requests are always `agent`.
- Commit policy v1: a decision status change needs a human principal with `decision.decide` acting
  with origin `human`; otherwise `proposal.commit` allows any operation; `ingest.observed` allows
  only evidence plus records whose claim basis is observed (the analyzer path).
- Change sets record who proposed, who committed and the commit origin.
- Local HTTP: loopback binding, a per-launch session token compared in constant time, and Host and
  Origin checks against DNS rebinding and cross-origin use. The token is given only to the
  first-party UI, so token requests act for the owner with origin `human`.

## Consequences

An agent with `proposal.commit` still cannot accept a decision, and a person committing on relayed
or model text cannot either (tested). Hosted mode will need real user accounts, scoped expiring
tokens and, for remote MCP, the OAuth flow from the MCP specification; that is post-hackathon unless
the demo requires it.
