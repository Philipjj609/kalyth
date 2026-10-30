import { canonicalJson } from '@kalyth/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { buildKnowledgeExample } from '../src/dev/knowledge-example.ts'
import { KNOWLEDGE_OPERATIONS } from '../src/knowledge-api.ts'
import { TOOLS } from '../src/mcp/tools.ts'
import { harness } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
afterEach(async () => h?.close())

async function example() {
  h = await harness()
  const owner = { principalId: h.owner.id, origin: 'human' as const }
  const agent = { principalId: h.agent.id, origin: 'agent' as const }
  return buildKnowledgeExample(h.services, owner, agent)
}

/** One call of every K4 operation, with the example's ids. */
function calls(x: Awaited<ReturnType<typeof example>>): [string, Record<string, unknown>][] {
  const { library, project, L, P, assessments } = x
  return [
    ['search_knowledge', { projectId: project.id, text: 'lockstep' }],
    ['get_knowledge', { library: library.id, id: L.$lockstep }],
    ['get_method', { library: library.id, id: L.$lockstep }],
    ['list_library_uses', { projectId: project.id }],
    ['get_pin_status', { projectId: project.id }],
    [
      'assess_applicability',
      {
        projectId: project.id,
        item: P.$lockstep,
        scenario: P.$expansion,
        element: P.$shooter,
        nature: 'expected',
      },
    ],
    ['list_assessments', { projectId: project.id }],
    ['get_assessment', { projectId: project.id, id: assessments.shooterLockstep }],
  ]
}

