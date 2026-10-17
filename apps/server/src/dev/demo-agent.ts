import { parseArgs } from 'node:util'
import type { ContextPackage } from '@kalyth/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

// A scripted stand-in for a coding agent, for rehearsing the handoff without a model. It reads a
// context package over MCP and proposes one stated constraint per acceptance criterion on the
// package's focus elements, naming the package. Its proposals say they are scripted.
//
//   KALYTH_AGENT_TOKEN=<agent token> pnpm demo:agent --package ctx_... [--url http://127.0.0.1:4317/mcp]

const { values } = parseArgs({
  options: {
    package: { type: 'string' },
    url: { type: 'string', default: 'http://127.0.0.1:4317/mcp' },
  },
})
const stop = (message: string): never => {
  process.stderr.write(`demo-agent: ${message}\n`)
  process.exit(2)
}
const token = process.env.KALYTH_AGENT_TOKEN ?? stop('set KALYTH_AGENT_TOKEN to an agent token')
const packageId = values.package ?? stop('pass --package ctx_...')

const client = new Client({ name: 'kalyth-demo-agent', version: '0.1.0' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(values.url ?? ''), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
)
try {
  const read = (await client.callTool({
    name: 'get_context_package',
    arguments: { packageId },
  })) as {
    isError?: boolean
    structuredContent?: { package?: ContextPackage; error?: { message: string } }
  }
  const pkg = read.structuredContent?.package
  if (read.isError || !pkg)
    stop(read.structuredContent?.error?.message ?? 'could not read the package')
  const p = pkg as ContextPackage
  const focus = p.items.filter((i) => i.role === 'focus').map((i) => i.id)
  const criteria =
    p.mandatory.acceptanceCriteria.length > 0
      ? p.mandatory.acceptanceCriteria
      : [`Implement: ${p.task?.title ?? 'the accepted decision'}`]
  const ops = criteria.flatMap((criterion, i) => [
    {
      op: 'createObject',
      ref: `$c${i}`,
      type: 'core.Constraint',
      stance: 'toBe',
      attributes: { title: criterion.slice(0, 120), statement: criterion, severity: 'must' },
      claim: { basis: 'stated' },
    },
    ...focus.map((id) => ({
      op: 'createRelation',
      type: 'constrains',
      from: `$c${i}`,
      to: id,
      stance: 'toBe',
      claim: { basis: 'stated' },
    })),
  ])
  const proposed = (await client.callTool({
    name: 'propose_change',
    arguments: {
      projectId: p.projectId,
      baseRevision: p.revision,
      contextPackageId: p.id,
      rationale: `Scripted rehearsal agent: constraints from the acceptance criteria of ${p.id}.`,
      ops,
    },
  })) as { isError?: boolean; structuredContent?: Record<string, unknown> }
  process.stdout.write(`${JSON.stringify(proposed.structuredContent, null, 2)}\n`)
  if (proposed.isError) process.exitCode = 1
} finally {
  await client.close()
}
