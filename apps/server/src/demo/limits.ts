import { isIPv6 } from 'node:net'

/** UTC calendar day of an instant, e.g. "2026-12-01". */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10)

/**
 * The key per-address limits count under. An IPv4 address is its own key. An IPv6 address counts
 * by its /64 prefix, the block one household or server is usually given, so rotating through the
 * addresses of one block does not escape the limits. IPv4-mapped IPv6 addresses count as IPv4.
 */
export function addressKey(ip: string): string {
  const address = ip.trim().replace(/%.*$/, '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped?.[1]) return mapped[1]
  if (!isIPv6(address)) return address
  const prefix = ipv6Groups(address)
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
  return `${prefix.join(':')}::/64`
}

/** The eight 16-bit groups of a valid IPv6 address, as hex text. */
function ipv6Groups(address: string): string[] {
  let text = address
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  if (tail === undefined) return left
  const right = tail ? tail.split(':') : []
  return [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
}

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

/**
 * Bytes sent per key (a client address) per UTC day, each key against the same daily limit, so
 * one address cannot use up the traffic every visitor shares. The table empties each UTC day.
 */
export class DailyBudgets {
  readonly #limit: number
  readonly #clock: () => Date
  readonly #sent = new Map<string, number>()
  #day = ''

  constructor(limitBytes: number, clock: () => Date = () => new Date()) {
    this.#limit = limitBytes
    this.#clock = clock
  }

  add(key: string, bytes: number): void {
    this.#roll()
    this.#sent.set(key, (this.#sent.get(key) ?? 0) + bytes)
  }

  exceeded(key: string): boolean {
    this.#roll()
    return (this.#sent.get(key) ?? 0) >= this.#limit
  }

  #roll(): void {
    const day = utcDay(this.#clock())
    if (day !== this.#day) {
      this.#day = day
      this.#sent.clear()
    }
  }
}
