import { findModel } from '../catalog.ts'
import { type ChatRequest, type ChatResponse, ProviderError } from '../provider.ts'

export interface OpenAICompatibleOptions {
  /** Name used in error text, e.g. "OpenRouter". */
  label: string
  apiKey: string
  baseUrl: string
  /** Extra request headers. Never secrets: the key goes only in Authorization. */
  headers?: Record<string, string>
  /** Injected in tests so no request ever leaves the machine. */
  fetch?: typeof fetch
}

export interface ChatCompletion {
  response: ChatResponse
  /** The parsed response body, for provider-specific fields such as usage.cost. */
  body: Record<string, unknown>
}

/**
 * A client for OpenAI-compatible chat completions with a strict JSON schema (ADR 0010, 0016).
 * Providers wrap it; none of them builds requests of its own. The key is held only here: it is
 * sent in the Authorization header and scrubbed from any error text, requests use https only, and
 * redirects are refused so the key cannot follow one.
 */
export class OpenAICompatibleClient {
  readonly #label: string
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #headers: Record<string, string>
  readonly #fetch: typeof fetch

  constructor(options: OpenAICompatibleOptions) {
    if (options.apiKey.trim().length < 8)
      throw new Error(`the ${options.label} API key looks empty`)
    this.#label = options.label
    this.#apiKey = options.apiKey.trim()
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    if (!this.#baseUrl.startsWith('https://')) {
      throw new Error(`the ${options.label} base URL must use https`)
    }
    this.#headers = options.headers ?? {}
    this.#fetch = options.fetch ?? fetch
  }

  async chat(
    request: ChatRequest,
    extraBody: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
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
      ...extraBody,
    }
    let res: Response
    try {
      res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.#headers,
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new ProviderError(this.scrub(`request failed: ${(error as Error).message}`))
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      throw new ProviderError(
        this.scrub(`${this.#label} answered ${res.status}: ${text.slice(0, 500)}`),
        res.status,
      )
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ProviderError(`${this.#label} returned a body that is not JSON`)
    }
    const choices = data.choices as
      | { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]
      | undefined
    const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    const choice = choices?.[0]
    const refusal = choice?.message?.refusal
    return {
      response: {
        content: choice?.message?.content ?? '',
        refusal: refusal ? this.scrub(refusal.slice(0, 500)) : null,
        inputTokens: whole(usage?.prompt_tokens),
        outputTokens: whole(usage?.completion_tokens),
        finishReason: choice?.finish_reason ?? null,
      },
      body: data,
    }
  }

  scrub(message: string): string {
    return message.split(this.#apiKey).join('[redacted]')
  }
}

const whole = (n: unknown): number | null =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
