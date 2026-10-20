import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { NavigatorRun } from '@kalyth/contracts'
import { KalythServices, SqliteStore } from '@kalyth/core'
import {
  BudgetLedger,
  type ChatRequest,
  type ChatResponse,
  DEFAULT_ROLE_MODELS,
  MockProvider,
  type Provider,
  ProviderGateway,
  RecordedFirstProvider,
  type Recording,
  RecordingProvider,
} from '@kalyth/gateway'
import { Navigator, navigatorMockResponder } from '@kalyth/navigator'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type AllowanceSchedule, DemoAllowance } from '../src/demo/allowance.ts'
import { buildDemoApp, UI_HEADER } from '../src/demo/app.ts'
import { DemoSessions, type OpenSandbox } from '../src/demo/sessions.ts'
import { buildTemplate, type DemoTemplate } from '../src/demo/template.ts'

const EXPORT = resolve(import.meta.dirname, '../../../deploy/demo/template.json')
const HOST = 'demo.test'
const JUDGE_CODE = 'judges-only-0123456789'

/** Stands in for Nebius: external, paid, answering like the mock, and counting its calls. */
class FakeNebius implements Provider {
  readonly id = 'nebius'
  readonly external = true
  readonly paid = true
  calls = 0
  /** How long each answer takes, to hold a run open. */
  delayMs = 0
  readonly #mock = new MockProvider(navigatorMockResponder)
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls++
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    return this.#mock.complete(request)
  }
}

const schedule = (publicDaily: number, judgesDaily: number, total = 50_000_000) =>
  ({
    periods: [
      { from: '2026-01-01T00:00:00Z', daily: { public: publicDaily, judges: judgesDaily } },
    ],
    totals: { public: total, judges: total },
  }) satisfies AllowanceSchedule

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kalyth-demo-test-'))
  dirs.push(dir)
  return dir
}
let template: DemoTemplate
let recordings: Recording[]

beforeAll(async () => {
  template = buildTemplate({
    exportFile: EXPORT,
    dir: tempDir(),
    recordedPresets: new Set(['multi-tenancy', 'summary-backend']),
  })
  // Record two presets the way `pnpm demo:record` does: each in a fresh copy of the template.
  const recordingsDir = tempDir()
  const ledger = new BudgetLedger(':memory:')
  ledger.setCap(10_000_000, 'test recording')
  ledger.setConsent(template.projectId, 'nebius', true, 'demo operator')
  const gateway = new ProviderGateway({
    provider: new RecordingProvider(new FakeNebius(), recordingsDir),
    ledger,
    roleModels: DEFAULT_ROLE_MODELS.nebius ?? {},
  })
  for (const preset of template.presets.filter((p) => p.recorded)) {
    const file = join(recordingsDir, `${preset.id}.db`)
    copyFileSync(template.file, file)
    const store = new SqliteStore(file)
    const navigator = new Navigator({ services: new KalythServices({ store }), gateway })
    const started = navigator.start(
      { principalId: template.ownerId, origin: 'human' },
      preset.input,
    )
    if (!started.ok) throw new Error(started.error.message)
    expect((await started.value.done).status).toBe('completed')
    store.close()
  }
  recordings = RecordedFirstProvider.readRecordings(recordingsDir)
}, 60_000)

