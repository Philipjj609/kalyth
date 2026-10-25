import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BudgetLedger,
  type ChatRequest,
  type ChatResponse,
  type Provider,
  ProviderGateway,
  RecordedFirstProvider,
  RecordingProvider,
} from '../src/index.ts'

const PROJECT = 'prj_0199f0a0000070008000000000000001'
const OWNER = 'pcp_0199f0a0000070008000000000000002'
const SUPER = 'nvidia/nemotron-3-super-120b-a12b'
const ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b'
const Answer = z.strictObject({ answer: z.string() })

/** A stand-in for Nebius: external, paid, and counting its calls. */
class FakeNebius implements Provider {
  readonly id = 'nebius'
  readonly external = true
  readonly paid = true
  calls = 0
  models: string[] = []
  reasoning: boolean[] = []
  requests: ChatRequest[] = []
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls++
    this.models.push(request.model)
    this.reasoning.push(request.reasoning)
    this.requests.push(request)
    return {
      content: '{"answer":"live"}',
      refusal: null,
      inputTokens: 1000,
      outputTokens: 200,
      finishReason: 'stop',
    }
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const request = (user: string, model = SUPER, reasoning = false) => ({
  projectId: PROJECT,
  purpose: 'test',
  model,
  system: 'Answer in JSON.',
  user,
  schema: Answer,
  schemaName: 'answer',
  maxOutputTokens: 1000,
  reasoning,
})

const generate = (gateway: ProviderGateway, user: string, model = SUPER, reasoning = false) =>
  gateway.generate(request(user, model, reasoning))

/** Records one exchange for `user`, the way the demo's recording session does. */
async function recordingsFor(user: string, model = SUPER, reasoning = false) {
  const dir = mkdtempSync(join(tmpdir(), 'kalyth-recorded-'))
  dirs.push(dir)
  const ledger = new BudgetLedger(':memory:')
  ledger.setCap(1_000_000, 'recording')
  ledger.setConsent(PROJECT, 'nebius', true, OWNER)
  const recorder = new ProviderGateway({
    provider: new RecordingProvider(new FakeNebius(), dir),
    ledger,
    roleModels: {},
  })
  expect((await generate(recorder, user, model, reasoning)).ok).toBe(true)
  return RecordedFirstProvider.readRecordings(dir)
}

describe('recorded answers first (ADR 0019)', () => {
  it('answers a recorded request with no reservation, no charge and no consent', async () => {
    const recordings = await recordingsFor('Say hello.')
    const live = new FakeNebius()
    const ledger = new BudgetLedger(':memory:') // no cap and no consent
    const gateway = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', recordings, live),
      ledger,
      roleModels: {},
    })
    const out = await generate(gateway, 'Say hello.')
    expect(out.ok).toBe(true)
    expect(out.calls).toMatchObject([
      { outcome: 'ok', recorded: true, costMicroUsd: 0, reservedMicroUsd: 0 },
    ])
    expect(live.calls).toBe(0)
    expect(ledger.status()).toMatchObject({ spentMicroUsd: 0, reservedMicroUsd: 0, calls: 0 })
  })

  it('sends anything else to the live provider, with consent, a reservation and a charge', async () => {
    const recordings = await recordingsFor('Say hello.')
    const live = new FakeNebius()
    const ledger = new BudgetLedger(':memory:')
    const gateway = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', recordings, live),
      ledger,
      roleModels: {},
    })
    const refused = await generate(gateway, 'Say goodbye.')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('unauthorized')

    ledger.setConsent(PROJECT, 'nebius', true, OWNER)
    const capped = await generate(gateway, 'Say goodbye.')
    if (!capped.ok) expect(capped.error.code).toBe('budget_exceeded')
    expect(live.calls).toBe(0)

    ledger.setCap(1_000_000, 'test cap')
    const out = await generate(gateway, 'Say goodbye.')
    expect(out.ok).toBe(true)
    expect(out.calls[0]?.recorded).toBeUndefined()
    expect(out.calls[0]?.costMicroUsd).toBeGreaterThan(0)
    expect(live.calls).toBe(1)
    expect(ledger.status().spentMicroUsd).toBe(out.calls[0]?.costMicroUsd)
  })

  it('without a live provider, refuses unrecorded requests and never reaches a network', async () => {
    const recordings = await recordingsFor('Say hello.')
    const provider = new RecordedFirstProvider('nebius', recordings, null)
    expect(provider).toMatchObject({ external: false, paid: false })
    const ledger = new BudgetLedger(':memory:')
    const gateway = new ProviderGateway({ provider, ledger, roleModels: {} })
    expect((await generate(gateway, 'Say hello.')).ok).toBe(true)
    const out = await generate(gateway, 'Say goodbye.')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe('budget_exceeded')

    // Even with a cap, there is nothing live to call.
    ledger.setCap(1_000_000, 'test cap')
    const again = await generate(gateway, 'Say goodbye.')
    expect(again.ok).toBe(false)
    expect(again.calls[0]?.issues.join(' ')).toMatch(/no recording/)
    expect(ledger.status().spentMicroUsd).toBe(0)
  })

  it('refuses a live provider that is not the source of the recordings', () => {
    const other: Provider = Object.assign(new FakeNebius(), { id: 'openrouter' })
    expect(() => new RecordedFirstProvider('nebius', [], other)).toThrow(/not nebius/)
  })
})

