import type {
  DecisionSummary,
  ImpactedElement,
  ObjectVersion,
  RelationVersion,
} from '@kalyth/contracts'
import type { Lens } from '../app/location.ts'
import { plural } from '../model/format.ts'
import { OFF_CANVAS_TYPES, type Projection } from './projection.ts'

/**
 * The canvas lenses (ADR 0020): one model, read for claim basis, freshness, an alternative's
 * impact, or the decisions that change it. Each lens marks the nodes the projection draws; a mark
 * on a collapsed holder stands for its hidden members. Pure, so it is unit-tested.
 */

export const DEFAULT_LENS: Lens = 'basis'

export const LENS_LABEL: Record<Lens, string> = {
  basis: 'Basis',
  freshness: 'Freshness',
  impact: 'Impact',
  decisions: 'Decisions',
}

/** Freshness states that put a revision mark on a node. */
export const NEEDS_REVIEW: ReadonlySet<string> = new Set(['stale', 'derived-stale', 'weakened'])

// ---------- freshness ----------

export interface RevisionMarks {
  /** Drawn node id -> claims it stands for that need review. */
  byNode: Map<string, number>
  /** Claims that need review among the drawn elements and their relations. */
  drawn: number
}

/**
 * Counts, per drawn node, the claims that need review: the claim of every element it stands for,
 * and of every relation leaving one of them. Each claim is counted once, at its source.
 */
export function revisionMarks(
  projection: Projection,
  relations: readonly RelationVersion[],
  statusOf: (claimId: string) => string | undefined,
): RevisionMarks {
  const byNode = new Map<string, number>()
  let drawn = 0
  const add = (node: string | undefined) => {
    if (node === undefined) return
    byNode.set(node, (byNode.get(node) ?? 0) + 1)
    drawn++
  }
  for (const [objectId, node] of projection.representative) {
    if (NEEDS_REVIEW.has(statusOf(objectId) ?? '')) add(node)
  }
  for (const r of relations) {
    if (r.lifecycle !== 'active' || !NEEDS_REVIEW.has(statusOf(r.id) ?? '')) continue
    if (!projection.representative.has(r.to)) continue
    add(projection.representative.get(r.from))
  }
  return { byNode, drawn }
}

// ---------- impact of an alternative ----------

export type AlternativeSummary = DecisionSummary['alternatives'][number]

export interface ImpactMarks {
  /** Drawn node id -> numbers of the direct changes it stands for, in the alternative's order. */
  numbers: Map<string, number[]>
  /** Drawn nodes reached only through propagated impact. */
  reached: Set<string>
  /** Objects changed directly. */
  targets: Set<string>
  summary: { changes: number; newElements: number; reached: number }
}

/**
 * The alternative's direct changes, numbered in its order, and what propagated impact reaches
 * beyond them. `impacted` comes from the impact traversal seeded with the direct targets.
 */
export function impactMarks(
  projection: Projection,
  alternative: Pick<AlternativeSummary, 'directChanges'>,
  impacted: readonly ImpactedElement[] | undefined,
  objectById: ReadonlyMap<string, ObjectVersion>,
): ImpactMarks {
  const numbers = new Map<string, number[]>()
  const targets = new Set<string>()
  alternative.directChanges.forEach((change, i) => {
    targets.add(change.target)
    const node = projection.representative.get(change.target)
    if (node === undefined) return
    const list = numbers.get(node) ?? []
    if (!list.includes(i + 1)) list.push(i + 1)
    numbers.set(node, list)
  })
  const reachedIds = new Set<string>()
  for (const e of impacted ?? []) {
    if (e.depth === 0 || targets.has(e.id)) continue
    const o = objectById.get(e.id)
    if (o && !OFF_CANVAS_TYPES.has(o.type)) reachedIds.add(e.id)
  }
  const reached = new Set<string>()
  for (const id of reachedIds) {
    const node = projection.representative.get(id)
    if (node !== undefined && !numbers.has(node)) reached.add(node)
  }
  let newElements = 0
  for (const id of targets) if (objectById.get(id)?.stance === 'toBe') newElements++
  return {
    numbers,
    reached,
    targets,
    summary: {
      changes: alternative.directChanges.length,
      newElements,
      reached: reachedIds.size,
    },
  }
}

/** "A4: 8 direct changes, 1 new element, reaches 12 more". */
export function impactCaption(
  key: string,
  summary: ImpactMarks['summary'],
  traversed: boolean,
): string {
  const parts = [plural(summary.changes, 'direct change')]
  if (summary.newElements > 0) parts.push(plural(summary.newElements, 'new element'))
  if (traversed) parts.push(`reaches ${summary.reached.toLocaleString('en')} more`)
  return `${key}: ${parts.join(', ')}`
}

/** Decisions whose changes the canvas can show: open or accepted, in the order listed. */
export function shownDecisions(decisions: readonly DecisionSummary[]): DecisionSummary[] {
  return decisions.filter((d) => d.status === 'open' || d.status === 'accepted')
}

