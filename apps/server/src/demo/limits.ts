/** UTC calendar day of an instant, e.g. "2026-12-01". */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10)

/**
 * Counts events per key in a sliding window and refuses past the limit. In memory: a restart
 * forgets the counts, which is acceptable for request-rate limits (ADR 0019).
 */
export class RateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #clock: () => number
  readonly #hits = new Map<string, number[]>()

  constructor(limit: number, windowMs: number, clock: () => number = Date.now) {
    this.#limit = limit
    this.#windowMs = windowMs
    this.#clock = clock
  }

  /** Records one event for `key` unless the limit is reached; true when it was allowed. */
  take(key: string): boolean {
    const now = this.#clock()
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs)
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.#hits.set(key, recent)
    return true
  }

  /** Forgets keys with no event in the window, so the table stays small. */
  prune(): void {
    const now = this.#clock()
    for (const [key, hits] of this.#hits) {
      if (hits.every((t) => now - t >= this.#windowMs)) this.#hits.delete(key)
    }
  }
}

/**
 * Bytes sent per UTC day, against a daily limit. Fly.io bills outbound traffic and cannot cap it,
 * so the demo stops serving once the day's limit is reached (ADR 0019, billing controls).
 */
export class DailyMeter {
  readonly #limit: number
  readonly #clock: () => Date
  #day = ''
  #sent = 0

  constructor(limitBytes: number, clock: () => Date = () => new Date()) {
    this.#limit = limitBytes
    this.#clock = clock
  }

  add(bytes: number): void {
    this.#roll()
    this.#sent += bytes
  }

  exceeded(): boolean {
    this.#roll()
    return this.#sent >= this.#limit
  }

  sentToday(): number {
    this.#roll()
    return this.#sent
  }

  #roll(): void {
    const day = utcDay(this.#clock())
    if (day !== this.#day) {
      this.#day = day
      this.#sent = 0
    }
  }
}
