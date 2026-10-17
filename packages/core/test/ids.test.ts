import { describe, expect, it } from 'vitest'
import { uuidv7Hex } from '../src/index.ts'

describe('UUIDv7 ids', () => {
  it('are strictly increasing within one millisecond and across a clock step back', () => {
    const now = Date.now()
    const ids = [
      ...Array.from({ length: 5000 }, () => uuidv7Hex(now)),
      uuidv7Hex(now - 10_000),
      uuidv7Hex(now + 1),
    ]
    for (let i = 1; i < ids.length; i++)
      expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
    }
  })
})