/** The alternative the impact lens shows: the one asked for, else a sensible default. */
export function chooseAlternative(
  decisions: readonly DecisionSummary[],
  requested: string | undefined,
): { decision: DecisionSummary; alternative: AlternativeSummary; index: number } | null {
  const shown = shownDecisions(decisions)
  for (const decision of shown) {
    const index = decision.alternatives.findIndex((a) => a.id === requested)
    if (index >= 0)
      return { decision, alternative: decision.alternatives[index] as AlternativeSummary, index }
  }
  const decision = shown.find((d) => d.alternatives.length > 0)
  if (!decision) return null
  const accepted = decision.alternatives.findIndex((a) => a.status === 'accepted')
  const index = accepted >= 0 ? accepted : 0
  return { decision, alternative: decision.alternatives[index] as AlternativeSummary, index }
}

export const alternativeKey = (index: number) => `A${index + 1}`

// ---------- decisions ----------

export interface DecisionMarks {
  /** Drawn node id -> keys (D1, D2, ...) of the decisions that change what it stands for. */
  tags: Map<string, string[]>
  legend: { key: string; id: string; title: string; status: string; elements: number }[]
}

/**
 * Elements that open or accepted decisions change. An open decision counts every alternative's
 * direct changes; an accepted one only its accepted alternatives' (all, if none is marked). The
 * elements a decision determines directly (`decides`) count too.
 */
export function decisionMarks(
  projection: Projection,
  decisions: readonly DecisionSummary[],
): DecisionMarks {
  const tags = new Map<string, string[]>()
  const legend: DecisionMarks['legend'] = []
  shownDecisions(decisions).forEach((d, i) => {
    const key = `D${i + 1}`
    const accepted = d.alternatives.filter((a) => a.status === 'accepted')
    const counted = d.status === 'accepted' && accepted.length > 0 ? accepted : d.alternatives
    const targets = new Set<string>([
      ...counted.flatMap((a) => a.directChanges.map((c) => c.target)),
      ...d.decides.map((x) => x.id),
    ])
    for (const id of targets) {
      const node = projection.representative.get(id)
      if (node === undefined) continue
      const list = tags.get(node) ?? []
      if (!list.includes(key)) list.push(key)
      tags.set(node, list)
    }
    legend.push({ key, id: d.id, title: d.title, status: d.status, elements: targets.size })
  })
  return { tags, legend }
}

// ---------- focus by hops ----------

export type Hops = 0 | 1 | 2

/**
 * The drawn nodes within `hops` edges of the selection, following drawn edges in either direction.
 * An open holder that is selected brings everything drawn inside it. Null when not focusing.
 */
export function focusSet(
  projection: Projection,
  selectedNode: string | undefined,
  hops: Hops,
): Set<string> | null {
  if (hops === 0 || selectedNode === undefined) return null
  if (!projection.nodes.some((n) => n.id === selectedNode)) return null
  const seeds = new Set<string>([selectedNode])
  for (const n of projection.nodes) {
    if ((projection.ancestors.get(n.id) ?? []).includes(selectedNode)) seeds.add(n.id)
  }
  const adjacent = new Map<string, string[]>()
  for (const e of projection.edges) {
    adjacent.set(e.source, [...(adjacent.get(e.source) ?? []), e.target])
    adjacent.set(e.target, [...(adjacent.get(e.target) ?? []), e.source])
  }
  const near = new Set(seeds)
  let frontier = [...seeds]
  for (let step = 0; step < hops; step++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const m of adjacent.get(id) ?? []) {
        if (near.has(m)) continue
        near.add(m)
        next.push(m)
      }
    }
    frontier = next
  }
  // The frames around focused nodes stay as context.
  for (const id of [...near]) for (const a of projection.ancestors.get(id) ?? []) near.add(a)
  return near
}

/** Whether a drawn node is dimmed by the focus: open holders stay as context. */
export function isDimmed(
  focus: ReadonlySet<string> | null,
  node: { id: string; expanded?: boolean; parentId?: string },
): boolean {
  if (focus === null || focus.has(node.id)) return false
  return node.expanded !== true
}

// ---------- accessible names ----------

export interface NodeLensState {
  changeNumbers?: readonly number[]
  alternativeKey?: string
  reached?: boolean
  revisions?: number
  decisionTags?: readonly string[]
  proposed?: boolean
  basisLabel?: string
  /** The element's own claim needs review; named in every lens, since it matters for each. */
  stale?: boolean
}

/** The lens part of a node's accessible name, e.g. "change 2 of A4, stale". */
export function lensDescription(lens: Lens, state: NodeLensState): string {
  const parts: string[] = []
  if (state.proposed) parts.push('proposed')
  if (lens === 'basis' && state.basisLabel) parts.push(state.basisLabel.toLowerCase())
  if (lens === 'impact') {
    const n = state.changeNumbers ?? []
    if (n.length === 1) parts.push(`change ${n[0]} of ${state.alternativeKey}`)
    else if (n.length > 1)
      parts.push(
        `changes ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]} of ${state.alternativeKey}`,
      )
    else if (state.reached) parts.push(`reached by ${state.alternativeKey}`)
  }
  if (lens === 'freshness' && state.revisions)
    parts.push(state.revisions === 1 ? 'stale' : `${state.revisions} stale claims`)
  else if (state.stale) parts.push('stale')
  if (lens === 'decisions' && state.decisionTags?.length)
    parts.push(`changed by ${state.decisionTags.join(' and ')}`)
  return parts.join(', ')
}
