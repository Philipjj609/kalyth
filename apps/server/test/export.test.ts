import { importProjectExport, SqliteStore } from '@kalyth/core'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST, harness, stated, TOKEN } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
afterEach(async () => {
  await h?.close()
})

describe('project export over HTTP (ADR 0014)', () => {
  it('downloads a bundle that imports into another store, and offers no MCP tool for it', async () => {
    h = await harness()
    const projectId = (await h.http('POST', '/api/v1/projects', { name: 'Exported' })).body
      .id as string
    const p = await h.http('POST', `/api/v1/projects/${projectId}/proposals`, {
      baseRevision: 0,
      rationale: 'seed',
      ops: [
        {
          op: 'createObject',
          type: 'core.Requirement',
          stance: 'toBe',
          attributes: { title: 'Audit log', statement: 'Every change is logged.' },
          claim: stated,
        },
      ],
    })
    await h.http('POST', `/api/v1/proposals/${p.body.proposalId}/commit`)

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/export`,
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="kalyth-${projectId}-r1.json"`,
    )
    const bundle = res.json()
    expect(bundle).toMatchObject({ format: 'kalyth.project-export', project: { headRevision: 1 } })
    const imported = importProjectExport(new SqliteStore(':memory:'), bundle)
    expect(imported).toMatchObject({ ok: true, value: { projectId, headRevision: 1 } })

    const tools = (await h.client.listTools()).tools.map((t) => t.name)
    expect(tools.some((t) => /export|import/.test(t))).toBe(false)
  })
})
