import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson, ID_PREFIX, type IdKind } from '@kalyth/contracts'

let lastMs = -1
let counter = 0

/**
 * 32 hex digits of a UUIDv7: 48-bit millisecond timestamp, version 7, a 12-bit counter, variant
 * 10, random rest. Ids from one process are strictly increasing (RFC 9562, method 1): within a
 * millisecond the counter increments, and a clock that steps back does not reorder them.
 */
export function uuidv7Hex(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16)
  let ms = nowMs
  if (ms <= lastMs) {
    ms = lastMs
    counter++
    if (counter > 0xfff) {
      ms = lastMs + 1
      counter = 0
    }
  } else {
    // A random start in the lower half leaves room to count within the millisecond.
    counter = (bytes[7] ?? 0) & 0x7f
  }
  lastMs = ms
  let t = BigInt(ms)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn)
    t >>= 8n
  }
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
  bytes[7] = counter & 0xff
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return bytes.toString('hex')
}

export type IdGenerator = (kind: IdKind) => string
export const defaultIdGenerator: IdGenerator = (kind) => `${ID_PREFIX[kind]}_${uuidv7Hex()}`

export type Clock = () => string
export const systemClock: Clock = () => new Date().toISOString()

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

export const hashCanonical = (value: unknown): string => sha256Hex(canonicalJson(value))

/** Test hook for transactional fault injection (gate test: no orphan event on failure). */
export type FaultPoint = 'afterVersionWrites' | 'afterEventInsert' | 'beforeHeadUpdate'
export type FaultInjector = (point: FaultPoint) => void
