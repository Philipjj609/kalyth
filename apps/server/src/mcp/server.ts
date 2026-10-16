import { CONTRACTS_VERSION } from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import { McpServer } from '@modelcontextprotocol/server'
import { TOOLS, toToolResult } from './tools.ts'

const INSTRUCTIONS = `Kalyth holds a persistent, evidence-backed engineering model of this project.
Read before you change: query objects, relations and evidence at a revision.
Every record has a claim basis: observed (a tool saw it in pinned source, within stated coverage),
inferred (a hypothesis), stated or imported. Observed is not runtime verification.
You can propose changes; a person reviews and commits them in Kalyth. Decisions are accepted only by people.`

/**
 * Builds an MCP server bound to one principal. Every request runs as that principal with origin
 * "agent": text arriving over MCP never carries a person's direct authority.
 */
export function createKalythMcpServer(services: KalythServices, principalId: string): McpServer {
  const server = new McpServer(
    { name: 'kalyth', version: CONTRACTS_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )
  const caller = { principalId, origin: 'agent' as const }
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown) => toToolResult(tool.run(services, caller, input)),
    )
  }
  return server
}
