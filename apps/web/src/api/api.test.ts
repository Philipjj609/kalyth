import { describe, expect, it } from 'vitest'
import { ApiError, buildUrl, createApi, type FetchLike, toApiErrorBody } from './client.ts'
import { parseFreshness } from './freshness.ts'
import { bootstrapToken, TOKEN_STORAGE_KEY } from './token.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

// Built at runtime so secret scanners do not mistake this fixture for a credential.
const FAKE_TOKEN = ['abc', 'DEF123_-xyz'].join('')

describe('bootstrapToken', () => {
  it('moves the token from the fragment to session storage and cleans the URL', () => {
    const storage = memoryStorage()
    const replaced: string[] = []
    const token = bootstrapToken({
      location: { hash: `#token=${FAKE_TOKEN}`, pathname: '/', search: '?project=prj_1' },
      storage,
      replaceUrl: (url) => replaced.push(url),
    })
    expect(token).toBe(FAKE_TOKEN)
    expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe(FAKE_TOKEN)
    expect(replaced).toEqual(['/?project=prj_1'])
  })

  it('keeps other fragment parameters and falls back to the stored token', () => {
    const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'stored-token-123' })
    const replaced: string[] = []
    expect(
      bootstrapToken({
        location: { hash: '#token=&x=1', pathname: '/p', search: '' },
        storage,
        replaceUrl: (url) => replaced.push(url),
      }),
    ).toBe('stored-token-123')
    expect(replaced).toEqual(['/p#x=1'])
    expect(
      bootstrapToken({
        location: { hash: '', pathname: '/', search: '' },
        storage: null,
        replaceUrl: () => {},
      }),
    ).toBeNull()
  })

  it('survives storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    expect(
      bootstrapToken({
        location: { hash: '#token=abcdefgh12', pathname: '/', search: '' },
        storage: throwing,
        replaceUrl: () => {},
      }),
    ).toBe('abcdefgh12')
  })
})

describe('API client', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('builds query strings with revisions and comma-separated ids', () => {
    expect(buildUrl('/x', { revision: 3, id: ['a', 'b'], skip: undefined, flag: true })).toBe(
      '/x?revision=3&id=a%2Cb&flag=true',
    )
    expect(buildUrl('/x', { id: [] })).toBe('/x')
  })

  it('sends the bearer token and parses success', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) })
      return json(200, { projects: [] })
    }
    const api = createApi(() => 'tok-123456', fetchImpl)
    await expect(api.listProjects()).resolves.toEqual({ projects: [] })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-123456')
    expect(headers['content-type']).toBeUndefined()
    await api.objects('prj_1', 4, true)
    expect(calls[1]?.url).toBe(
      '/api/v1/projects/prj_1/objects?revision=4&limit=1000&includeRetired=true',
    )
  })

  it('surfaces the error envelope, including stale details', async () => {
    const envelope = {
      error: {
        code: 'stale',
        message: 'state this proposal relies on changed since revision 1',
        issues: [{ code: 'stale.changed', message: 'obj_1' }],
        changedRefs: ['obj_1'],
        currentRevision: 2,
      },
    }
    const api = createApi(
      () => 't',
      async () => json(409, envelope),
    )
    const error = await api.commit('prp_1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).body).toEqual(envelope.error)
  })

  it('degrades unexpected bodies and unreachable servers to readable errors', async () => {
    expect(toApiErrorBody(500, 'oops')).toEqual({
      code: 'error',
      message: 'Request failed (HTTP 500)',
      issues: [],
    })
    expect(toApiErrorBody(401, { error: { issues: [1, { code: 'a', message: 'b' }] } })).toEqual({
      code: 'unauthenticated',
      message: 'Request failed (HTTP 401)',
      issues: [{ code: 'a', message: 'b' }],
    })
    const api = createApi(
      () => null,
      async () => {
        throw new TypeError('fetch failed')
      },
    )
    const error = (await api.health().catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(0)
    expect(error.body.code).toBe('retryable')
  })

  it('treats a missing freshness endpoint as "not available"', async () => {
    const api = createApi(
      () => 't',
      async () => json(404, { error: { code: 'not_found', message: 'no route', issues: [] } }),
    )
    await expect(api.freshness('prj_1', 2)).resolves.toBeNull()
    const failing = createApi(
      () => 't',
      async () => json(500, {}),
    )
    await expect(failing.freshness('prj_1', 2)).rejects.toBeInstanceOf(ApiError)
  })

  it('batches evidence requests', async () => {
    const urls: string[] = []
    const api = createApi(
      () => 't',
      async (url) => {
        urls.push(url)
        return json(200, { evidence: [] })
      },
    )
    const ids = Array.from({ length: 250 }, (_, i) => `evd_${i}`)
    await api.evidence('prj_1', [...ids, 'evd_0'])
    expect(urls).toHaveLength(2)
  })
})

describe('parseFreshness', () => {
  it('keeps valid claims, maps unknown statuses, and recomputes the summary', () => {
    const report = parseFreshness({
      projectId: 'prj_1',
      revision: 3,
      snapshots: [{ objectId: 'obj_s', repo: 'r', commit: 'c' }, { bad: true }],
      claims: [
        {
          id: 'obj_1',
          kind: 'object',
          type: 't',
          basis: 'observed',
          status: 'stale',
          staleEvidence: ['evd_1'],
          reason: 'changed',
        },
        { id: 'obj_2', kind: 'object', status: 'mystery' },
        { kind: 'object' },
      ],
      summary: { stale: 99 },
    })
    expect(report?.claims.map((c) => [c.id, c.status])).toEqual([
      ['obj_1', 'stale'],
      ['obj_2', 'unknown'],
    ])
    expect(report?.summary).toEqual({ stale: 1, unknown: 1 })
    expect(report?.snapshots).toHaveLength(1)
    expect(parseFreshness({ nope: 1 })).toBeNull()
  })
})
