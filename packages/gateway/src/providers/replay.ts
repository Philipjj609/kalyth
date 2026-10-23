import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '@kalyth/contracts'
import { type ChatRequest, type ChatResponse, type Provider, ProviderError } from '../provider.ts'

/** A recorded exchange. The key is a hash of everything that shapes the response. */
export interface Recording {
  key: string
  provider: string
  model: string
  recordedAt: string
  response: ChatResponse
}

export function requestKey(provider: string, request: ChatRequest): string {
  return createHash('sha256')
    .update(canonicalJson({ provider, ...request }))
    .digest('hex')
}

/**
 * Answers only requests it has a recording for, so tests and the disclosed replay mode are
 * deterministic and free. Recorded answers take the gateway's recorded path: no reservation, no
 * charge, no cap needed. An unrecorded request fails instead of reaching a real provider.
 */
export class ReplayProvider implements Provider {
  readonly id: string
  readonly external = false
  readonly paid = false
  readonly replayOnly = true
  readonly #source: string
  readonly #recordings: Map<string, Recording>

  /** `source` is the provider the recordings came from; it is part of every key. */
  constructor(source: string, recordings: Iterable<Recording>) {
    this.id = `replay:${source}`
    this.#source = source
    this.#recordings = new Map([...recordings].map((r) => [r.key, r]))
  }

  static fromDirectory(source: string, dir: string): ReplayProvider {
    const index = join(dir, 'recordings.json')
    const recordings = existsSync(index)
      ? (JSON.parse(readFileSync(index, 'utf8')) as Recording[])
      : []
    return new ReplayProvider(source, recordings)
  }

  recorded(request: ChatRequest): ChatResponse | undefined {
    return this.#recordings.get(requestKey(this.#source, request))?.response
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const found = this.recorded(request)
    if (!found) throw new ProviderError('no recording for this request', 404)
    return found
  }
}

/**
 * The hosted demo's provider (ADR 0019): a request recorded earlier is answered from its recording,
 * which the gateway neither reserves nor charges; anything else goes to the live provider, under
 * the caps. Without a live provider, unrecorded requests are refused by the caps (a ledger with a
 * zero cap) before this provider is called, and by this provider if they ever reach it.
 */
export class RecordedFirstProvider implements Provider {
  readonly id: string
  readonly external: boolean
  readonly paid: boolean
  readonly #source: string
  readonly #recordings: Map<string, Recording>
  readonly #live: Provider | null

  /** `source` is the provider the recordings came from; it is part of every key. */
  constructor(source: string, recordings: Iterable<Recording>, live: Provider | null) {
    if (live && live.id !== source) throw new Error(`live provider ${live.id} is not ${source}`)
    this.id = source
    this.#source = source
    this.#recordings = new Map([...recordings].map((r) => [r.key, r]))
    this.#live = live
    this.external = live?.external ?? false
    this.paid = live?.paid ?? false
  }

  static readRecordings(dir: string): Recording[] {
    const index = join(dir, 'recordings.json')
    return existsSync(index) ? (JSON.parse(readFileSync(index, 'utf8')) as Recording[]) : []
  }

  recorded(request: ChatRequest): ChatResponse | undefined {
    return this.#recordings.get(requestKey(this.#source, request))?.response
  }

  async complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    if (!this.#live) {
      throw new ProviderError('there is no recording of this request, and live runs are off', 409)
    }
    return this.#live.complete(request, signal)
  }
}

/** Wraps a provider and saves each successful exchange for later replay. */
export class RecordingProvider implements Provider {
  readonly id: string
  readonly external: boolean
  readonly paid: boolean
  readonly #inner: Provider
  readonly #dir: string

  constructor(inner: Provider, dir: string) {
    this.#inner = inner
    this.#dir = dir
    this.id = inner.id
    this.external = inner.external
    this.paid = inner.paid
  }

  async complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const response = await this.#inner.complete(request, signal)
    mkdirSync(this.#dir, { recursive: true })
    const index = join(this.#dir, 'recordings.json')
    const existing = existsSync(index)
      ? (JSON.parse(readFileSync(index, 'utf8')) as Recording[])
      : []
    const key = requestKey(this.#inner.id, request)
    const recording: Recording = {
      key,
      provider: this.#inner.id,
      model: request.model,
      recordedAt: new Date().toISOString(),
      response,
    }
    const next = [...existing.filter((r) => r.key !== key), recording]
    writeFileSync(index, `${JSON.stringify(next, null, 2)}\n`)
    return response
  }
}
