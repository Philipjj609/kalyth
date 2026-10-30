import { describe, expect, it } from 'vitest'
import { attention, groupRelations, readAsLines, testText, VERDICT_META } from './knowledge.ts'

describe('knowledge wording (K5)', () => {
  it('never words a verdict as advice', () => {
    for (const meta of Object.values(VERDICT_META)) {
      expect(meta.label).not.toMatch(/recommend|applies|use this|best|safe/i)
    }
    expect(VERDICT_META.conditionsMet.description).toMatch(/Not a recommendation/)
  })

  it('writes condition tests in words', () => {
    expect(testText({ op: 'le', value: '8', unit: '1' })).toBe('≤ 8')
    expect(testText({ op: 'gt', value: '250', unit: 'ms' })).toBe('> 250 ms')
    expect(testText({ op: 'is', value: false })).toBe('is false')
    expect(testText({ op: 'in', values: ['rts', 'solo'] })).toBe('is one of rts, solo')
  })

  it('groups relations into trade-offs, conditions and structure', () => {
    const r = (type: string) => ({
      id: type,
      type,
      direction: 'out' as const,
      other: { id: 'o', type: 'knowledge.Concept', name: 'x' },
      properties: {},
    })
    const g = groupRelations([r('affects'), r('appliesWhen'), r('refines'), r('concerns')])
    expect([g.tradeoffs.length, g.conditions.length, g.structure.length, g.other.length]).toEqual([
      1, 1, 1, 1,
    ])
  })

  it('puts staleness, missing support and conflicts first', () => {
    const lines = readAsLines({
      recommendation: false,
      current: false,
      supported: false,
      resolved: true,
      note: '',
    })
    expect(lines.map((l) => l.text).join(' ')).toMatch(
      /Stale.*Not established.*Not a recommendation/,
    )
    const notes = attention({
      verdict: 'unknown',
      explanation: {
        specification: 'underspecified',
        missing: [{ concept: 'c', conceptName: 'n', scenario: 's', nature: 'expected' }],
        conflict: { state: 'settled', note: '' },
        knowledge: { maturity: 'proposed', disputed: true },
        scenario: { id: 's', status: 'planned', rationale: 'roadmap' },
      } as never,
    })
    expect(notes).toHaveLength(6)
    expect(notes.join(' ')).toMatch(/disagreement remains/)
  })
})

describe('relation grouping direction', () => {
  it('files an incoming requires under structure, not under the item’s own conditions', () => {
    const r = {
      id: 'r',
      type: 'requires',
      direction: 'in' as const,
      other: { id: 'o', type: 'knowledge.Pattern', name: 'x' },
      properties: {},
    }
    expect(groupRelations([r]).conditions).toHaveLength(0)
    expect(groupRelations([{ ...r, direction: 'out' }]).conditions).toHaveLength(1)
  })
})
