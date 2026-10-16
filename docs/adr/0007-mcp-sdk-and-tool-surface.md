# 0007. MCP SDK v2 and the version 1 tool surface

Date: 2026-10-16. Status: accepted, based on the local compatibility spike of the same date.

## Context

The MCP specification revision 2026-07-28 replaced the initialize handshake. SDK v2
(`@modelcontextprotocol/server` 2.3.1, Apache-2.0) implements it; SDK v1 (`@modelcontextprotocol/sdk`
1.32.1, MIT) covers revisions up to 2025-11-25. We needed to know what the installed agents speak.

Spike results (no model calls): Claude Code 2.1.263 connects with protocol 2025-11-25 and Codex
0.153.4 with 2025-06-18, both through the classic initialize handshake. A v2 server serves both
through its default legacy mode, as does a v1 server.

## Decision

Use SDK v2 with its default legacy handshake support. Tools are registered with zod 4 schemas from
`packages/contracts`. The stdio entry point is `apps/server/src/mcp/stdio.ts`.

Version 1 tools: `list_projects`, `get_project_overview`, `describe_types`, `query_objects`,
`query_relations`, `get_evidence`, `get_history`, `propose_change`, `get_proposal`,
`list_proposals`. There is deliberately no commit, accept or grant tool. Results return the service
value as structured content plus canonical JSON text; failures return the shared error envelope with
`isError`.

## Consequences

A regression test sends raw initialize handshakes at 2025-06-18 and 2025-11-25 to the stdio server.
A parity test checks that MCP and HTTP return identical canonical JSON for the same queries. Output
schemas for tools, Streamable HTTP for remote clients, and MCP resources for immutable context
packages come with the handoff gate.