describe('a live model in place of the recorded one (ADR 0019, live runs on Super)', () => {
  const demoGateway = (recordings: Awaited<ReturnType<typeof recordingsFor>>, live: FakeNebius) => {
    const ledger = new BudgetLedger(':memory:')
    ledger.setCap(100_000, 'test')
    ledger.setConsent(PROJECT, 'nebius', true, OWNER)
    const gateway = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', recordings, live),
      ledger,
      roleModels: { alternatives: ULTRA },
      liveModels: { [ULTRA]: { model: SUPER, reasoning: false } },
    })
    return { gateway, ledger }
  }

  it('still answers an Ultra request from its Ultra recording, made with reasoning, free', async () => {
    const recordings = await recordingsFor('Say hello.', ULTRA, true)
    const live = new FakeNebius()
    const { gateway, ledger } = demoGateway(recordings, live)
    const out = await generate(gateway, 'Say hello.', ULTRA, true)
    expect(out.calls).toMatchObject([{ model: ULTRA, recorded: true, costMicroUsd: 0 }])
    expect(live.calls).toBe(0)
    expect(ledger.status().calls).toBe(0)
  })

  it('calls Super live, reasoning off, reserved and charged at Super prices', async () => {
    const live = new FakeNebius()
    const { gateway, ledger } = demoGateway([], live)
    const expected = gateway.liveReservationMicroUsd(request('Say something new.', ULTRA))
    const out = await generate(gateway, 'Say something new.', ULTRA, true)
    expect(out.ok).toBe(true)
    // The live model's own setting wins over the caller's: Super answers with reasoning off.
    expect(live.models).toEqual([SUPER])
    expect(live.reasoning).toEqual([false])
    // 1,000 input and 200 output tokens at 0.30 and 0.90 USD per million.
    expect(out.calls).toMatchObject([
      { model: SUPER, outcome: 'ok', reservedMicroUsd: expected, costMicroUsd: 480 },
    ])
    expect(ledger.status()).toMatchObject({ spentMicroUsd: 480, calls: 1 })
    expect(gateway.liveModelFor('alternatives')).toBe(SUPER)
  })

  it('sends the live budget and output cap, and prices the reservation on that cap', async () => {
    const live = new FakeNebius()
    const ledger = new BudgetLedger(':memory:')
    ledger.setCap(100_000, 'test')
    ledger.setConsent(PROJECT, 'nebius', true, OWNER)
    const bounded = {
      model: SUPER,
      reasoning: true,
      reasoningBudget: 8_000,
      maxOutputTokens: 14_000,
    }
    const gateway = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', [], live),
      ledger,
      roleModels: {},
      liveModels: { [ULTRA]: bounded },
      maxCorrections: 0,
    })
    const priced = gateway.liveReservationMicroUsd(request('Plan it.', ULTRA, true)) ?? 0
    const out = await generate(gateway, 'Plan it.', ULTRA, true)
    expect(out.ok).toBe(true)
    expect(live.requests).toMatchObject([
      { model: SUPER, reasoning: true, reasoningBudget: 8_000, maxOutputTokens: 14_000 },
    ])
    // The caller asked for 1,000 output tokens; the live cap of 14,000 is what is reserved.
    expect(out.calls).toMatchObject([{ reservedMicroUsd: priced }])
    const unbounded = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', [], new FakeNebius()),
      ledger: new BudgetLedger(':memory:'),
      roleModels: {},
      liveModels: { [ULTRA]: { model: SUPER } },
    })
    const onCallerCap = unbounded.liveReservationMicroUsd(request('Plan it.', ULTRA, true)) ?? 0
    // 13,000 more output tokens at 0.90 USD per million.
    expect(priced - onCallerCap).toBe(11_700)
  })

  it("keeps the caller's reasoning when the live model sets none", async () => {
    const live = new FakeNebius()
    const ledger = new BudgetLedger(':memory:')
    ledger.setCap(100_000, 'test')
    ledger.setConsent(PROJECT, 'nebius', true, OWNER)
    const gateway = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', [], live),
      ledger,
      roleModels: {},
      liveModels: { [ULTRA]: { model: SUPER } },
      maxCorrections: 0,
    })
    expect((await generate(gateway, 'Think first.', ULTRA, true)).ok).toBe(true)
    expect(live.reasoning).toEqual([true])
    expect(gateway.maxCorrections).toBe(0)
  })

  it('prices the worst case on the live model, without calling or reserving', () => {
    const live = new FakeNebius()
    const { gateway, ledger } = demoGateway([], live)
    const plain = new ProviderGateway({ provider: live, ledger, roleModels: {} })
    const onSuper = gateway.liveReservationMicroUsd(request('Hello.', ULTRA)) ?? 0
    const onUltra = plain.liveReservationMicroUsd(request('Hello.', ULTRA)) ?? 0
    expect(onSuper).toBeGreaterThan(0)
    expect(onSuper).toBeLessThan(onUltra / 3)
    expect(live.calls).toBe(0)
    expect(ledger.status().calls).toBe(0)
  })

  it('refuses a live model that is not in the catalogue', async () => {
    const live = new FakeNebius()
    const gateway = new ProviderGateway({
      provider: new RecordedFirstProvider('nebius', [], live),
      ledger: new BudgetLedger(':memory:'),
      roleModels: {},
      liveModels: { [ULTRA]: { model: 'nvidia/not-a-model' } },
    })
    const out = await generate(gateway, 'Hello.', ULTRA)
    expect(out).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(gateway.liveReservationMicroUsd(request('Hello.', ULTRA))).toBeNull()
    expect(live.calls).toBe(0)
  })
})
