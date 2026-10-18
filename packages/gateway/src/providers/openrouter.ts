import { type ChatRequest, type ChatResponse, type Provider, ProviderError } from '../provider.ts'
import { OpenAICompatibleClient } from './openai-compatible.ts'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
/** Public model metadata; read without the key. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export interface OpenRouterOptions {
  apiKey: string
  baseUrl?: string
  modelsUrl?: string
  /** Injected in tests so no request ever leaves the machine. */
  fetch?: typeof fetch
}

interface ModelInfo {
  id?: unknown
  pricing?: { prompt?: unknown; completion?: unknown; request?: unknown }
  supported_parameters?: unknown
}

/**
 * OpenRouter's free endpoints, for tests on public repositories and synthetic data only
 * (ADR 0016). Nebius stays the competition provider. Guards, on top of the gateway's catalogue,
 * consent and budget checks:
 *
 * - only `:free` model ids are sent;
 * - before the first call to a model, its public metadata must show it is free and supports
 *   structured outputs, or the call is refused without a request;
 * - routing must honour every request parameter (`require_parameters`), with no fallback;
 * - a reported charge above zero stops the provider for the rest of the process.
 *
 * Free endpoints may log prompts, so the consent text says so and people consent only for projects
 * built from public or synthetic content.
 */
export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter'
  readonly external = true
  readonly paid = false
  readonly #client: OpenAICompatibleClient
  readonly #modelsUrl: string
  readonly #fetch: typeof fetch
  #metadata: Promise<Map<string, ModelInfo>> | undefined
  #halted: string | null = null

  constructor(options: OpenRouterOptions) {
    this.#client = new OpenAICompatibleClient({
      label: 'OpenRouter',
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
      headers: { 'x-title': 'Kalyth', 'http-referer': 'https://github.com/Philipjj609/kalyth' },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    this.#modelsUrl = options.modelsUrl ?? OPENROUTER_MODELS_URL
    if (!this.#modelsUrl.startsWith('https://')) throw new Error('the models URL must use https')
    this.#fetch = options.fetch ?? fetch
  }

  async complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    // Refusals before any request carry a 4xx status, so the gateway releases the reservation.
    if (this.#halted) throw new ProviderError(this.#halted, 402)
    if (!request.model.endsWith(':free')) {
      throw new ProviderError(
        `only free OpenRouter models may be used; ${request.model} is not`,
        400,
      )
    }
    await this.#checkCapable(request.model, signal)
    const { response, body } = await this.#client.chat(
      request,
      {
        provider: { require_parameters: true, allow_fallbacks: false },
        usage: { include: true },
      },
      signal,
    )
    const cost = (body.usage as { cost?: unknown } | undefined)?.cost
    if (typeof cost === 'number' && cost > 0) {
      this.#halted = `OpenRouter reported a charge of ${cost} USD for ${request.model}, which should be free; the OpenRouter provider is stopped`
      // The call ran, so no status: the gateway records an unknown outcome.
      throw new ProviderError(this.#halted)
    }
    return response
  }

  /** The model must be listed as free, with structured outputs, in OpenRouter's public metadata. */
  async #checkCapable(model: string, signal: AbortSignal): Promise<void> {
    this.#metadata ??= this.#loadMetadata(signal)
    let models: Map<string, ModelInfo>
    try {
      models = await this.#metadata
    } catch (error) {
      this.#metadata = undefined
      throw error
    }
    const info = models.get(model)
    if (!info) throw new ProviderError(`OpenRouter does not list ${model}`, 400)
    const params = Array.isArray(info.supported_parameters) ? info.supported_parameters : []
    if (!params.includes('structured_outputs') || !params.includes('response_format')) {
      throw new ProviderError(`${model} does not support structured outputs on OpenRouter`, 400)
    }
    const prices = [info.pricing?.prompt, info.pricing?.completion, info.pricing?.request]
    if (prices.some((p) => p !== undefined && Number(p) !== 0)) {
      throw new ProviderError(`${model} is not free on OpenRouter`, 400)
    }
  }

  async #loadMetadata(signal: AbortSignal): Promise<Map<string, ModelInfo>> {
    let res: Response
    try {
      res = await this.#fetch(this.#modelsUrl, {
        headers: { accept: 'application/json' },
        signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new ProviderError(
        `could not read OpenRouter model metadata: ${(error as Error).message}`,
        424,
      )
    }
    // 424: no chat request was made, so the gateway treats it as a refusal, not an unknown outcome.
    if (!res.ok) throw new ProviderError(`OpenRouter model metadata answered ${res.status}`, 424)
    const data = (await res.json()) as { data?: ModelInfo[] }
    return new Map(
      (data.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [[m.id, m] as const] : [])),
    )
  }
}
