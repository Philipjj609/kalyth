import { environmentManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { id, navigatorRun, navigatorStatus, PROJECT } from '../test/navigator.ts'
import { ApiError, createApi, type FetchLike, impactUrl } from './client.ts'
import { navigatorRunOptions } from './queries.ts'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

/** A fetch that records each request and answers from a queue (the last answer repeats). */
function recordingFetch(answers: Response[] | (() => Response)) {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    if (typeof answers === 'function') return answers()
    const next = answers.length > 1 ? answers.shift() : answers[0]
    return (next as Response).clone()
  }
  return { calls, fetchImpl }
}

const RUN = id('nav', 7)

describe('Navigator API client', () => {
  it('reads the status with the session token, and maps a missing route to null', async () => {
    const status = navigatorStatus()
    const { calls, fetchImpl } = recordingFetch([json(200, status)])
    const api = createApi(() => 'tok-123456', fetchImpl)
    await expect(api.navigatorStatus(PROJECT)).resolves.toEqual(status)
    expect(calls[0]).toMatchObject({
      url: `/api/v1/projects/${PROJECT}/navigator`,
      method: 'GET',
    })
    expect(calls[0]?.headers.authorization).toBe('Bearer tok-123456')

    const missing = createApi(
      () => 't',
      async () => json(404, { error: { code: 'not_found', message: 'no route', issues: [] } }),
    )
    await expect(missing.navigatorStatus(PROJECT)).resolves.toBeNull()
  })

  it('grants and revokes consent with PUT', async () => {
    const granted = navigatorStatus({
      consent: { required: true, granted: true, grantedBy: id('pcp', 2), grantedAt: null },
    })
    const { calls, fetchImpl } = recordingFetch([json(200, granted)])
    const api = createApi(() => 't', fetchImpl)
    await expect(api.setNavigatorConsent(PROJECT, true)).resolves.toEqual(granted)
    await api.setNavigatorConsent(PROJECT, false)
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['PUT', `/api/v1/projects/${PROJECT}/navigator/consent`, { granted: true }],
      ['PUT', `/api/v1/projects/${PROJECT}/navigator/consent`, { granted: false }],
    ])
    expect(calls[0]?.headers['content-type']).toBe('application/json')
  })

  it('starts runs of both kinds and accepts a 202', async () => {
    const run = navigatorRun({ id: RUN })
    const { calls, fetchImpl } = recordingFetch([json(202, run)])
    const api = createApi(() => 't', fetchImpl)
    await expect(
      api.startNavigatorRun(PROJECT, {
        kind: 'alternatives',
        request: 'add multi-tenancy',
        focus: [id('obj', 1)],
      }),
    ).resolves.toEqual(run)
    await api.startNavigatorRun(PROJECT, { kind: 'summarize', elementId: id('obj', 2) })
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      [
        'POST',
        `/api/v1/projects/${PROJECT}/navigator/runs`,
        { kind: 'alternatives', request: 'add multi-tenancy', focus: [id('obj', 1)] },
      ],
      [
        'POST',
        `/api/v1/projects/${PROJECT}/navigator/runs`,
        { kind: 'summarize', elementId: id('obj', 2) },
      ],
    ])
  })

  it('surfaces budget, consent and validation refusals as the error envelope', async () => {
    const refusals = [
      [429, 'budget_exceeded'],
      [403, 'unauthorized'],
      [422, 'invalid'],
      [503, 'retryable'],
    ] as const
    for (const [status, code] of refusals) {
      const api = createApi(
        () => 't',
        async () => json(status, { error: { code, message: `refused: ${code}`, issues: [] } }),
      )
      const error = await api
        .startNavigatorRun(PROJECT, { kind: 'summarize', elementId: id('obj', 2) })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(status)
      expect((error as ApiError).body.code).toBe(code)
    }
  })

  it('lists runs, reads one run and one proposal', async () => {
    const { calls, fetchImpl } = recordingFetch([json(200, { runs: [] })])
    const api = createApi(() => 't', fetchImpl)
    await api.navigatorRuns(PROJECT)
    await api.navigatorRun(RUN)
    await api.proposal(id('prp', 3))
    expect(calls.map((c) => c.url)).toEqual([
      `/api/v1/projects/${PROJECT}/navigator/runs?limit=50`,
      `/api/v1/navigator/runs/${RUN}`,
      `/api/v1/proposals/${id('prp', 3)}`,
    ])
  })

  it('sends impact seeds as repeated parameters, with limits and revision', async () => {
    const a = id('obj', 1)
    const b = id('obj', 2)
    expect(impactUrl(PROJECT, { seeds: [a, b, a], maxDepth: 4, maxNodes: 300, revision: 7 })).toBe(
      `/api/v1/projects/${PROJECT}/impact?seed=${a}&seed=${b}&maxDepth=4&maxNodes=300&revision=7`,
    )
    expect(impactUrl(PROJECT, { seeds: [a] })).toBe(`/api/v1/projects/${PROJECT}/impact?seed=${a}`)
    const { calls, fetchImpl } = recordingFetch([json(200, { elements: [] })])
    await createApi(() => 't', fetchImpl).impact(PROJECT, { seeds: [a] })
    expect(calls[0]?.method).toBe('GET')
  })
})

describe('run polling', () => {
  beforeEach(() => {
    // TanStack Query does not schedule refetch timers when it thinks it runs on a server.
    environmentManager.setIsServer(() => false)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    environmentManager.setIsServer(() => typeof window === 'undefined')
  })

  it('refetches about once a second while running and stops when the run is final', async () => {
    const answers = [
      json(200, navigatorRun({ id: RUN, status: 'running' })),
      json(200, navigatorRun({ id: RUN, status: 'running' })),
      json(200, navigatorRun({ id: RUN, status: 'completed', proposalId: id('prp', 9) })),
    ]
    const { calls, fetchImpl } = recordingFetch(answers)
    const api = createApi(() => 't', fetchImpl)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new QueryObserver(client, navigatorRunOptions(api, RUN))
    const seen: string[] = []
    const unsubscribe = observer.subscribe((result) => {
      if (result.data) seen.push(result.data.status)
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(3)
    expect(observer.getCurrentResult().data?.status).toBe('completed')
    expect(observer.getCurrentResult().data?.proposalId).toBe(id('prp', 9))

    // Final: no more requests, however long we wait.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.url === `/api/v1/navigator/runs/${RUN}`)).toBe(true)
    expect(seen.at(-1)).toBe('completed')
    unsubscribe()
    client.clear()
  })

  it('does not poll a run that is already final', async () => {
    const { calls, fetchImpl } = recordingFetch([json(200, navigatorRun({ status: 'failed' }))])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new QueryObserver(
      client,
      navigatorRunOptions(
        createApi(() => 't', fetchImpl),
        RUN,
      ),
    )
    const unsubscribe = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(1)
    unsubscribe()
    client.clear()
  })
})
