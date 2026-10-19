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
const Answer = z.strictObject({ answer: z.string() })

/** A stand-in for Nebius: external, paid, and counting its calls. */
class FakeNebius implements Provider {
  readonly id = 'nebius'
  readonly external = true
  readonly paid = true
  calls = 0
  async complete(_request: ChatRequest): Promise<ChatResponse> {
    this.calls++
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

const generate = (gateway: ProviderGateway, user: string) =>
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

/** Records one exchange for `user`, the way the demo's recording session does. */
async function recordingsFor(user: string) {
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
  expect((await generate(recorder, user)).ok).toBe(true)
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
