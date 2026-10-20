import { describe, expect, it } from 'vitest'
import {
  edgeAnchors,
  MAX_FIT_ZOOM,
  MIN_READABLE_ZOOM,
  orthogonalRoute,
  PARALLEL_GAP,
  readableViewport,
  routedAnchors,
} from './geometry.ts'

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

describe('routedAnchors', () => {
  it('follows the block direction even when the nodes are offset', () => {
    const down = routedAnchors(box(0, 0), box(400, 100), true)
    expect(down).toMatchObject({ sx: 50, sy: 40, tx: 450, ty: 100, sourceSide: 'bottom' })
    const right = routedAnchors(box(0, 0), box(200, 300), false)
    expect(right).toMatchObject({ sx: 100, sy: 20, tx: 200, ty: 320, sourceSide: 'right' })
  })
})

describe('orthogonalRoute', () => {
  it('is a straight line when start, lanes and end are aligned', () => {
    const r = orthogonalRoute({ x: 10, y: 0 }, [{ x: 10, y: 50 }], { x: 10, y: 100 }, true)
    expect(r.path).toBe('M 10 0 L 10 100')
    expect(r.label).toEqual({ x: 10, y: 50 })
  })

  it('turns halfway between ranks and runs down each lane', () => {
    const r = orthogonalRoute({ x: 0, y: 0 }, [{ x: 100, y: 100 }], { x: 100, y: 200 }, true, 0)
    expect(r.path).toBe('M 0 0 L 0 50 Q 0 50 0 50 L 100 50 Q 100 50 100 50 L 100 200')
    expect(r.label).toEqual({ x: 100, y: 125 })
  })

  it('works across for a left-to-right block', () => {
    const r = orthogonalRoute({ x: 0, y: 0 }, [], { x: 100, y: 40 }, false, 0)
    expect(r.path).toBe('M 0 0 L 50 0 Q 50 0 50 0 L 50 40 Q 50 40 50 40 L 100 40')
  })
})

describe('readableViewport', () => {
  const insets = { top: 0, right: 0, bottom: 0, left: 0 }

  it('centres a drawing that fits, without zooming past the cap', () => {
    const vp = readableViewport({ x: 0, y: 0, width: 100, height: 100 }, 1000, 800, insets)
    expect(vp.zoom).toBe(MAX_FIT_ZOOM)
    expect(vp.x).toBeCloseTo((1000 - 100 * MAX_FIT_ZOOM) / 2)
    expect(vp.y).toBeCloseTo((800 - 100 * MAX_FIT_ZOOM) / 2)
  })

  it('shows the top-left of a large drawing at the smallest readable zoom', () => {
    const vp = readableViewport({ x: 20, y: 30, width: 5000, height: 4000 }, 1000, 800, insets)
    expect(vp.zoom).toBe(MIN_READABLE_ZOOM)
    expect(vp.x).toBeCloseTo(-20 * MIN_READABLE_ZOOM)
    expect(vp.y).toBeCloseTo(-30 * MIN_READABLE_ZOOM)
  })

  it('fits the whole drawing when asked to go below the readable zoom', () => {
    const vp = readableViewport({ x: 0, y: 0, width: 5000, height: 4000 }, 1000, 800, insets, 0.1)
    expect(vp.zoom).toBeCloseTo(0.2)
  })
})
