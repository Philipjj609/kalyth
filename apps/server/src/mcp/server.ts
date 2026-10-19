import { CONTRACTS_VERSION, canonicalJson } from '@kalyth/contracts'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { advertisedSchema, callTool, type McpDeps, TOOLS, toToolResult } from './tools.ts'

const INSTRUCTIONS = `Kalyth holds a persistent, evidence-backed engineering model of this project.
Read before you change: query objects, relations and evidence at a revision.
Every record has a claim basis: observed (a tool saw it in pinned source, within stated coverage),
inferred (a hypothesis), stated or imported. Observed is not runtime verification.
When a person hands you a task, read its context package (get_context_package) first and follow
everything under "mandatory". Propose changes against the package revision.
You can propose changes; a person reviews and commits them in Kalyth. Decisions are accepted only by people.
For tasks: claim_task, read the context package it returns, commit with the Kalyth-Task trailer, then
submit_execution_report. Kalyth checks the commit against git; a person completes the task.`

/**
 * Builds an MCP server bound to one principal. Every request runs as that principal with origin
 * "agent": text arriving over MCP never carries a person's direct authority.
 */
export function createKalythMcpServer(deps: McpDeps, principalId: string): McpServer {
  const server = new McpServer(
    { name: 'kalyth', version: CONTRACTS_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  )
  const caller = { principalId, origin: 'agent' as const }
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Advertised to clients as the tool's JSON Schema; checked in callTool, so invalid input
        // is answered in Kalyth's error envelope rather than the SDK's plain text.
        inputSchema: advertisedSchema(tool.input),
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown) => toToolResult(callTool(tool, deps, caller, input)),
    )
  }
  server.registerResource(
    'context-package',
    new ResourceTemplate('kalyth://context/{packageId}', { list: undefined }),
    {
      title: 'Context package',
      description: 'An immutable, content-addressed context package (ADR 0011).',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const packageId = String(variables.packageId ?? '')
      const result = deps.context.get(caller, { packageId })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: canonicalJson(result.value.package),
          },
        ],
      }
    },
  )
  return server
}
