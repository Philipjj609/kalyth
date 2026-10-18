import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  MODEL_CATALOG,
  OPENROUTER_MODELS_URL,
  OpenRouterProvider,
  ProviderGateway,
} from '../src/index.ts'

const PROJECT = 'prj_0199f0a0000070008000000000000001'
const OWNER = 'pcp_0199f0a0000070008000000000000002'
const FREE = 'nvidia/nemotron-3-super-120b-a12b:free'
const FAKE_KEY = ['test', 'openrouter', 'not', 'real', '0123456789'].join('-')
const Answer = z.strictObject({ answer: z.string() })

const freeSuper = {
  id: FREE,
  pricing: { prompt: '0', completion: '0', request: '0' },
  supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'structured_outputs'],
}

type Seen = { url: string; init: RequestInit; body: Record<string, unknown> | null }

/** A network that answers model metadata and chat completions, recording every request. */
function net(
  options: {
    models?: unknown[]
    chat?: (body: Record<string, unknown>) => { status?: number; body: unknown }
  } = {},
) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    seen.push({ url: String(url), init: init ?? {}, body })
    if (String(url) === OPENROUTER_MODELS_URL) {
      return new Response(JSON.stringify({ data: options.models ?? [freeSuper] }), { status: 200 })
    }
    const out = options.chat?.(body ?? {}) ?? {
      body: {
        choices: [{ message: { content: '{"answer":"hello"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 6, cost: 0 },
      },
    }
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 })
  }) as typeof fetch
  return {
    seen,
    fetch: fetchImpl,
    chats: () => seen.filter((s) => s.url.endsWith('/chat/completions')),
  }
}

function gatewayWith(n: ReturnType<typeof net>, consent = true) {
  const ledger = new BudgetLedger(':memory:')
  if (consent) ledger.setConsent(PROJECT, 'openrouter', true, OWNER)
  const gateway = new ProviderGateway({
    provider: new OpenRouterProvider({ apiKey: FAKE_KEY, fetch: n.fetch }),
    ledger,
    roleModels: DEFAULT_ROLE_MODELS.openrouter ?? {},
  })
  const ask = (model = FREE) =>
    gateway.generate({
      projectId: PROJECT,
      purpose: 'test',
      model,
      system: 'Answer in JSON.',
      user: 'Say hello.',
      schema: Answer,
      schemaName: 'answer',
      maxOutputTokens: 500,
      reasoning: false,
    })
  return { ledger, gateway, ask }
}

describe('OpenRouter provider (ADR 0016; no network: fetch is injected)', () => {
  it('lists only free models, priced at zero, and serves every role with Super', () => {
    const listed = MODEL_CATALOG.filter((m) => m.provider === 'openrouter')
    expect(listed.length).toBeGreaterThan(0)
    for (const m of listed) {
      expect(m.id.endsWith(':free')).toBe(true)
      expect([m.inputMicroUsdPerMTok, m.outputMicroUsdPerMTok]).toEqual([0, 0])
    }
    expect(new Set(Object.values(DEFAULT_ROLE_MODELS.openrouter ?? {}))).toEqual(new Set([FREE]))
  })

  it('sends a strict JSON schema with strict routing; the key goes only in Authorization', async () => {
    const n = net()
    const { ask, ledger } = gatewayWith(n)
    const out = await ask()
    expect(out).toMatchObject({ ok: true, value: { answer: 'hello' } })
    const [chat] = n.chats()
    expect(chat?.body).toMatchObject({
      model: FREE,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } },
      provider: { require_parameters: true, allow_fallbacks: false },
      usage: { include: true },
      reasoning: { enabled: false },
    })
    const headers = chat?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(JSON.stringify(chat?.body)).not.toContain(FAKE_KEY)
    // Model metadata is public: it is read without the key.
    const metadata = n.seen.find((s) => s.url === OPENROUTER_MODELS_URL)
    expect(JSON.stringify(metadata?.init.headers ?? {})).not.toContain(FAKE_KEY)
    // Free calls cost nothing, so they fit in a ledger with no cap.
    expect(ledger.status()).toMatchObject({ capMicroUsd: 0, spentMicroUsd: 0, calls: 1 })
  })

  it('still needs per-project consent, because content leaves the machine', async () => {
    const n = net()
    const out = await gatewayWith(n, false).ask()
    expect(out).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(n.seen).toHaveLength(0)
  })

  it('refuses a model that is not free, unknown to OpenRouter or without structured outputs', async () => {
    const paid = net({
      models: [{ ...freeSuper, pricing: { prompt: '0.0000001', completion: '0' } }],
    })
    expect((await gatewayWith(paid).ask()).ok).toBe(false)
    expect(paid.chats()).toHaveLength(0)

    const unlisted = net({ models: [] })
    expect((await gatewayWith(unlisted).ask()).ok).toBe(false)
    expect(unlisted.chats()).toHaveLength(0)

    const plain = net({
      models: [{ ...freeSuper, supported_parameters: ['max_tokens', 'response_format'] }],
    })
    const refused = await gatewayWith(plain).ask()
    expect(refused).toMatchObject({ ok: false })
    expect(refused.calls[0]?.issues.join()).toMatch(/structured outputs/)
    expect(plain.chats()).toHaveLength(0)

    // A model id without :free is refused before anything is sent, even if catalogued.
    const provider = new OpenRouterProvider({ apiKey: FAKE_KEY, fetch: net().fetch })
    await expect(
      provider.complete(
        {
          model: 'nvidia/nemotron-3-super-120b-a12b',
          messages: [{ role: 'user', content: 'x' }],
          maxOutputTokens: 10,
          temperature: 0,
          responseSchema: { name: 'a', schema: {} },
          reasoning: false,
        },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow(/only free OpenRouter models/)
  })

  it('stops for good after a reported charge', async () => {
    const n = net({
      chat: () => ({
        body: {
          choices: [{ message: { content: '{"answer":"hello"}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 6, cost: 0.0004 },
        },
      }),
    })
    const { ask } = gatewayWith(n)
    const first = await ask()
    expect(first).toMatchObject({ ok: false })
    expect(first.calls[0]).toMatchObject({ outcome: 'unknown_outcome' })
    expect(first.calls[0]?.issues.join()).toMatch(/reported a charge/)
    const second = await ask()
    expect(second.calls[0]).toMatchObject({ outcome: 'failed' })
    expect(n.chats()).toHaveLength(1)
  })

  it('never puts the key into error text', async () => {
    const n = net({ chat: () => ({ status: 401, body: { error: `bad key ${FAKE_KEY}` } }) })
    const out = await gatewayWith(n).ask()
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(out)).toContain('[redacted]')
  })

  it('accepts only https endpoints and a real-looking key', () => {
    expect(() => new OpenRouterProvider({ apiKey: FAKE_KEY, baseUrl: 'http://x.test' })).toThrow(
      /https/,
    )
    expect(() => new OpenRouterProvider({ apiKey: '  ' })).toThrow(/empty/)
  })
})
