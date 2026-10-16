/**
 * Floating-edge anchors: an edge leaves the side of its source that faces the target and enters
 * the facing side of the target, so edges stay short whichever level of the layout their ends are
 * in. Parallel edges between the same two nodes are spread along the sides.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Anchors {
  sx: number
  sy: number
  tx: number
  ty: number
  sourceSide: Side
  targetSide: Side
}

/** Gap between parallel edges, in canvas pixels. */
export const PARALLEL_GAP = 12

export function edgeAnchors(
  source: Rect,
  target: Rect,
  parallelIndex = 0,
  parallelCount = 1,
): Anchors {
  const scx = source.x + source.width / 2
  const scy = source.y + source.height / 2
  const tcx = target.x + target.width / 2
  const tcy = target.y + target.height / 2
  const dx = tcx - scx
  const dy = tcy - scy

  // Prefer vertical sides when the vertical separation clears the boxes.
  const verticalGap = Math.abs(dy) - (source.height + target.height) / 2
  const horizontalGap = Math.abs(dx) - (source.width + target.width) / 2
  const vertical = verticalGap > 0 && (verticalGap >= horizontalGap || horizontalGap < 24)

  const offset = (parallelIndex - (parallelCount - 1) / 2) * PARALLEL_GAP
  if (vertical) {
    const down = dy > 0
    return {
      sx: scx + offset,
      sy: down ? source.y + source.height : source.y,
      tx: tcx + offset,
      ty: down ? target.y : target.y + target.height,
      sourceSide: down ? 'bottom' : 'top',
      targetSide: down ? 'top' : 'bottom',
    }
  }
  const right = dx > 0
  return {
    sx: right ? source.x + source.width : source.x,
    sy: scy + offset,
    tx: right ? target.x : target.x + target.width,
    ty: tcy + offset,
    sourceSide: right ? 'right' : 'left',
    targetSide: right ? 'left' : 'right',
  }
}
