import type { ChatRequest, ChatResponse, Provider } from '../provider.ts'

/** Produces the response text for a request; may throw to simulate a provider failure. */
export type MockResponder = (request: ChatRequest) => string | Promise<string>

/**
 * Local, free and deterministic (ADR 0010). It never leaves the machine, so it needs no consent.
 * Usage is estimated at four bytes per token so the ledger has numbers to record.
 */
export class MockProvider implements Provider {
  readonly id = 'mock'
  readonly external = false
  readonly paid = false
  readonly #respond: MockResponder

  constructor(respond: MockResponder) {
    this.#respond = respond
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const content = await this.#respond(request)
    const bytes = request.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0)
    return {
      content,
      refusal: null,
      inputTokens: Math.ceil(bytes / 4),
      outputTokens: Math.ceil(Buffer.byteLength(content) / 4),
      finishReason: 'stop',
    }
  }
}
