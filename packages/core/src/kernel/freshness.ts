import type {
  ClaimFreshness,
  EvidenceRecord,
  FreshnessStatus,
  ObjectVersion,
  RelationVersion,
} from '@kalyth/contracts'

export interface SnapshotState {
  objectId: string
  repo: string
  commit: string
  ref?: string
  files: Readonly<Record<string, string>>
  /** An ingest of a newer commit that stopped part way (ADR 0025). */
  pending?: { commit: string; parts: number }
}

type EvidenceState = 'fresh' | 'stale' | 'unknown'

/**
 * Computes the freshness of every active claim at one revision (ADR 0009).
 *
 * Source-span evidence is fresh while the repository's current snapshot maps its path to the same
 * blob. Other evidence kinds have no staleness model yet and count as fresh. Claim status follows
 * the support groups (R2), then staleness propagates along derivedFrom links. This is a read model:
 * nothing is written, and accepted decisions are never revoked by it.
 */
export function assessFreshness(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
  evidence: ReadonlyMap<string, EvidenceRecord>,
): { snapshots: SnapshotState[]; claims: ClaimFreshness[] } {
  const snapshots = objects
    .filter((o) => o.type === 'core.SourceSnapshot' && o.lifecycle === 'active')
    .map((o): SnapshotState => {
      const a = o.attributes as {
        repo: string
        commit: string
        ref?: string
        files: Record<string, string>
        pending?: { commit: string; parts: number }
      }
      return {
        objectId: o.id,
        repo: a.repo,
        commit: a.commit,
        files: a.files,
        ...(a.ref ? { ref: a.ref } : {}),
        ...(a.pending ? { pending: a.pending } : {}),
      }
    })
  const byRepo = new Map(snapshots.map((s) => [s.repo, s]))

  const evidenceState = (id: string): EvidenceState => {
    const e = evidence.get(id)
    if (!e) return 'stale'
    if (e.source.kind !== 'sourceSpan') return 'fresh'
    const snapshot = byRepo.get(e.source.repo)
    if (!snapshot) return 'unknown'
    return snapshot.files[e.source.path] === e.source.blobSha ? 'fresh' : 'stale'
  }

  const records = [
    ...objects
      .filter((o) => o.lifecycle === 'active')
      .map((o) => ({ record: o, kind: 'object' as const })),
    ...relations
      .filter((r) => r.lifecycle === 'active')
      .map((r) => ({ record: r, kind: 'relation' as const })),
  ]

  const results = new Map<string, ClaimFreshness>()
  for (const { record, kind } of records) {
    const { claim } = record
    const staleEvidence = new Set<string>()
    let status: FreshnessStatus
    let reason: string
    if (claim.supports.length === 0) {
      status = 'not-applicable'
      reason = 'no supporting evidence'
    } else {
      const groups = claim.supports.map((g) =>
        g.allOf.map((id) => [id, evidenceState(id)] as const),
      )
      for (const group of groups)
        for (const [id, s] of group) if (s === 'stale') staleEvidence.add(id)
      const fresh = groups.filter((g) => g.every(([, s]) => s === 'fresh')).length
      const unknown = groups.every((g) => g.some(([, s]) => s === 'unknown'))
      if (fresh === groups.length) {
        status = 'current'
        reason = 'all supporting evidence matches the current snapshot'
      } else if (fresh > 0) {
        status = 'weakened'
        reason = `${fresh} of ${groups.length} support groups still match the current snapshot`
      } else if (unknown) {
        status = 'unknown'
        reason = 'no source snapshot is recorded for the evidence repository'
      } else {
        status = 'stale'
        reason = 'no support group matches the current snapshot; review needed'
      }
    }
    results.set(record.id, {
      id: record.id,
      kind,
      type: record.type,
      basis: claim.basis,
      status,
      staleEvidence: [...staleEvidence].sort(),
      reason,
    })
  }

  // Propagate along derivedFrom until nothing changes; derivation never repairs a stale claim.
  let changed = true
  while (changed) {
    changed = false
    for (const { record } of records) {
      const current = results.get(record.id)
      if (!current || current.status === 'stale' || current.status === 'derived-stale') continue
      const staleSource = record.claim.derivedFrom.find((id) => {
        const s = results.get(id)?.status
        return s === 'stale' || s === 'derived-stale'
      })
      if (staleSource) {
        results.set(record.id, {
          ...current,
          status: 'derived-stale',
          reason: `derived from ${staleSource}, which needs review`,
        })
        changed = true
      }
    }
  }

  return { snapshots, claims: [...results.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}
