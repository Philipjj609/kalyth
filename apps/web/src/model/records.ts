import type { Lifecycle, ObjectVersion, RelationVersion, Stance } from '@kalyth/contracts'
import type { ClaimFreshness, FreshnessStatus } from '../api/freshness.ts'
import { objectDetail, objectLabel } from './labels.ts'
import { compareTypes } from './semantics.ts'

/** One row of the Records table: an object or a relation at the viewed revision. */
export interface RecordRow {
  kind: 'object' | 'relation'
  id: string
  type: string
  label: string
  detail: string | undefined
  stance: Stance
  lifecycle: Lifecycle
  basis: string
  confidence: 'low' | 'medium' | 'high' | undefined
  freshness: FreshnessStatus | undefined
  evidenceCount: number
  revision: number
}

export function buildRows(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
  freshness?: ReadonlyMap<string, ClaimFreshness>,
): RecordRow[] {
  const names = new Map(objects.map((o) => [o.id, objectLabel(o)]))
  const nameOf = (id: string) => names.get(id) ?? id
  const evidenceCount = (c: ObjectVersion['claim']) =>
    new Set(c.supports.flatMap((g) => g.allOf)).size
  const rows: RecordRow[] = objects.map((o) => ({
    kind: 'object',
    id: o.id,
    type: o.type,
    label: objectLabel(o),
    detail: objectDetail(o),
    stance: o.stance,
    lifecycle: o.lifecycle,
    basis: o.claim.basis,
    confidence: o.claim.confidence?.level,
    freshness: freshness?.get(o.id)?.status,
    evidenceCount: evidenceCount(o.claim),
    revision: o.revision,
  }))
  for (const r of relations) {
    rows.push({
      kind: 'relation',
      id: r.id,
      type: r.type,
      label: `${nameOf(r.from)} → ${nameOf(r.to)}`,
      detail: undefined,
      stance: r.stance,
      lifecycle: r.lifecycle,
      basis: r.claim.basis,
      confidence: r.claim.confidence?.level,
      freshness: freshness?.get(r.id)?.status,
      evidenceCount: evidenceCount(r.claim),
      revision: r.revision,
    })
  }
  return rows
}

export const ALL = 'all'

export interface RecordFilters {
  kind: 'all' | 'object' | 'relation'
  type: string
  basis: string
  stance: string
  lifecycle: string
  freshness: string
  text: string
}

export const DEFAULT_FILTERS: RecordFilters = {
  kind: 'all',
  type: ALL,
  basis: ALL,
  stance: ALL,
  lifecycle: ALL,
  freshness: ALL,
  text: '',
}

export function filterRows(rows: readonly RecordRow[], f: RecordFilters): RecordRow[] {
  const needle = f.text.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (f.kind === 'all' || r.kind === f.kind) &&
      (f.type === ALL || r.type === f.type) &&
      (f.basis === ALL || r.basis === f.basis) &&
      (f.stance === ALL || r.stance === f.stance) &&
      (f.lifecycle === ALL || r.lifecycle === f.lifecycle) &&
      (f.freshness === ALL || (r.freshness ?? 'none') === f.freshness) &&
      (needle === '' ||
        r.label.toLowerCase().includes(needle) ||
        r.id.toLowerCase().includes(needle) ||
        r.type.toLowerCase().includes(needle) ||
        (r.detail?.toLowerCase().includes(needle) ?? false)),
  )
}

export type SortKey =
  | 'label'
  | 'type'
  | 'stance'
  | 'lifecycle'
  | 'basis'
  | 'freshness'
  | 'evidence'
  | 'revision'
export type SortDirection = 'asc' | 'desc'

const FRESHNESS_RANK: Record<string, number> = {
  stale: 0,
  'derived-stale': 1,
  weakened: 2,
  unknown: 3,
  current: 4,
  'not-applicable': 5,
}

export function sortRows(
  rows: readonly RecordRow[],
  key: SortKey,
  dir: SortDirection,
): RecordRow[] {
  const sign = dir === 'asc' ? 1 : -1
  const cmp = (a: RecordRow, b: RecordRow): number => {
    switch (key) {
      case 'label':
        return a.label.localeCompare(b.label, 'en', { numeric: true })
      case 'type':
        return a.kind === b.kind ? compareTypes(a.type, b.type) : a.kind === 'object' ? -1 : 1
      case 'freshness':
        return (FRESHNESS_RANK[a.freshness ?? ''] ?? 9) - (FRESHNESS_RANK[b.freshness ?? ''] ?? 9)
      case 'evidence':
        return a.evidenceCount - b.evidenceCount
      case 'revision':
        return a.revision - b.revision
      default:
        return String(a[key]).localeCompare(String(b[key]))
    }
  }
  return [...rows].sort(
    (a, b) => sign * cmp(a, b) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  )
}
