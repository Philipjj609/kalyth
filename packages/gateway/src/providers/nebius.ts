import { findModel } from '../catalog.ts'
import { type ChatRequest, type ChatResponse, type Provider, ProviderError } from '../provider.ts'

export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1'

export interface NebiusOptions {
  apiKey: string
  baseUrl?: string
  /** Injected in tests so no request ever leaves the machine. */
  fetch?: typeof fetch
}

/**
 * Nebius Token Factory through its OpenAI-compatible chat completions API (ADR 0010). The key is
 * held only here; it is sent in the Authorization header and scrubbed from any error text.
 */
export class NebiusProvider implements Provider {
  readonly id = 'nebius'
  readonly external = true
  readonly paid = true
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: NebiusOptions) {
    if (options.apiKey.trim().length < 8) throw new Error('the Nebius API key looks empty')
    this.#apiKey = options.apiKey.trim()
    this.#baseUrl = (options.baseUrl ?? NEBIUS_BASE_URL).replace(/\/+$/, '')
    if (!this.#baseUrl.startsWith('https://')) throw new Error('the Nebius base URL must use https')
    this.#fetch = options.fetch ?? fetch
  }

  async complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.responseSchema.name,
          schema: request.responseSchema.schema,
          strict: true,
        },
      },
      ...(request.reasoning ? {} : (findModel(request.model)?.reasoningOff ?? {})),
    }
    let res: Response
    try {
      res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new ProviderError(this.#scrub(`request failed: ${(error as Error).message}`))
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      throw new ProviderError(
        this.#scrub(`provider answered ${res.status}: ${text.slice(0, 500)}`),
        res.status,
      )
    }
    let data: {
      choices?: {
        message?: { content?: string | null; refusal?: string | null }
        finish_reason?: string
      }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      data = JSON.parse(text)
    } catch {
      throw new ProviderError('provider returned a body that is not JSON')
    }
    const choice = data.choices?.[0]
    const refusal = choice?.message?.refusal
    return {
      content: choice?.message?.content ?? '',
      refusal: refusal ? this.#scrub(refusal.slice(0, 500)) : null,
      inputTokens: whole(data.usage?.prompt_tokens),
      outputTokens: whole(data.usage?.completion_tokens),
      finishReason: choice?.finish_reason ?? null,
    }
  }

  #scrub(message: string): string {
    return message.split(this.#apiKey).join('[redacted]')
  }
}

const whole = (n: unknown): number | null =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