const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function demo(
  options: {
    schedule?: AllowanceSchedule
    judgeCode?: string
    live?: boolean
    dailySendLimitBytes?: number
    limits?: Parameters<typeof buildDemoApp>[0]['limits']
  } = {},
) {
  const live = new FakeNebius()
  const ledgers = { public: new BudgetLedger(':memory:'), judges: new BudgetLedger(':memory:') }
  for (const ledger of Object.values(ledgers)) {
    ledger.setConsent(template.projectId, 'nebius', true, 'demo operator')
  }
  const clock = { now: new Date('2026-12-02T10:00:00Z') }
  const allowance = new DemoAllowance({
    ledgers,
    schedule: options.schedule ?? schedule(5_000_000, 5_000_000),
    clock: () => clock.now,
  })
  const gateway = (ledger: BudgetLedger, withLive: boolean) =>
    new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', recordings, withLive ? live : null),
      ledger,
      roleModels: DEFAULT_ROLE_MODELS.nebius ?? {},
    })
  const app = buildDemoApp({
    host: HOST,
    secure: false,
    template,
    sandboxDir: tempDir(),
    gateways: {
      public: gateway(ledgers.public, true),
      judges: gateway(ledgers.judges, true),
      recorded: gateway(new BudgetLedger(':memory:'), false),
    },
    allowance,
    live: options.live ?? true,
    judgeCode: options.judgeCode,
    clock: () => clock.now,
    limits: { requestsPerMinute: 100_000, runsPerHour: 1_000, ...options.limits },
    ...(options.dailySendLimitBytes === undefined
      ? {}
      : { dailySendLimitBytes: options.dailySendLimitBytes }),
  })
  apps.push(app)

  const request = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    opts: { cookie?: string | undefined; payload?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { [UI_HEADER]: '1' }),
        ...(opts.cookie ? { cookie: `kalyth_demo=${opts.cookie}` } : {}),
        ...opts.headers,
      },
      ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
    })
  const visitor = async () => {
    const res = await request('POST', '/api/v1/demo/session')
    expect(res.statusCode).toBe(201)
    const cookie = /kalyth_demo=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1]
    if (!cookie) throw new Error('no session cookie')
    return { cookie, view: res.json() }
  }
  const run = async (cookie: string, input: object) => {
    const started = await request('POST', `/api/v1/projects/${template.projectId}/navigator/runs`, {
      cookie,
      payload: input,
    })
    if (started.statusCode !== 202) return { status: started.statusCode, body: started.json() }
    let current = started.json() as NavigatorRun
    for (let i = 0; i < 500 && current.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10))
      current = (await request('GET', `/api/v1/navigator/runs/${current.id}`, { cookie })).json()
    }
    // Let the run's completion hooks settle before the next request.
    await new Promise((r) => setTimeout(r, 20))
    return { status: 202, run: current }
  }
  return { app, live, ledgers, clock, request, visitor, run }
}

const preset = (id: string) => {
  const found = template.presets.find((p) => p.id === id)
  if (!found) throw new Error(`no preset ${id}`)
  return found.input
}
const freeText = () => ({
  kind: 'alternatives',
  projectId: template.projectId,
  request: 'Add per-user quotas on how many items they can create.',
  focus: [],
})

