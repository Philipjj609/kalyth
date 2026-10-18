/**
 * Models the gateway may call, with prices in micro-dollars per million tokens. A model missing
 * here is refused, because its cost cannot be bounded. Prices come from third-party catalogues
 * that cite Nebius pages (Phase 0 review, section 9) and are confirmed by the keyed spike.
 */
export interface ModelSpec {
  id: string
  provider: string
  inputMicroUsdPerMTok: number
  outputMicroUsdPerMTok: number
  contextTokens: number
  /** Extra request fields that turn reasoning off; unverified until the spike. */
  reasoningOff?: Record<string, unknown>
  priceSource: string
  priceCheckedAt: string
}

const NEBIUS_PRICES = 'third-party catalogues citing Nebius pages; to confirm in the keyed spike'
const NEMOTRON_REASONING_OFF = { chat_template_kwargs: { enable_thinking: false } }

export const MODEL_CATALOG: readonly ModelSpec[] = [
  {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    provider: 'nebius',
    inputMicroUsdPerMTok: 300_000,
    outputMicroUsdPerMTok: 900_000,
    contextTokens: 262_144,
    reasoningOff: NEMOTRON_REASONING_OFF,
    priceSource: NEBIUS_PRICES,
    priceCheckedAt: '2026-10-16',
  },
  {
    id: 'nvidia/Nemotron-3-Ultra-550b-a55b',
    provider: 'nebius',
    inputMicroUsdPerMTok: 1_000_000,
    outputMicroUsdPerMTok: 3_000_000,
    contextTokens: 1_048_576,
    reasoningOff: NEMOTRON_REASONING_OFF,
    priceSource: NEBIUS_PRICES,
    priceCheckedAt: '2026-10-16',
  },
  {
    id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    provider: 'nebius',
    inputMicroUsdPerMTok: 60_000,
    outputMicroUsdPerMTok: 240_000,
    contextTokens: 262_144,
    reasoningOff: NEMOTRON_REASONING_OFF,
    priceSource: NEBIUS_PRICES,
    priceCheckedAt: '2026-10-16',
  },
  {
    // OpenRouter's free endpoint, for public and synthetic tests only (ADR 0016). The free Ultra
    // endpoint lacks structured outputs, so Super serves every role there.
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    provider: 'openrouter',
    inputMicroUsdPerMTok: 0,
    outputMicroUsdPerMTok: 0,
    contextTokens: 262_144,
    reasoningOff: { reasoning: { enabled: false } },
    priceSource:
      'OpenRouter public model list (free variant); a reported charge stops the provider',
    priceCheckedAt: '2026-10-18',
  },
  {
    id: 'mock',
    provider: 'mock',
    inputMicroUsdPerMTok: 0,
    outputMicroUsdPerMTok: 0,
    contextTokens: 1_048_576,
    priceSource: 'local mock, free',
    priceCheckedAt: '2026-10-16',
  },
]

/** Which model each Navigator role uses per provider. */
export const DEFAULT_ROLE_MODELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  nebius: {
    summarize: 'nvidia/nemotron-3-super-120b-a12b',
    alternatives: 'nvidia/Nemotron-3-Ultra-550b-a55b',
    /** One model for both evaluation conditions (ADR 0012). */
    evaluate: 'nvidia/nemotron-3-super-120b-a12b',
  },
  openrouter: {
    summarize: 'nvidia/nemotron-3-super-120b-a12b:free',
    alternatives: 'nvidia/nemotron-3-super-120b-a12b:free',
    evaluate: 'nvidia/nemotron-3-super-120b-a12b:free',
  },
  mock: { summarize: 'mock', alternatives: 'mock', evaluate: 'mock' },
}

export function findModel(
  id: string,
  catalog: readonly ModelSpec[] = MODEL_CATALOG,
): ModelSpec | undefined {
  return catalog.find((m) => m.id === id)
}

/** Fixed allowance for chat-template tokens around the messages. */
const TEMPLATE_TOKENS = 64
const PER_MESSAGE_TOKENS = 16

/**
 * An upper bound on a call's cost before it is made (ADR 0010). Byte-level tokenisers emit at
 * most one token per byte, so prompt bytes bound input tokens; output is bounded by the request.
 */
export function reservationMicroUsd(
  spec: ModelSpec,
  messages: readonly { content: string }[],
  maxOutputTokens: number,
): number {
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0)
  const inputTokens = bytes + TEMPLATE_TOKENS + PER_MESSAGE_TOKENS * messages.length
  return costMicroUsd(spec, inputTokens, maxOutputTokens)
}

export function costMicroUsd(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * spec.inputMicroUsdPerMTok + outputTokens * spec.outputMicroUsdPerMTok) /
      1_000_000,
  )
}
