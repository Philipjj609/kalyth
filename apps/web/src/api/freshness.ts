import type { ClaimFreshness, FreshnessResult, FreshnessStatus } from '@kalyth/contracts'

/**
 * Freshness report, GET /api/v1/projects/:projectId/freshness?revision=N (ADR 0009). Types come
 * from @kalyth/contracts as type-only imports, so no schema code reaches the browser bundle. The UI
 * treats a 404 as "freshness not available" and never guesses freshness on its own.
 */
export const FRESHNESS_STATUSES = [
  'current',
  'weakened',
  'stale',
  'derived-stale',
  'unknown',
  'not-applicable',
] as const satisfies readonly FreshnessStatus[]
export type { ClaimFreshness, FreshnessStatus }
export type FreshnessSnapshot = FreshnessResult['snapshots'][number]
export type FreshnessReport = Omit<FreshnessResult, 'summary'> & {
  summary: Partial<Record<FreshnessStatus, number>>
}

const isStatus = (v: unknown): v is FreshnessStatus =>
  typeof v === 'string' && (FRESHNESS_STATUSES as readonly string[]).includes(v)

/**
 * Defensive parse of a freshness response: malformed entries are dropped and unknown statuses
 * become "unknown", so a schema drift degrades the badges instead of breaking the UI.
 */
export function parseFreshness(body: unknown): FreshnessReport | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.claims)) return null
  const claims: ClaimFreshness[] = []
  for (const raw of b.claims) {
    if (typeof raw !== 'object' || raw === null) continue
    const c = raw as Record<string, unknown>
    if (typeof c.id !== 'string') continue
    claims.push({
      id: c.id,
      kind: c.kind === 'relation' ? 'relation' : 'object',
      type: typeof c.type === 'string' ? c.type : '',
      basis: typeof c.basis === 'string' ? c.basis : '',
      status: isStatus(c.status) ? c.status : 'unknown',
      staleEvidence: Array.isArray(c.staleEvidence)
        ? c.staleEvidence.filter((e): e is string => typeof e === 'string')
        : [],
      reason: typeof c.reason === 'string' ? c.reason : '',
    })
  }
  const snapshots = Array.isArray(b.snapshots)
    ? b.snapshots.filter(
        (s): s is FreshnessSnapshot =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as FreshnessSnapshot).objectId === 'string' &&
          typeof (s as FreshnessSnapshot).commit === 'string',
      )
    : []
  const summary: Partial<Record<FreshnessStatus, number>> = {}
  for (const claim of claims) summary[claim.status] = (summary[claim.status] ?? 0) + 1
  return {
    projectId: typeof b.projectId === 'string' ? b.projectId : '',
    revision: typeof b.revision === 'number' ? b.revision : -1,
    snapshots,
    claims,
    summary,
  }
}

/** Claim id -> freshness entry, for badges. */
export function freshnessIndex(report: FreshnessReport | null | undefined) {
  const map = new Map<string, ClaimFreshness>()
  for (const claim of report?.claims ?? []) map.set(claim.id, claim)
  return map
}
