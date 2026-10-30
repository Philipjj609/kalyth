import { canonicalJson } from '@kalyth/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { TOOLS } from '../src/mcp/tools.ts'
import { harness, stated } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
afterEach(async () => h?.close())

async function seeded() {
  h = await harness()
  const project = (await h.http('POST', '/api/v1/projects', { name: 'Shared' })).body
  const proposal = await h.http('POST', `/api/v1/projects/${project.id}/proposals`, {
    baseRevision: 0,
    rationale: 'seed',
    ops: [
      {
        op: 'createObject',
        ref: '$c',
        type: 'software.Container',
        stance: 'asIs',
        attributes: { name: 'backend' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$m',
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: 'app/api/deps.py' },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$c',
        to: '$m',
        stance: 'asIs',
        claim: stated,
      },
    ],
  })
  await h.http('POST', `/api/v1/proposals/${proposal.body.proposalId}/commit`)
  return project.id as string
}

describe('MCP interface', () => {
  it('lists read and propose tools, and no commit or accept tool', async () => {
    h = await harness()
    const tools = (await h.client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual([
      'analyze_impact',
      'assess_applicability',
      'assess_freshness',
      'claim_task',
      'compile_context_package',
      'describe_types',
      'get_assessment',
      'get_context_package',
      'get_evidence',
      'get_history',
      'get_knowledge',
      'get_method',
      'get_method_run',
      'get_pin_status',
      'get_pinned_knowledge',
      'get_project_overview',
      'get_proposal',
      'get_situation',
      'get_task',
      'list_assessments',
      'list_context_packages',
      'list_decisions',
      'list_library_uses',
      'list_method_runs',
      'list_projects',
      'list_proposals',
      'list_tasks',
      'propose_change',
      'query_objects',
      'query_relations',
      'release_task',
      'renew_task_lease',
      'run_method',
      'search_knowledge',
      'submit_execution_report',
    ])
    expect(tools.some((t) => /commit|accept|decide|grant/.test(t))).toBe(false)
  })

  it('returns the same canonical JSON as the HTTP API for the same query (UI/MCP parity)', async () => {
    const pid = await seeded()
    const pairs: [string, string, Record<string, unknown>][] = [
      [`/api/v1/projects/${pid}`, 'get_project_overview', { projectId: pid }],
      [
        `/api/v1/projects/${pid}/objects?revision=1`,
        'query_objects',
        { projectId: pid, revision: 1 },
      ],
      [
        `/api/v1/projects/${pid}/relations?type=contains`,
        'query_relations',
        { projectId: pid, types: ['contains'] },
      ],
      [`/api/v1/projects/${pid}/history`, 'get_history', { projectId: pid }],
    ]
    for (const [url, tool, args] of pairs) {
      const viaHttp = await h.http('GET', url)
      const viaMcp = await h.mcp(tool, args)
      expect(viaMcp.isError).toBe(false)
      expect(canonicalJson(viaMcp.body)).toBe(canonicalJson(viaHttp.body))
    }
  })

  it('round trip: UI commit, MCP read, MCP proposal, UI review and commit, MCP sees the new revision', async () => {
    const pid = await seeded()
    const before = await h.mcp('get_project_overview', { projectId: pid })
    expect(before.body.project.headRevision).toBe(1)

    const proposed = await h.mcp('propose_change', {
      projectId: pid,
      baseRevision: 1,
      rationale: 'agent noticed a missing data entity',
      idempotencyKey: 'agent-session-7-step-3',
      ops: [
        {
          op: 'createObject',
          type: 'software.DataEntity',
          stance: 'asIs',
          attributes: { name: 'item' },
          claim: stated,
        },
      ],
    })
    expect(proposed.body.status).toBe('pending')

    const pending = await h.http('GET', `/api/v1/projects/${pid}/proposals?status=pending`)
    expect(pending.body.proposals.map((p: { id: string }) => p.id)).toEqual([
      proposed.body.proposalId,
    ])
    expect(pending.body.proposals[0]).toMatchObject({ proposedBy: h.agent.id, origin: 'agent' })

    const commit = await h.http('POST', `/api/v1/proposals/${proposed.body.proposalId}/commit`)
    expect(commit.body.revision).toBe(2)

    const after = await h.mcp('query_objects', { projectId: pid, types: ['software.DataEntity'] })
    expect(after.body).toMatchObject({ revision: 2, objects: [{ attributes: { name: 'item' } }] })
    const status = await h.mcp('get_proposal', { proposalId: proposed.body.proposalId })
    expect(status.body).toMatchObject({
      status: 'committed',
      decidedBy: h.owner.id,
      result: { revision: 2 },
    })
  })

  it('reports kernel errors with the shared envelope and isError', async () => {
    const pid = await seeded()
    const notFound = await h.mcp('get_project_overview', { projectId: `prj_${'0'.repeat(32)}` })
    expect(notFound).toMatchObject({ isError: true, body: { error: { code: 'not_found' } } })
    const ahead = await h.mcp('query_objects', { projectId: pid, revision: 99 })
    expect(ahead).toMatchObject({
      isError: true,
      body: { error: { code: 'invalid', currentRevision: 1 } },
    })
    const denied = await h.mcp('propose_change', {
      projectId: pid,
      baseRevision: 1,
      rationale: 'agent tries to decide',
      ops: [
        {
          op: 'createObject',
          type: 'core.Decision',
          stance: 'toBe',
          attributes: { title: 'T', question: 'Q', status: 'accepted' },
          claim: stated,
        },
      ],
    })
    expect(denied.body).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'attribute.reserved' }],
    })
  })

  it('answers input that fails a tool schema with the shared envelope, for every tool', async () => {
    h = await harness()
    const wrong = { projectId: 42, taskId: 42, proposalId: 42, packageId: 42, revision: -1 }
    const checked: string[] = []
    for (const tool of TOOLS) {
      const expected = tool.input.safeParse(wrong)
      if (expected.success) continue
      const res = await h.mcp(tool.name, wrong)
      expect(res.isError, tool.name).toBe(true)
      expect(res.body.error, tool.name).toMatchObject({
        code: 'invalid',
        message: expect.stringMatching(
          new RegExp(`^input does not match the ${tool.name} input schema: `),
        ),
        issues: expected.error.issues.slice(0, 20).map((i) => ({
          code: `schema.${i.code}`,
          message: i.message,
          path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
        })),
      })
      expect(res.text, tool.name).toBe(canonicalJson(res.body))
      expect(res.text, tool.name).not.toMatch(/Input validation error/)
      checked.push(tool.name)
    }
    // Every tool that takes input was exercised.
    expect(checked.sort()).toEqual(
      TOOLS.filter((t) => !['list_projects', 'describe_types'].includes(t.name))
        .map((t) => t.name)
        .sort(),
    )

    const sha = await h.mcp('submit_execution_report', {
      taskId: `obj_${'0'.repeat(32)}`,
      leaseId: `lease_${'0'.repeat(32)}`,
      idempotencyKey: 'report-0001',
      outcome: 'succeeded',
      summary: 'x',
      commit: 'HEAD',
    })
    expect(sha.body.error).toMatchObject({
      code: 'invalid',
      message:
        'input does not match the submit_execution_report input schema: commit: expected a 40-hex commit sha',
      issues: [{ code: 'schema.invalid_format', path: ['commit'] }],
    })
    const none = await h.mcp('claim_task')
    expect(none.body.error).toMatchObject({ code: 'invalid', issues: [{ path: ['taskId'] }] })
  })

  it('still advertises each tool’s input schema, as the SDK would convert it', async () => {
    h = await harness()
    const listed = new Map((await h.client.listTools()).tools.map((t) => [t.name, t.inputSchema]))
    for (const tool of TOOLS) {
      const json = tool.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
      expect(listed.get(tool.name), tool.name).toEqual({ type: 'object', ...json })
    }
    expect(listed.get('submit_execution_report')).toMatchObject({
      required: expect.arrayContaining(['taskId', 'leaseId', 'idempotencyKey', 'outcome']),
      properties: { commit: { pattern: '^[0-9a-f]{40}$' } },
    })
  })
})
