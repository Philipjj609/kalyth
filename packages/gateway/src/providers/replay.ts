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
 * deterministic and free. An unrecorded request fails instead of reaching a real provider.
 */
export class ReplayProvider implements Provider {
  readonly id: string
  readonly external = false
  readonly paid = false
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

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const found = this.#recordings.get(requestKey(this.#source, request))
    if (!found) throw new ProviderError('no recording for this request', 404)
    return found.response
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
