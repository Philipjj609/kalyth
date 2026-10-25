import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  BudgetLedger,
  type ChatRequest,
  findModel,
  MockProvider,
  NebiusProvider,
  ProviderGateway,
  parseOutput,
  RecordingProvider,
  ReplayProvider,
  reservationMicroUsd,
} from '../src/index.ts'

const PROJECT = 'prj_0199f0a0000070008000000000000001'
const OWNER = 'pcp_0199f0a0000070008000000000000002'
const SUPER = 'nvidia/nemotron-3-super-120b-a12b'
const FAKE_KEY = ['test', 'key', 'not', 'real', '0123456789'].join('-')
const Answer = z.strictObject({ answer: z.string() })

type FetchArgs = [string, RequestInit]
function fakeFetch(
  respond: (body: Record<string, unknown>) => { status?: number; body: unknown } | Error,
) {
  const calls: FetchArgs[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init ?? {}])
    const out = respond(
      init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    )
    if (out instanceof Error) throw out
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 })
  }
  return { fetch: impl as typeof fetch, calls }
}
const completion = (content: string, usage = { prompt_tokens: 1000, completion_tokens: 200 }) => ({
  body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage },
})

function setup(
  respond: Parameters<typeof fakeFetch>[0],
  opts: { capMicroUsd?: number; consent?: boolean } = {},
) {
  const ledger = new BudgetLedger(':memory:')
  if (opts.capMicroUsd !== undefined) ledger.setCap(opts.capMicroUsd, 'test cap')
  if (opts.consent ?? true) ledger.setConsent(PROJECT, 'nebius', true, OWNER)
  const net = fakeFetch(respond)
  const provider = new NebiusProvider({ apiKey: FAKE_KEY, fetch: net.fetch })
  const gateway = new ProviderGateway({
    provider,
    ledger,
    roleModels: { summarize: SUPER },
  })
  const ask = () =>
    gateway.generate({
      projectId: PROJECT,
      purpose: 'test',
      model: SUPER,
      system: 'Answer in JSON.',
      user: 'Say hello.',
      schema: Answer,
      schemaName: 'answer',
      maxOutputTokens: 1000,
      reasoning: false,
    })
  return { ledger, gateway, net, ask }
}

