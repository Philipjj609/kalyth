import { describe, expect, it } from 'vitest'
import { edgeAnchors, PARALLEL_GAP } from './geometry.ts'

const box = (x: number, y: number) => ({ x, y, width: 100, height: 40 })

describe('edgeAnchors', () => {
  it('uses bottom-to-top sides for vertically separated nodes', () => {
    const a = edgeAnchors(box(0, 0), box(0, 200))
    expect(a).toMatchObject({
      sx: 50,
      sy: 40,
      tx: 50,
      ty: 200,
      sourceSide: 'bottom',
      targetSide: 'top',
    })
    const up = edgeAnchors(box(0, 200), box(0, 0))
    expect(up).toMatchObject({ sy: 200, ty: 40, sourceSide: 'top', targetSide: 'bottom' })
  })

  it('uses facing left and right sides for nodes side by side', () => {
    const a = edgeAnchors(box(0, 0), box(300, 10))
    expect(a).toMatchObject({ sx: 100, tx: 300, sourceSide: 'right', targetSide: 'left' })
    const b = edgeAnchors(box(300, 10), box(0, 0))
    expect(b).toMatchObject({ sx: 300, tx: 100, sourceSide: 'left', targetSide: 'right' })
  })

  it('spreads parallel edges symmetrically', () => {
    const first = edgeAnchors(box(0, 0), box(0, 200), 0, 2)
    const second = edgeAnchors(box(0, 0), box(0, 200), 1, 2)
    expect(first.sx).toBe(50 - PARALLEL_GAP / 2)
    expect(second.sx).toBe(50 + PARALLEL_GAP / 2)
  })
})
