import { createServer } from 'node:net'
import { ContextCompiler } from '@kalyth/context'
import { type Caller, canonicalJson } from '@kalyth/contracts'
import { ensureLocalOwner, KalythServices, SqliteStore } from '@kalyth/core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHttpApp } from '../src/http/app.ts'

const SESSION = 'session-token-for-handoff-tests-000'
const stated = { basis: 'stated' }

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

let app: FastifyInstance | undefined
const clients: Client[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await app?.close()
})

async function start() {
  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner = ensureLocalOwner(services)
  const port = await freePort()
  const host = `127.0.0.1:${port}`
  app = buildHttpApp(
    services,
    { token: SESSION, principalId: owner.id, allowedHosts: [host] },
    { context: new ContextCompiler({ services }) },
  )
  await app.listen({ host: '127.0.0.1', port })
  const base = `http://${host}`
  const http = async (method: string, path: string, body?: unknown, token = SESSION) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }
  }
  const agentClient = async (token: string) => {
    const client = new Client({ name: 'kalyth-handoff-test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    clients.push(client)
    return client
  }
  return { services, owner, base, http, agentClient }
}

/** A person's side, through the UI's HTTP API: model, decision, acceptance. */
async function decided(h: Awaited<ReturnType<typeof start>>) {
  const projectId = (await h.http('POST', '/api/v1/projects', { name: 'Handoff' })).body
    .id as string
  const commit = async (ops: unknown[]) => {
    const head = (await h.http('GET', `/api/v1/projects/${projectId}`)).body.project.headRevision
    const p = await h.http('POST', `/api/v1/projects/${projectId}/proposals`, {
      baseRevision: head,
      rationale: 'test',
      ops,
    })
    expect(p.status).toBe(201)
    const c = await h.http('POST', `/api/v1/proposals/${p.body.proposalId}/commit`)
    expect(c.status).toBe(200)
    return c.body.revision as number
  }
  await commit([
    {
      op: 'createObject',
      ref: '$m',
      type: 'software.Module',
      stance: 'asIs',
      attributes: { path: 'app/models.py' },
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$e',
      type: 'software.DataEntity',
      stance: 'asIs',
      attributes: { name: 'Item' },
      claim: stated,
    },
    { op: 'createRelation', type: 'contains', from: '$m', to: '$e', stance: 'asIs', claim: stated },
    {
      op: 'createObject',
      ref: '$d',
      type: 'core.Decision',
      stance: 'toBe',
      attributes: { title: 'Tenancy', question: 'How?' },
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$a',
      type: 'core.Alternative',
      stance: 'toBe',
      attributes: { title: 'Row level', summary: 'tenant_id' },
      claim: stated,
    },
    {
      op: 'createRelation',
      type: 'alternativeOf',
      from: '$a',
      to: '$d',
      stance: 'toBe',
      claim: stated,
    },
    {
      op: 'createRelation',
      type: 'impacts',
      from: '$a',
      to: '$e',
      stance: 'toBe',
      properties: { change: 'add tenant_id' },
      claim: stated,
    },
  ])
  const decision = (await h.http('GET', `/api/v1/projects/${projectId}/decisions`)).body
    .decisions[0]
  const revision = await commit([
    { op: 'setDecisionStatus', id: decision.id, status: 'accepted', rationale: 'simplest' },
    {
      op: 'setDecisionStatus',
      id: decision.alternatives[0].id,
      status: 'accepted',
      rationale: 'simplest',
    },
  ])
  return { projectId, decisionId: decision.id as string, revision }
}

describe('MCP over Streamable HTTP with agent tokens (ADR 0011)', () => {
  it('keeps the two credentials apart and rejects missing, revoked and malformed tokens', async () => {
    const h = await start()
    const { projectId } = await decided(h)
    const issued = await h.http('POST', `/api/v1/projects/${projectId}/agent-tokens`, {
      label: 'test agent',
    })
    expect(issued.status).toBe(201)
    const token = issued.body.token as string
    expect(token).toMatch(/^kalyth_at_/)

    const mcpPost = (authorization?: string) =>
      fetch(`${h.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
    expect((await mcpPost()).status).toBe(401)
    expect((await mcpPost(`Bearer ${SESSION}`)).status).toBe(401)
    expect((await mcpPost(`Bearer ${token}x`)).status).toBe(401)
    expect((await h.http('GET', '/api/v1/projects', undefined, token)).status).toBe(401)

    const listed = await h.http('GET', `/api/v1/projects/${projectId}/agent-tokens`)
    expect(JSON.stringify(listed.body)).not.toContain(token)
    await h.http('POST', `/api/v1/agent-tokens/${issued.body.summary.id}/revoke`)
    expect((await mcpPost(`Bearer ${token}`)).status).toBe(401)
  })

  it('round trip: a person accepts, an agent reads the package and proposes, the person commits', async () => {
    const h = await start()
    const { projectId, decisionId, revision } = await decided(h)
    const compiled = await h.http('POST', `/api/v1/projects/${projectId}/context`, {
      focus: [decisionId],
      task: { title: 'Add tenancy', acceptanceCriteria: ['Items are scoped to a tenant'] },
    })
    expect(compiled.status).toBe(201)
    const pkg = compiled.body.package
    expect(pkg.revision).toBe(revision)

    const token = (
      await h.http('POST', `/api/v1/projects/${projectId}/agent-tokens`, { label: 'agent' })
    ).body
    const client = await h.agentClient(token.token)
    const tools = (await client.listTools()).tools.map((t) => t.name)
    expect(tools).toEqual(
      expect.arrayContaining([
        'get_context_package',
        'compile_context_package',
        'list_decisions',
        'propose_change',
      ]),
    )
    expect(tools.filter((t) => /commit|accept|decide|token/.test(t))).toEqual([])

    const read = (await client.callTool({
      name: 'get_context_package',
      arguments: { packageId: pkg.id },
    })) as {
      structuredContent?: Record<string, any>
    }
    expect(canonicalJson(read.structuredContent?.package)).toBe(canonicalJson(pkg))
    expect(read.structuredContent?.callerScopes).toEqual([
      'project.read',
      'proposal.create',
      'task.work',
    ])
    const resource = await client.readResource({ uri: `kalyth://context/${pkg.id}` })
    expect((resource.contents[0] as { text: string }).text).toBe(canonicalJson(pkg))

    const proposed = (await client.callTool({
      name: 'propose_change',
      arguments: {
        projectId,
        baseRevision: pkg.revision,
        rationale: `Implements ${pkg.id}`,
        contextPackageId: pkg.id,
        ops: [
          {
            op: 'createObject',
            type: 'core.Requirement',
            stance: 'toBe',
            attributes: {
              title: 'Tenant scoping',
              statement: 'Every item query filters by tenant_id.',
            },
            claim: { basis: 'stated' },
          },
        ],
      },
    })) as { structuredContent?: Record<string, any> }
    const proposalId = proposed.structuredContent?.proposalId as string
    const proposal = await h.http('GET', `/api/v1/proposals/${proposalId}`)
    expect(proposal.body).toMatchObject({
      status: 'pending',
      origin: 'agent',
      proposedBy: token.summary.principalId,
      baseRevision: pkg.revision,
      contextPackageId: pkg.id,
    })
    const listed = (await client.callTool({
      name: 'list_context_packages',
      arguments: { projectId },
    })) as { structuredContent?: { packages: { id: string; revision: number }[] } }
    expect(listed.structuredContent?.packages.map((p) => [p.id, p.revision])).toEqual([
      [pkg.id, pkg.revision],
    ])
    const unknown = (await client.callTool({
      name: 'propose_change',
      arguments: {
        projectId,
        baseRevision: pkg.revision,
        rationale: 'names a package that does not exist',
        contextPackageId: `ctx_${'0'.repeat(32)}`,
        ops: [
          {
            op: 'createObject',
            type: 'core.Assertion',
            stance: 'asIs',
            attributes: { statement: 'x' },
            claim: { basis: 'stated' },
          },
        ],
      },
    })) as { isError?: boolean; structuredContent?: { error?: { issues: { code: string }[] } } }
    expect(unknown.isError).toBe(true)
    expect(unknown.structuredContent?.error?.issues[0]?.code).toBe('context.package_not_found')
    const committed = await h.http('POST', `/api/v1/proposals/${proposalId}/commit`)
    expect(committed.body).toMatchObject({
      status: 'committed',
      revision: pkg.revision + 1,
      rebasedFrom: null,
    })
  })

  it('confines an agent to its own project', async () => {
    const h = await start()
    const { projectId } = await decided(h)
    const other = (await h.http('POST', '/api/v1/projects', { name: 'Other' })).body.id as string
    const token = (
      await h.http('POST', `/api/v1/projects/${other}/agent-tokens`, { label: 'elsewhere' })
    ).body
    const client = await h.agentClient(token.token)
    const listed = (await client.callTool({ name: 'list_projects', arguments: {} })) as {
      structuredContent?: { projects: { id: string }[] }
    }
    expect(listed.structuredContent?.projects.map((p) => p.id)).toEqual([other])
    const denied = (await client.callTool({
      name: 'get_project_overview',
      arguments: { projectId },
    })) as {
      isError?: boolean
      structuredContent?: { error?: { code: string } }
    }
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent?.error?.code).toBe('unauthorized')
  })
})

describe('agent token management over HTTP', () => {
  it('is for the owner in the UI only', async () => {
    const h = await start()
    const { projectId } = await decided(h)
    const bad = await h.http('POST', `/api/v1/projects/${projectId}/agent-tokens`, { label: '' })
    expect(bad.status).toBe(422)
    const caller: Caller = { principalId: h.owner.id, origin: 'agent' }
    expect(h.services.issueAgentToken(caller, { projectId, label: 'x' }).ok).toBe(false)
  })
})
