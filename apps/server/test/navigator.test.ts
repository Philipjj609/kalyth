import { canonicalJson } from '@kalyth/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { harness, stated } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
afterEach(async () => h?.close())

/** A small committed model: backend contains models.py (which defines Item) and crud.py. */
async function seeded() {
  h = await harness()
  const pid = (await h.http('POST', '/api/v1/projects', { name: 'Demo' })).body.id as string
  const proposal = await h.http('POST', `/api/v1/projects/${pid}/proposals`, {
    baseRevision: 0,
    rationale: 'seed',
    ops: [
      {
        op: 'createObject',
        ref: '$backend',
        type: 'software.Container',
        stance: 'asIs',
        attributes: { name: 'backend' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$models',
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: 'app/models.py' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$crud',
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: 'app/crud.py' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$item',
        type: 'software.DataEntity',
        stance: 'asIs',
        attributes: { name: 'Item' },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$backend',
        to: '$models',
        stance: 'asIs',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$backend',
        to: '$crud',
        stance: 'asIs',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$models',
        to: '$item',
        stance: 'asIs',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'dependsOn',
        from: '$crud',
        to: '$models',
        stance: 'asIs',
        claim: stated,
      },
    ],
  })
  expect(proposal.status).toBe(201)
  const id = proposal.body.proposalId as string
  expect((await h.http('POST', `/api/v1/proposals/${id}/commit`)).status).toBe(200)
  const objects = (await h.http('GET', `/api/v1/projects/${pid}/objects`)).body.objects as {
    id: string
    attributes: Record<string, string>
  }[]
  const idOf = (key: string, value: string) =>
    objects.find((o) => o.attributes[key] === value)?.id as string
  return { pid, item: idOf('name', 'Item'), crud: idOf('path', 'app/crud.py') }
}

describe('impact over HTTP and MCP', () => {
  it('returns the same typed paths on both interfaces', async () => {
    const { pid, item, crud } = await seeded()
    const http = await h.http('GET', `/api/v1/projects/${pid}/impact?seed=${item}&maxDepth=3`)
    expect(http.status).toBe(200)
    const reached = http.body.elements as { id: string; path: { rule: string }[] }[]
    expect(reached.map((e) => e.id)).toContain(crud)
    expect(reached.find((e) => e.id === crud)?.path.map((s) => s.rule)).toEqual([
      'definition',
      'relation',
    ])
    const mcp = await h.mcp('analyze_impact', { projectId: pid, seeds: [item], maxDepth: 3 })
    expect(canonicalJson(mcp.body)).toBe(canonicalJson(http.body))

    const missing = await h.http(
      'GET',
      `/api/v1/projects/${pid}/impact?seed=obj_0199f0a0000070008000000000000000`,
    )
    expect(missing.status).toBe(404)
  })
})

describe('Navigator over HTTP', () => {
  it('starts a run that the UI polls, ending in a pending proposal from the Navigator', async () => {
    const { pid, item } = await seeded()
    const status = await h.http('GET', `/api/v1/projects/${pid}/navigator`)
    expect(status.body).toMatchObject({
      provider: { id: 'mock', external: false, paid: false },
      consent: { required: false },
      budget: { capMicroUsd: 0 },
    })
    expect(
      (await h.http('PUT', `/api/v1/projects/${pid}/navigator/consent`, { granted: true })).status,
    ).toBe(200)

    const started = await h.http('POST', `/api/v1/projects/${pid}/navigator/runs`, {
      kind: 'alternatives',
      request: 'Add multi-tenancy',
      focus: [item],
    })
    expect(started.status).toBe(202)
    const runId = started.body.id as string
    let run = started.body
    for (let i = 0; i < 100 && run.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      run = (await h.http('GET', `/api/v1/navigator/runs/${runId}`)).body
    }
    expect(run).toMatchObject({ status: 'completed', output: { alternatives: 3 } })
    const proposal = await h.http('GET', `/api/v1/proposals/${run.proposalId}`)
    expect(proposal.body).toMatchObject({
      status: 'pending',
      proposedBy: h.navigator.principal.id,
      origin: 'model',
    })

    const runs = await h.http('GET', `/api/v1/projects/${pid}/navigator/runs`)
    expect((runs.body.runs as { id: string }[]).map((r) => r.id)).toEqual([runId])
  })

  it('validates input and keeps paid inference off MCP', async () => {
    const { pid } = await seeded()
    const bad = await h.http('POST', `/api/v1/projects/${pid}/navigator/runs`, {
      kind: 'alternatives',
    })
    expect(bad.status).toBe(422)
    const unknown = await h.http(
      'GET',
      '/api/v1/navigator/runs/nav_0199f0a0000070008000000000000000',
    )
    expect(unknown.status).toBe(404)
    const tools = (await h.client.listTools()).tools.map((t) => t.name)
    expect(tools.filter((t) => /navigator|run|summar|alternative/.test(t))).toEqual([])
  })
})
