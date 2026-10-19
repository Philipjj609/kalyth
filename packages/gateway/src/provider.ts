/** Provider-neutral chat request. Only the gateway builds these (ADR 0010). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  maxOutputTokens: number
  temperature: number
  /** JSON Schema the output must follow; providers that support it enforce it while decoding. */
  responseSchema: { name: string; schema: Record<string, unknown> }
  /** Whether the model should reason before answering, where the model supports a switch. */
  reasoning: boolean
}

export interface ChatResponse {
  content: string
  /** The model declined to answer; the call still completed and is charged. */
  refusal: string | null
  /** Token usage as the provider reports it; null when it does not. */
  inputTokens: number | null
  outputTokens: number | null
  finishReason: string | null
}

export interface Provider {
  readonly id: string
  /** Sends project content off this machine, so each project needs consent. */
  readonly external: boolean
  /** Calls may cost money. */
  readonly paid: boolean
  complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse>
  /**
   * An answer recorded earlier for exactly this request, if the provider has one. The gateway uses
   * it without a reservation or a charge, and marks the call as recorded (ADR 0019).
   */
  recorded?(request: ChatRequest): ChatResponse | undefined
}

/**
 * A failed provider call. `status` is the HTTP status when the provider answered with an error;
 * without one (network failure, timeout) the request may have been processed, so its cost is kept.
 */
export class ProviderError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}
