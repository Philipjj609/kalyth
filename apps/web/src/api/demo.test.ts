import { describe, expect, it } from 'vitest'
import { type DemoView, liveRunState, modelName } from './demo.ts'

const view = (live: Partial<DemoView['live']>): DemoView => ({
  projectId: 'prj_0199f0a0000070008000000000000001',
  judge: false,
  judgeCodeAvailable: true,
  live: {
    available: true,
    pool: 'public',
    runsLeftToday: 3,
    runsPerDay: 3,
    poolRemainingTodayMicroUsd: 70_000,
    runReserveMicroUsd: 27_500,
    model: 'nvidia/nemotron-3-super-120b-a12b',
    ...live,
  },
  presets: [],
  mcp: false,
})

describe('live runs in the hosted demo (ADR 0019, live runs on Super)', () => {
  it('offers a live run only when the pool has its worst case left', () => {
    expect(liveRunState(view({})).ok).toBe(true)
    expect(liveRunState(view({ poolRemainingTodayMicroUsd: 27_500 })).ok).toBe(true)
    const short = liveRunState(view({ poolRemainingTodayMicroUsd: 27_499 }))
    expect(short).toMatchObject({ ok: false, reason: expect.stringMatching(/public allowance/) })
    const judges = liveRunState(view({ pool: 'judges', poolRemainingTodayMicroUsd: 20_000 }))
    expect(judges).toMatchObject({ ok: false, reason: expect.stringMatching(/judges/) })
  })

  it('says why no live run is offered: off, used runs or used allowance', () => {
    expect(liveRunState(view({ available: false })).reason).toMatch(/off/)
    expect(liveRunState(view({ runsLeftToday: 0 })).reason).toMatch(/used today’s 3 live runs/)
    expect(liveRunState(view({ runReserveMicroUsd: 0, poolRemainingTodayMicroUsd: 0 })).ok).toBe(
      false,
    )
  })

  it('names Nemotron models as people say them', () => {
    expect(modelName('nvidia/nemotron-3-super-120b-a12b')).toBe('Nemotron 3 Super')
    expect(modelName('nvidia/Nemotron-3-Ultra-550b-a55b')).toBe('Nemotron 3 Ultra')
    expect(modelName('mock')).toBe('mock')
    expect(modelName(null)).toBe('Nemotron')
  })
})
