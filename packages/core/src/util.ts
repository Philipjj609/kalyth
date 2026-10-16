import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson, ID_PREFIX, type IdKind } from '@kalyth/contracts'

/** 32 hex digits of a UUIDv7: 48-bit millisecond timestamp, version 7, variant 10, random rest. */
export function uuidv7Hex(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16)
  let ms = BigInt(nowMs)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn)
    ms >>= 8n
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
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