describe('hosted demo (ADR 0019)', () => {
  it('gives every visitor their own copy of the template', async () => {
    const d = demo()
    const a = await d.visitor()
    const b = await d.visitor()
    expect(a.view).toMatchObject({ projectId: template.projectId, judge: false, mcp: false })
    const proposed = await d.request('POST', `/api/v1/projects/${template.projectId}/proposals`, {
      cookie: a.cookie,
      payload: {
        baseRevision: 1,
        rationale: 'A visitor plans a module',
        ops: [
          {
            op: 'createObject',
            type: 'software.Module',
            stance: 'toBe',
            attributes: { path: 'backend/app/quotas.py' },
            claim: { basis: 'stated' },
          },
        ],
      },
    })
    expect(proposed.statusCode).toBe(201)
    const committed = await d.request(
      'POST',
      `/api/v1/proposals/${proposed.json().proposalId}/commit`,
      {
        cookie: a.cookie,
      },
    )
    expect(committed.json()).toMatchObject({ status: 'committed', revision: 2 })
    const head = async (cookie: string) =>
      (await d.request('GET', `/api/v1/projects/${template.projectId}`, { cookie })).json().project
        .headRevision
    expect(await head(a.cookie)).toBe(2)
    expect(await head(b.cookie)).toBe(1)
    // B cannot even see A's proposal.
    const seen = await d.request('GET', `/api/v1/proposals/${proposed.json().proposalId}`, {
      cookie: b.cookie,
    })
    expect(seen.statusCode).toBe(404)
  })

  it('switches off what would reach beyond a sandbox', async () => {
    const d = demo()
    const { cookie } = await d.visitor()
    const p = template.projectId
    const refused = [
      await d.request('GET', `/api/v1/projects/${p}/agent-tokens`, { cookie }),
      await d.request('POST', `/api/v1/projects/${p}/agent-tokens`, {
        cookie,
        payload: { label: 'x', expiresInDays: 1 },
      }),
      await d.request('POST', '/api/v1/agent-tokens/tok_x/revoke', { cookie }),
      await d.request('PUT', `/api/v1/projects/${p}/navigator/consent`, {
        cookie,
        payload: { granted: false },
      }),
      await d.request('PUT', `/api/v1/projects/${p}/task-repository`, {
        cookie,
        payload: { path: '/etc' },
      }),
      // Reconciling re-analyses a repository on the server, like ingest (ADR 0024).
      await d.request('POST', `/api/v1/tasks/obj_${'0'.repeat(32)}/reconcile`, { cookie }),
    ]
    expect(refused.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403, 403])
    expect(refused[5]?.json().error.message).toMatch(/not available in the hosted demo/)
    expect(refused[0]?.json().error.message).toMatch(/not available in the hosted demo/)
    const mcp = await d.request('POST', '/mcp', { cookie, payload: {} })
    expect(mcp.statusCode).toBe(404)
  })

  it('checks the host, the origin, the UI header and the session', async () => {
    const d = demo()
    const { cookie } = await d.visitor()
    const health = await d.request('GET', '/api/v1/health')
    expect(health.json()).toMatchObject({ status: 'ok', mode: 'demo' })
    // The platform's health checker may use another host name.
    const internal = await d.request('GET', '/api/v1/health', {
      headers: { host: '10.0.0.5:8080' },
    })
    expect(internal.statusCode).toBe(200)
    const cases = [
      await d.request('GET', '/api/v1/projects', { cookie, headers: { host: 'evil.example' } }),
      await d.request('GET', '/api/v1/projects', {
        cookie,
        headers: { origin: 'https://evil.example' },
      }),
      await d.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${template.projectId}/proposals`,
        headers: { host: HOST, cookie: `kalyth_demo=${cookie}` },
        payload: {},
      }),
      await d.request('GET', '/api/v1/projects'),
      await d.request('GET', '/api/v1/projects', { cookie: 'A'.repeat(43) }),
    ]
    expect(cases.map((r) => r.statusCode)).toEqual([403, 403, 403, 401, 401])
    const ok = await d.request('GET', '/api/v1/projects', {
      cookie,
      headers: { origin: `http://${HOST}` },
    })
    expect(ok.statusCode).toBe(200)
  })

  it('answers recorded presets for free, even when every pool is empty', async () => {
    const d = demo({ schedule: schedule(0, 0) })
    const { cookie } = await d.visitor()
    const done = await d.run(cookie, preset('multi-tenancy'))
    expect(done.run?.status).toBe('completed')
    expect(done.run?.calls.every((c) => c.recorded === true && c.costMicroUsd === 0)).toBe(true)
    expect(done.run?.proposalId).toBeTruthy()
    const summary = await d.run(cookie, preset('summary-backend'))
    expect(summary.run?.status).toBe('completed')
    expect(d.live.calls).toBe(0)
    for (const ledger of Object.values(d.ledgers)) expect(ledger.status().calls).toBe(0)

    // A request that was never recorded is refused by the empty pool, before any call.
    const live = await d.run(cookie, freeText())
    expect(live.run?.status).toBe('failed')
    expect(live.run?.error?.code).toBe('budget_exceeded')
    expect(d.live.calls).toBe(0)
  })

  it('charges live runs to the public pool, and keeps the judges a pool of their own', async () => {
    // The public allowance is below one alternatives reservation; the judges' is not.
    const d = demo({ schedule: schedule(20_000, 400_000), judgeCode: JUDGE_CODE })
    const visitor = await d.visitor()
    const refused = await d.run(visitor.cookie, freeText())
    expect(refused.run?.error?.code).toBe('budget_exceeded')
    expect(d.live.calls).toBe(0)

    const judge = await d.visitor()
    const wrong = await d.request('POST', '/api/v1/demo/judge', {
      cookie: judge.cookie,
      payload: { code: 'not-the-code' },
    })
    expect(wrong.statusCode).toBe(403)
    const right = await d.request('POST', '/api/v1/demo/judge', {
      cookie: judge.cookie,
      payload: { code: JUDGE_CODE },
    })
    expect(right.json()).toMatchObject({ judge: true, live: { pool: 'judges' } })
    const judged = await d.run(judge.cookie, freeText())
    expect(judged.run?.status).toBe('completed')
    expect(judged.run?.calls.some((c) => c.recorded !== true && c.costMicroUsd > 0)).toBe(true)
    expect(d.live.calls).toBeGreaterThan(0)
    expect(d.ledgers.judges.status().spentMicroUsd).toBeGreaterThan(0)
    expect(d.ledgers.public.status().spentMicroUsd).toBe(0)

    // The next UTC day brings a new allowance; the unused one does not carry over.
    const capBefore = d.ledgers.public.status().capMicroUsd
    d.clock.now = new Date('2026-12-03T00:00:01Z')
    const next = await d.request('GET', '/api/v1/demo/session', { cookie: visitor.cookie })
    expect(next.json().live.poolRemainingTodayMicroUsd).toBe(20_000)
    expect(d.ledgers.public.status().capMicroUsd).toBe(capBefore)
  })

  it('limits live runs per session a day, and allows one run at a time', async () => {
    const d = demo()
    const { cookie } = await d.visitor()
    for (let i = 0; i < 3; i++) {
      const done = await d.run(cookie, freeText())
      expect(done.run?.status).toBe('completed')
    }
    const view = await d.request('GET', '/api/v1/demo/session', { cookie })
    expect(view.json().live.runsLeftToday).toBe(0)
    // Out of live runs: recordings still work, and anything else is refused without a call.
    const calls = d.live.calls
    expect((await d.run(cookie, preset('multi-tenancy'))).run?.status).toBe('completed')
    const refused = await d.run(cookie, freeText())
    expect(refused.run?.error?.code).toBe('budget_exceeded')
    expect(d.live.calls).toBe(calls)

    const other = await d.visitor()
    d.live.delayMs = 300
    const first = await d.request('POST', `/api/v1/projects/${template.projectId}/navigator/runs`, {
      cookie: other.cookie,
      payload: freeText(),
    })
    expect(first.statusCode).toBe(202)
    const second = await d.request(
      'POST',
      `/api/v1/projects/${template.projectId}/navigator/runs`,
      { cookie: other.cookie, payload: freeText() },
    )
    expect(second.statusCode).toBe(409)
  })

  it('without a key or consent, runs only what was recorded', async () => {
    const d = demo({ live: false })
    const { cookie, view } = await d.visitor()
    expect(view.live).toMatchObject({ available: false })
    expect((await d.run(cookie, preset('multi-tenancy'))).run?.status).toBe('completed')
    expect((await d.run(cookie, freeText())).run?.status).toBe('failed')
    expect(d.live.calls).toBe(0)
  })

  it('stops serving after the daily traffic allowance, except its health check', async () => {
    const d = demo({ dailySendLimitBytes: 20_000 })
    const { cookie } = await d.visitor()
    let status = 200
    for (let i = 0; i < 50 && status === 200; i++) {
      status = (await d.request('GET', `/api/v1/projects/${template.projectId}`, { cookie }))
        .statusCode
    }
    expect(status).toBe(503)
    expect((await d.request('GET', '/api/v1/health')).statusCode).toBe(200)
    d.clock.now = new Date('2026-12-03T00:00:01Z')
    const next = await d.request('GET', `/api/v1/projects/${template.projectId}`, { cookie })
    expect(next.statusCode).toBe(200)
  })

  it('limits new sessions and judge-code attempts per address', async () => {
    const d = demo({
      judgeCode: JUDGE_CODE,
      limits: { sessionsPerHour: 2, judgeAttemptsPerHour: 2 },
    })
    const { cookie } = await d.visitor()
    await d.visitor()
    expect((await d.request('POST', '/api/v1/demo/session')).statusCode).toBe(429)
    const attempt = () =>
      d.request('POST', '/api/v1/demo/judge', { cookie, payload: { code: 'wrong-code' } })
    expect((await attempt()).statusCode).toBe(403)
    expect((await attempt()).statusCode).toBe(403)
    expect((await attempt()).statusCode).toBe(429)
    // Even the right code waits now.
    const right = await d.request('POST', '/api/v1/demo/judge', {
      cookie,
      payload: { code: JUDGE_CODE },
    })
    expect(right.statusCode).toBe(429)
  })
})

