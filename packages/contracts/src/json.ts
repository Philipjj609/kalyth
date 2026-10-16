import { z } from 'zod'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const Json = z.json()
export const JsonRecord = z.record(z.string(), z.json())

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, undefined members dropped.
 * Used for hashing, idempotency comparison and the UI/MCP parity guarantee.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member !== undefined) out[key] = sortKeys(member)
    }
    return out
  }
  return value
}
