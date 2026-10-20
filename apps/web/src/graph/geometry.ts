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

/**
 * The smallest zoom at which node labels stay readable: 13 px labels render at about 11 px, and
 * the 10 px type tags at about 8.5 px.
 */
export const MIN_READABLE_ZOOM = 0.85
export const MAX_FIT_ZOOM = 1.2

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * A viewport that shows `content` in a `width` x `height` pane: the whole of it when that fits
 * at a readable zoom, centred; otherwise its top-left corner at the smallest readable zoom, so
 * reading starts where the layout starts (systems and containers are at the top).
 */
export function readableViewport(
  content: Rect,
  width: number,
  height: number,
  insets: Insets = { top: 24, right: 24, bottom: 24, left: 24 },
  minZoom = MIN_READABLE_ZOOM,
  maxZoom = MAX_FIT_ZOOM,
): Viewport {
  const availW = Math.max(1, width - insets.left - insets.right)
  const availH = Math.max(1, height - insets.top - insets.bottom)
  const fit = Math.min(availW / Math.max(1, content.width), availH / Math.max(1, content.height))
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit))
  const drawnW = content.width * zoom
  const drawnH = content.height * zoom
  const x =
    drawnW <= availW
      ? insets.left + (availW - drawnW) / 2 - content.x * zoom
      : insets.left - content.x * zoom
  const y =
    drawnH <= availH
      ? insets.top + (availH - drawnH) / 2 - content.y * zoom
      : insets.top - content.y * zoom
  return { x, y, zoom }
}

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

export interface Point {
  x: number
  y: number
}

/**
 * Anchors for an edge between two nodes laid out in one dagre block: on the sides facing along
 * the block's direction (top and bottom for a top-to-bottom block), spread for parallel edges.
 */
export function routedAnchors(
  source: Rect,
  target: Rect,
  vertical: boolean,
  parallelIndex = 0,
  parallelCount = 1,
): Anchors {
  const offset = (parallelIndex - (parallelCount - 1) / 2) * PARALLEL_GAP
  const scx = source.x + source.width / 2
  const scy = source.y + source.height / 2
  const tcx = target.x + target.width / 2
  const tcy = target.y + target.height / 2
  if (vertical) {
    const down = tcy >= scy
    return {
      sx: scx + offset,
      sy: down ? source.y + source.height : source.y,
      tx: tcx + offset,
      ty: down ? target.y : target.y + target.height,
      sourceSide: down ? 'bottom' : 'top',
      targetSide: down ? 'top' : 'bottom',
    }
  }
  const right = tcx >= scx
  return {
    sx: right ? source.x + source.width : source.x,
    sy: scy + offset,
    tx: right ? target.x : target.x + target.width,
    ty: tcy + offset,
    sourceSide: right ? 'right' : 'left',
    targetSide: right ? 'left' : 'right',
  }
}

/**
 * An orthogonal path from `start` to `end` through the lanes dagre reserved for the edge
 * (`lanes`: one point per rank it crosses). In a vertical block it runs down each lane and turns
 * halfway between ranks, so it does not cross a node the layout placed in between. Corners are
 * rounded slightly. Returns the SVG path and a point on its longest run for a label.
 */
export function orthogonalRoute(
  start: Point,
  lanes: readonly Point[],
  end: Point,
  vertical: boolean,
  radius = 3,
): { path: string; label: Point } {
  // Along the block's direction, and across it.
  const along = (p: Point) => (vertical ? p.y : p.x)
  const across = (p: Point) => (vertical ? p.x : p.y)
  const at = (a: number, c: number): Point => (vertical ? { x: c, y: a } : { x: a, y: c })
  const stops = [start, ...lanes, end]
  const corners: Point[] = [start]
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i] as Point
    const to = stops[i + 1] as Point
    if (Math.abs(across(from) - across(to)) < 0.5) continue
    const turn = (along(from) + along(to)) / 2
    corners.push(at(turn, across(from)), at(turn, across(to)))
  }
  corners.push(end)
  const pts: Point[] = []
  for (const p of corners) {
    const prev = pts[pts.length - 1]
    if (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5) continue
    pts.push(p)
  }
  const first = pts[0] as Point
  let path = `M ${first.x} ${first.y}`
  let label = first
  let longest = -1
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as Point
    const prev = pts[i - 1] as Point
    const length = Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)
    if (length > longest) {
      longest = length
      label = { x: (p.x + prev.x) / 2, y: (p.y + prev.y) / 2 }
    }
    const next = pts[i + 1]
    if (!next) {
      path += ` L ${p.x} ${p.y}`
      continue
    }
    const r = Math.min(radius, length / 2, (Math.abs(next.x - p.x) + Math.abs(next.y - p.y)) / 2)
    const inX = Math.sign(p.x - prev.x)
    const inY = Math.sign(p.y - prev.y)
    const outX = Math.sign(next.x - p.x)
    const outY = Math.sign(next.y - p.y)
    path += ` L ${p.x - inX * r} ${p.y - inY * r} Q ${p.x} ${p.y} ${p.x + outX * r} ${p.y + outY * r}`
  }
  return { path, label }
}