describe('demo sessions and allowance', () => {
  it('expires idle sessions with their sandbox files, and evicts the oldest past the limit', () => {
    const clock = { now: 0 }
    const opened: string[] = []
    const sessions = new DemoSessions<OpenSandbox>({
      template: template.file,
      dir: tempDir(),
      maxSessions: 2,
      idleMs: 1_000,
      clock: () => clock.now,
      openSandbox: (file) => {
        opened.push(file)
        return { close: () => {} }
      },
    })
    const a = sessions.create()
    clock.now = 10
    const b = sessions.create()
    expect(existsSync(a.session.file)).toBe(true)
    clock.now = 20
    const c = sessions.create()
    expect(sessions.size).toBe(2)
    expect(existsSync(a.session.file)).toBe(false)
    expect(sessions.find(a.cookie)).toBeUndefined()
    expect(sessions.find(b.cookie)).toBe(b.session)
    clock.now = 2_000
    expect(sessions.find(c.cookie)).toBeUndefined()
    expect(existsSync(c.session.file)).toBe(false)
    expect(sessions.find('not a cookie')).toBeUndefined()
  })

  it('sets each pool a daily cap that never carries over and never passes the total', () => {
    const ledgers = { public: new BudgetLedger(':memory:'), judges: new BudgetLedger(':memory:') }
    const clock = { now: new Date('2026-11-30T23:00:00Z') }
    const allowance = new DemoAllowance({ ledgers, clock: () => clock.now })
    expect(allowance.remainingToday('public')).toBe(70_000)
    expect(allowance.remainingToday('judges')).toBe(30_000)
    clock.now = new Date('2026-12-01T00:00:00Z')
    expect(allowance.remainingToday('public')).toBe(150_000)
    expect(allowance.remainingToday('judges')).toBe(250_000)
    clock.now = new Date('2026-12-15T20:00:00Z')
    expect(allowance.remainingToday('judges')).toBe(0)

    const small = new DemoAllowance({
      ledgers: { public: new BudgetLedger(':memory:'), judges: new BudgetLedger(':memory:') },
      schedule: schedule(100_000, 100_000, 150_000),
      clock: () => clock.now,
    })
    clock.now = new Date('2026-12-02T10:00:00Z')
    expect(small.remainingToday('public')).toBe(100_000)
    clock.now = new Date('2026-12-03T10:00:00Z')
    // Nothing was spent, but the total still bounds the cap.
    expect(small.remainingToday('public')).toBe(100_000)
  })
})