describe('K4 read access: one contract for MCP and HTTP (ADR 0031)', () => {
  it('exposes every operation as a read-only MCP tool and an HTTP route', async () => {
    await example()
    const names = KNOWLEDGE_OPERATIONS.map((o) => o.name)
    expect(names).toEqual([
      'search_knowledge',
      'get_knowledge',
      'get_method',
      'list_library_uses',
      'get_pin_status',
      'assess_applicability',
      'list_assessments',
      'get_assessment',
    ])
    const listed = (await h.client.listTools()).tools
    for (const name of names) {
      const tool = listed.find((t) => t.name === name)
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(TOOLS.find((t) => t.name === name)?.readOnly).toBe(true)
    }
  })

  it('answers the same through MCP and HTTP, success and error alike', async () => {
    const x = await example()
    for (const [name, args] of calls(x)) {
      const viaHttp = await h.http('POST', `/api/v1/knowledge/${name}`, args)
      const viaMcp = await h.mcp(name, args)
      expect({ name, status: viaHttp.status }).toEqual({
        name,
        status: name === 'get_method' ? 422 : 200,
      })
      expect(viaMcp.isError).toBe(viaHttp.status !== 200)
      if (viaHttp.status === 200)
        expect(canonicalJson(viaMcp.body)).toBe(canonicalJson(viaHttp.body))
      else expect(viaMcp.body.error.code).toBe(viaHttp.body.error.code)
    }
  })

  it('refuses an assessment request without an explicit nature, on both interfaces', async () => {
    const x = await example()
    const args = { projectId: x.project.id, item: x.P.$lockstep, scenario: x.P.$expansion }
    expect((await h.http('POST', '/api/v1/knowledge/assess_applicability', args)).status).toBe(422)
    expect((await h.mcp('assess_applicability', args)).isError).toBe(true)
  })

  it('keeps unreadable libraries and projects out of reach', async () => {
    const x = await example()
    // A principal who may read the project but not the library.
    const reader = h.services.createPrincipal('agent', 'Project-only agent')
    h.services.grant(reader.id, ['project.read'], x.project.id)
    const caller = { principalId: reader.id, origin: 'agent' as const }
    const search = h.services.searchKnowledge(caller, { projectId: x.project.id, text: 'lockstep' })
    expect(search.ok && search.value).toMatchObject({
      hits: [],
      libraries: [{ searched: false, reason: 'not readable by this caller' }],
    })
    const knowledge = h.services.getKnowledge(caller, { library: x.library.id, id: x.L.$lockstep })
    expect(!knowledge.ok && knowledge.error.code).toBe('unauthorized')
    // Assessing needs the library's conditions, so it is refused too; listing what is recorded is not.
    const listed = h.services.listAssessments(caller, { projectId: x.project.id })
    expect(listed.ok).toBe(true)
    const stranger = h.services.createPrincipal('agent', 'Stranger')
    for (const op of KNOWLEDGE_OPERATIONS) {
      const r = op.run(
        h.services,
        { principalId: stranger.id, origin: 'agent' },
        calls(x).find(([n]) => n === op.name)?.[1],
      )
      expect({ op: op.name, ok: r.ok }).toEqual({ op: op.name, ok: false })
    }
    // Every K4 route needs the session token.
    const anonymous = await h.app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/search_knowledge',
      headers: { host: '127.0.0.1:4317' },
      payload: { projectId: x.project.id, text: 'x' },
    })
    expect(anonymous.statusCode).toBe(401)
  })

  it('tells an agent how to read each result: current, supported, resolved, never a recommendation', async () => {
    const x = await example()
    const assessed = (await h.mcp('assess_applicability', calls(x)[5]?.[1])).body
    expect(assessed.readAs).toMatchObject({
      recommendation: false,
      current: true,
      supported: true,
      resolved: true,
    })
    expect(assessed.verdict).toBe('conditionsNotMet')
    expect(assessed.explanation.steps[0]).toMatchObject({
      relation: 'appliesWhen',
      result: 'false',
      parameters: [{ resolvedFrom: 'element' }],
    })
    expect(assessed.explanation).toMatchObject({
      knowledge: { maturity: 'proposed', disputed: false },
      item: { revision: 1 },
      conflict: { state: 'none' },
    })
    const auth = (
      await h.mcp('assess_applicability', { ...calls(x)[5]?.[1], item: x.P.$authServer })
    ).body
    expect(auth).toMatchObject({
      verdict: 'unknown',
      readAs: { supported: false, recommendation: false },
    })
    expect(auth.readAs.note).toMatch(/declares nothing that must hold/)

    const knowledge = (await h.mcp('get_knowledge', { library: x.library.id, id: x.L.$lockstep }))
      .body
    expect(knowledge).toMatchObject({
      maturity: 'proposed',
      readAs: { recommendation: false, current: true },
    })
    expect(knowledge.sources[0]).toMatchObject({
      kind: 'external',
      meta: { licence: 'unknown', quotePolicy: 'none' },
    })
    expect(knowledge.support[0].sources[0]).toMatchObject({
      quote: 'none',
      quoteMatch: 'notApplicable',
      locatorVerification: 'unverified',
    })

    // A change makes a recorded assessment stale, and the list says so with the reason.
    const commit = (ops: unknown[]) => {
      const p = h.services.proposeChange(
        { principalId: h.owner.id, origin: 'human' },
        {
          projectId: x.project.id,
          baseRevision: h.services.store.getProject(x.project.id)?.headRevision,
          ops,
          rationale: 'r',
        },
      )
      if (!p.ok) throw new Error(p.error.message)
      h.services.commitProposal(
        { principalId: h.owner.id, origin: 'human' },
        { proposalId: p.value.proposalId },
      )
    }
    commit([
      {
        op: 'updateObject',
        id: x.V.$shooterPhysics,
        set: { value: { kind: 'boolean', value: true } },
      },
    ])
    const list = (await h.mcp('list_assessments', { projectId: x.project.id })).body
    const stale = list.assessments.find(
      (a: { id: string }) => a.id === x.assessments.shooterLockstep,
    )
    expect(stale).toMatchObject({
      freshness: { status: 'stale', verdictNow: 'conditionsMet' },
      readAs: { current: false, recommendation: false },
    })
    expect(
      list.assessments.find((a: { id: string }) => a.id === x.assessments.rtsLockstep)?.readAs
        .current,
    ).toBe(true)
  })

  it('reports unresolved pins and libraries moved on', async () => {
    const x = await example()
    const uses = (await h.mcp('list_library_uses', { projectId: x.project.id })).body
    expect(uses.uses[0]).toMatchObject({ present: true, revision: 1, behind: 0 })
    const pins = (await h.mcp('get_pin_status', { projectId: x.project.id })).body
    expect(
      pins.pins.every((p: { resolution: { state: string } }) => p.resolution.state === 'resolved'),
    ).toBe(true)
  })
})
