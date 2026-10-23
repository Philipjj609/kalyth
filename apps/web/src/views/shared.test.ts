import { describe, expect, it } from 'vitest'
import { principalText } from './shared.tsx'

describe('naming who did what', () => {
  it('says "you" for the session’s own principal and the display name for others', () => {
    expect(principalText({ displayName: 'Local owner', you: true })).toBe('you')
    expect(principalText({ displayName: 'RC rehearsal agent', you: false })).toBe(
      'RC rehearsal agent',
    )
  })

  it('leaves an unknown principal to its short id', () => {
    expect(principalText(undefined)).toBeNull()
  })
})
