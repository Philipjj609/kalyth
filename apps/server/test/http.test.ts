import { afterEach, describe, expect, it } from 'vitest'
import { HOST, harness, stated, TOKEN } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
afterEach(async () => h?.close())

describe('HTTP API security', () => {
  it('requires the session token, except for health', async () => {
    h = await harness()
    const none = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: HOST },
    })
    expect(none.statusCode).toBe(401)
    expect(none.json().error.code).toBe('unauthenticated')
    const wrong = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}x` },
    })
    expect(wrong.statusCode).toBe(401)
    const health = await h.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: HOST },
    })
    expect(health.json()).toMatchObject({ status: 'ok', schemaVersion: 4 })
  })

  it('rejects foreign Host headers (DNS rebinding) and foreign origins', async () => {
    h = await harness()
    const auth = { authorization: `Bearer ${TOKEN}` }
    const rebound = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: 'attacker.example:4317', ...auth },
    })
    expect(rebound.statusCode).toBe(403)
    const crossOrigin = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: HOST, origin: 'https://attacker.example', ...auth },
    })
    expect(crossOrigin.statusCode).toBe(403)
    const sameOrigin = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { host: HOST, origin: `http://${HOST}`, ...auth },
    })
    expect(sameOrigin.statusCode).toBe(200)
  })
})

describe('HTTP API behaviour', () => {
  it('creates a project, proposes, commits and maps errors to status codes', async () => {
    h = await harness()
    const created = await h.http('POST', '/api/v1/projects', { name: 'Demo' })
    expect(created.status).toBe(201)
    const pid = created.body.id as string

    const invalid = await h.http('POST', `/api/v1/projects/${pid}/proposals`, {
      baseRevision: 0,
      rationale: 'bad',
      ops: [
        {
          op: 'createObject',
          type: 'software.Nope',
          stance: 'asIs',
          attributes: {},
          claim: stated,
        },
      ],
    })
    expect(invalid.status).toBe(422)
    expect(invalid.body.status).toBe('invalid')

    const ok = await h.http('POST', `/api/v1/projects/${pid}/proposals`, {
      baseRevision: 0,
      rationale: 'add module',
      ops: [
        {
          op: 'createObject',
          type: 'software.Module',
          stance: 'asIs',
          attributes: { path: 'a.py' },
          claim: stated,
        },
      ],
    })
    expect(ok.status).toBe(201)
    const commit = await h.http('POST', `/api/v1/proposals/${ok.body.proposalId}/commit`)
    expect(commit).toMatchObject({ status: 200, body: { status: 'committed', revision: 1 } })

    const objects = await h.http(
      'GET',
      `/api/v1/projects/${pid}/objects?type=software.Module&revision=1`,
    )
    expect(objects.body.objects).toHaveLength(1)
    expect((await h.http('GET', `/api/v1/projects/${pid}/objects?revision=7`)).status).toBe(422)
    expect((await h.http('GET', `/api/v1/projects/prj_${'0'.repeat(32)}`)).status).toBe(404)

    const moduleId = objects.body.objects[0].id
    const a = await h.http('POST', `/api/v1/projects/${pid}/proposals`, {
      baseRevision: 1,
      rationale: 'a',
      ops: [{ op: 'updateObject', id: moduleId, set: { language: 'py' } }],
    })
    const b = await h.http('POST', `/api/v1/projects/${pid}/proposals`, {
      baseRevision: 1,
      rationale: 'b',
      ops: [{ op: 'updateObject', id: moduleId, set: { language: 'python' } }],
    })
    await h.http('POST', `/api/v1/proposals/${a.body.proposalId}/commit`)
    const stale = await h.http('POST', `/api/v1/proposals/${b.body.proposalId}/commit`)
    expect(stale).toMatchObject({
      status: 409,
      body: { error: { code: 'stale', currentRevision: 2, changedRefs: [moduleId] } },
    })
  })

  it('names the principals, marks the caller, and gives nothing else away', async () => {
    h = await harness()
    const names = await h.http('GET', '/api/v1/principals')
    expect(names.status).toBe(200)
    const principals = names.body.principals as Record<string, unknown>[]
    expect(principals).toContainEqual({
      id: h.owner.id,
      kind: 'human',
      displayName: 'Local owner',
      you: true,
    })
    expect(principals).toContainEqual(
      expect.objectContaining({ id: h.agent.id, kind: 'agent', you: false }),
    )
    for (const p of principals)
      expect(Object.keys(p).sort()).toEqual(['displayName', 'id', 'kind', 'you'])
  })
})