describe('budget ledger and gateway (ADR 0010)', () => {
  it('refuses every paid call when no cap is set, without contacting the provider', async () => {
    const { ask, net, ledger } = setup(() => completion('{"answer":"hi"}'))
    const out = await ask()
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe('budget_exceeded')
    expect(net.calls).toHaveLength(0)
    expect(ledger.status()).toMatchObject({ capMicroUsd: 0, spentMicroUsd: 0, calls: 0 })
    expect(out.calls[0]).toMatchObject({ outcome: 'refused', costMicroUsd: 0 })
  })

  it('reserves an upper bound, settles to reported usage, and stops at the cap', async () => {
    const spec = findModel(SUPER)
    if (!spec) throw new Error('missing model')
    const { ask, net, ledger } = setup(() => completion('{"answer":"hi"}'), { capMicroUsd: 2_000 })
    const first = await ask()
    expect(first.ok).toBe(true)
    // 1000 input and 200 output tokens at 0.30 / 0.90 USD per million tokens.
    expect(first.calls[0]).toMatchObject({ outcome: 'ok', costMicroUsd: 480 })
    expect(first.calls[0]?.reservedMicroUsd).toBeGreaterThan(480)
    let calls = 1
    for (; calls < 10; calls++) {
      const out = await ask()
      if (!out.ok) {
        expect(out.error.code).toBe('budget_exceeded')
        break
      }
    }
    const status = ledger.status()
    expect(status.spentMicroUsd).toBe(480 * calls)
    expect(status.spentMicroUsd + status.reservedMicroUsd).toBeLessThanOrEqual(2_000)
    expect(net.calls).toHaveLength(calls)
    const used = status.spentMicroUsd + status.reservedMicroUsd
    expect(status.thresholds).toEqual([
      { fraction: 0.5, reached: used >= 1_000 },
      { fraction: 0.8, reached: used >= 1_600 },
    ])
    expect(status.thresholds[0]?.reached).toBe(true)
  })

  it('keeps the reservation when usage is missing or the outcome is unknown', async () => {
    const noUsage = setup(
      () => ({ body: { choices: [{ message: { content: '{"answer":"x"}' } }] } }),
      {
        capMicroUsd: 1_000_000,
      },
    )
    const a = await noUsage.ask()
    expect(a.ok).toBe(true)
    expect(a.calls[0]?.costMicroUsd).toBe(a.calls[0]?.reservedMicroUsd)

    const network = setup(() => new Error('socket hang up'), { capMicroUsd: 1_000_000 })
    const b = await network.ask()
    expect(b.ok).toBe(false)
    expect(b.calls[0]?.outcome).toBe('unknown_outcome')
    expect(network.ledger.status().reservedMicroUsd).toBe(b.calls[0]?.reservedMicroUsd)

    const rejected = setup(() => ({ status: 429, body: { error: 'rate limited' } }), {
      capMicroUsd: 1_000_000,
    })
    const c = await rejected.ask()
    expect(c.calls[0]).toMatchObject({ outcome: 'failed', costMicroUsd: 0 })
    expect(rejected.ledger.status()).toMatchObject({ spentMicroUsd: 0, reservedMicroUsd: 0 })
  })

  it('requires per-project consent for an external provider', async () => {
    const { ask, net, ledger } = setup(() => completion('{"answer":"hi"}'), {
      capMicroUsd: 1_000_000,
      consent: false,
    })
    const out = await ask()
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe('unauthorized')
    expect(net.calls).toHaveLength(0)
    ledger.setConsent(PROJECT, 'nebius', true, OWNER)
    expect((await ask()).ok).toBe(true)
    ledger.setConsent(PROJECT, 'nebius', false, OWNER)
    expect((await ask()).ok).toBe(false)
  })

  it('makes at most two corrective retries for output that fails the schema, each charged', async () => {
    const answers = ['not json', '{"answer": 3}', '{"answer":"fixed"}']
    const { ask, net } = setup(() => completion(answers.shift() ?? '{}'), {
      capMicroUsd: 1_000_000,
    })
    const out = await ask()
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.value).toEqual({ answer: 'fixed' })
    expect(out.calls.map((c) => c.outcome)).toEqual(['schema_invalid', 'schema_invalid', 'ok'])
    expect(net.calls).toHaveLength(3)
    const lastBody = JSON.parse(String(net.calls[2]?.[1].body)) as { messages: unknown[] }
    expect(lastBody.messages).toHaveLength(6)

    const never = setup(() => completion('{}'), { capMicroUsd: 1_000_000 })
    const failed = await never.ask()
    expect(failed.ok).toBe(false)
    expect(failed.calls).toHaveLength(3)
  })

  it('persists caps and spend across reopening, and shares one cap between handles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalyth-ledger-'))
    try {
      const path = join(dir, 'ledger.sqlite')
      const a = new BudgetLedger(path)
      a.setCap(1_000, 'KAL-test')
      const b = new BudgetLedger(path)
      const call = { provider: 'nebius', model: SUPER, projectId: PROJECT, purpose: 't' }
      const r1 = a.reserve({ ...call, microUsd: 600 })
      const r2 = b.reserve({ ...call, microUsd: 600 })
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(false)
      if (r1.ok)
        a.settle(r1.id, { costMicroUsd: 100, inputTokens: 1, outputTokens: 1, latencyMs: 1 })
      a.close()
      b.close()
      const c = new BudgetLedger(path)
      expect(c.status()).toMatchObject({
        capMicroUsd: 1_000,
        capNote: 'KAL-test',
        spentMicroUsd: 100,
      })
      expect(() => c.setCap(-1, 'x')).toThrow()
      expect(() => c.setCap(5, ' ')).toThrow()
      c.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Nebius provider (no network: fetch is injected)', () => {
  it('sends an OpenAI-compatible request with a strict JSON schema and the reasoning switch', async () => {
    const { ask, net } = setup(() => completion('{"answer":"hi"}'), { capMicroUsd: 1_000_000 })
    await ask()
    const [url, init] = net.calls[0] ?? ['', {}]
    expect(url).toBe('https://api.tokenfactory.nebius.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: SUPER,
      max_tokens: 1000,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } },
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  it('sends a reasoning budget only with reasoning on', async () => {
    const net = fakeFetch(() => completion('{"answer":"hi"}'))
    const provider = new NebiusProvider({ apiKey: FAKE_KEY, fetch: net.fetch })
    const request = {
      model: SUPER,
      messages: [{ role: 'user' as const, content: 'Say hello.' }],
      maxOutputTokens: 14_000,
      temperature: 0.2,
      responseSchema: { name: 'answer', schema: { type: 'object' } },
      reasoningBudget: 8_000,
    }
    await provider.complete({ ...request, reasoning: true }, AbortSignal.timeout(1000))
    await provider.complete({ ...request, reasoning: false }, AbortSignal.timeout(1000))
    const [on, off] = net.calls.map(([, init]) => JSON.parse(String(init.body)))
    expect(on).toMatchObject({ max_tokens: 14_000, reasoning_budget: 8_000 })
    expect(on).not.toHaveProperty('chat_template_kwargs')
    expect(off).not.toHaveProperty('reasoning_budget')
    expect(off).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('never puts the key into error text', async () => {
    const leaky = setup(() => ({ status: 401, body: { error: `bad key ${FAKE_KEY}` } }), {
      capMicroUsd: 1_000_000,
    })
    const out = await leaky.ask()
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(out)).toContain('[redacted]')
  })

  it('lists model ids for the spike without sending a completion', async () => {
    const net = fakeFetch(() => ({ body: { data: [{ id: SUPER }, { id: 'other/model' }, {}] } }))
    const provider = new NebiusProvider({ apiKey: FAKE_KEY, fetch: net.fetch })
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([SUPER, 'other/model'])
    expect(net.calls[0]?.[0]).toBe('https://api.tokenfactory.nebius.com/v1/models')
    expect(net.calls[0]?.[1].method).toBeUndefined()
  })

  it('accepts only https endpoints', () => {
    expect(
      () => new NebiusProvider({ apiKey: FAKE_KEY, baseUrl: 'http://example.test/v1' }),
    ).toThrow()
  })
})

describe('mock, replay and output parsing', () => {
  const request: ChatRequest = {
    model: 'mock',
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 10,
    temperature: 0,
    responseSchema: { name: 'a', schema: {} },
    reasoning: false,
  }

  it('records and replays exchanges; unrecorded requests fail without cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalyth-rec-'))
    try {
      const respond = vi.fn(() => '{"answer":"recorded"}')
      const recorder = new RecordingProvider(new MockProvider(respond), dir)
      await recorder.complete(request, AbortSignal.timeout(1000))
      const replay = ReplayProvider.fromDirectory('mock', dir)
      expect((await replay.complete(request)).content).toBe('{"answer":"recorded"}')
      await expect(replay.complete({ ...request, temperature: 1 })).rejects.toThrow(/no recording/)
      expect(respond).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays a recorded answer through the gateway with no cap, consent or charge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalyth-rec-'))
    try {
      // Record one exchange against a (fake) Nebius, under a cap and with consent.
      const net = fakeFetch(() => completion('{"answer":"recorded"}'))
      const recordingLedger = new BudgetLedger(':memory:')
      recordingLedger.setCap(10_000, 'test cap')
      recordingLedger.setConsent(PROJECT, 'nebius', true, OWNER)
      const ask = (gateway: ProviderGateway, user: string) =>
        gateway.generate({
          projectId: PROJECT,
          purpose: 'test',
          model: SUPER,
          system: 'Answer in JSON.',
          user,
          schema: Answer,
          schemaName: 'answer',
          maxOutputTokens: 1000,
          reasoning: false,
        })
      const recorder = new ProviderGateway({
        provider: new RecordingProvider(
          new NebiusProvider({ apiKey: FAKE_KEY, fetch: net.fetch }),
          dir,
        ),
        ledger: recordingLedger,
        roleModels: { summarize: SUPER },
      })
      expect((await ask(recorder, 'Say hello.')).ok).toBe(true)

      // Replayed with a ledger that has no cap and no consent: free, and nothing is booked.
      const ledger = new BudgetLedger(':memory:')
      const replay = new ProviderGateway({
        provider: ReplayProvider.fromDirectory('nebius', dir),
        ledger,
        roleModels: { summarize: SUPER },
      })
      const again = await ask(replay, 'Say hello.')
      expect(again.ok).toBe(true)
      expect(again.calls[0]).toMatchObject({ recorded: true, costMicroUsd: 0 })
      expect(ledger.status()).toMatchObject({ spentMicroUsd: 0, calls: 0 })
      // Anything else is refused at once, saying why.
      const other = await ask(replay, 'Say goodbye.')
      expect(other.ok).toBe(false)
      if (!other.ok) {
        expect(other.error.code).toBe('not_found')
        expect(other.error.message).toMatch(/no recording/)
      }
      expect(net.calls).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips reasoning blocks and code fences before validating', () => {
    expect(parseOutput('<think>hmm</think>\n```json\n{"answer":"a"}\n```', Answer)).toEqual({
      ok: true,
      value: { answer: 'a' },
    })
    expect(parseOutput('{"answer":"a","extra":1}', Answer).ok).toBe(false)
  })

  it('bounds the reservation by prompt bytes and maximum output', () => {
    const spec = findModel(SUPER)
    if (!spec) throw new Error('missing model')
    // (5 bytes + 64 + 16) input at 0.30 USD/M and 1000 output at 0.90 USD/M.
    expect(reservationMicroUsd(spec, [{ content: 'hello' }], 1000)).toBe(Math.ceil(85 * 0.3 + 900))
  })
})

afterEach(() => vi.restoreAllMocks())
