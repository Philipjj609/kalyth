import type {
  Claim,
  EvidenceRecord,
  SourceVerification,
  VerificationStatus,
} from '@kalyth/contracts'
import { hashCanonical } from '../util.ts'

type Group = Claim['supports'][number]

/**
 * A support group's key (ADR 0030 A1): computed from its evidence set, so it does not depend on
 * the group's position and replays the same everywhere.
 */
export function supportGroupKey(allOf: readonly string[]): string {
  return `sg_${hashCanonical([...new Set(allOf)].sort()).slice(0, 32)}`
}

/**
 * A replaced claim keeps the review and verifications of every group whose key is unchanged; a
 * changed or new group starts unreviewed (ADR 0030 C6, I2). Whatever the input carried is dropped.
 */
export function carryCuration(previous: Claim, next: Claim): Claim {
  const kept = new Map(previous.supports.map((g) => [supportGroupKey(g.allOf), g]))
  return {
    ...next,
    supports: next.supports.map((g) => {
      const before = kept.get(supportGroupKey(g.allOf))
      return {
        allOf: g.allOf,
        ...(before?.review ? { review: before.review } : {}),
        ...(before?.verifications ? { verifications: before.verifications } : {}),
      }
    }),
  }
}

/** A claim as a client may submit it: no reviews or verifications (ADR 0030 I1). */
export function withoutCuration(claim: Claim): Claim {
  return { ...claim, supports: claim.supports.map((g) => ({ allOf: g.allOf })) }
}

/** Evidence kinds a person verifies; statements are not sources, pins are checked by hash. */
export const VERIFIABLE_KINDS = new Set(['document', 'external'])

export function verificationStatus(group: Group, evidenceId: string): VerificationStatus {
  return group.verifications?.[evidenceId]?.status ?? 'unverified'
}

/** A group counts as support unless a person found it does not, or a source failed (A3). */
export function groupCounts(group: Group): boolean {
  if (group.review?.verdict === 'doesNotSupport') return false
  return !Object.values(group.verifications ?? {}).some((v) => v.status === 'failed')
}

/** A document or external source with attribution: one a person can look up (ADR 0030 A8). */
function attributable(record: EvidenceRecord | undefined): boolean {
  const source = record?.source
  return (source?.kind === 'document' || source?.kind === 'external') && source.meta !== undefined
}

/**
 * ADR 0026 I3, as ADR 0030 A8 strengthens it: every remaining group reviewed as supporting (fully
 * or partly), every cited source's locator verified, and at least one group reviewed as fully
 * supporting that holds a verified, attributable source. K1 stores no source content, so no
 * citation is quote-matched; a source reaches I3 by locator verification only (A9). Returns what
 * is missing, empty when I3 holds.
 */
export function establishedGaps(
  claim: Claim,
  evidence: (id: string) => EvidenceRecord | undefined,
): string[] {
  const gaps: string[] = []
  const anchored = claim.supports.some(
    (group) =>
      group.review?.verdict === 'supports' &&
      group.allOf.some(
        (id) => attributable(evidence(id)) && verificationStatus(group, id) === 'verified',
      ),
  )
  if (claim.supports.length > 0 && !anchored)
    gaps.push('no group reviewed as supporting holds a verified, attributable source')
  claim.supports.forEach((group) => {
    const key = supportGroupKey(group.allOf)
    const verdict = group.review?.verdict ?? 'unreviewed'
    if (verdict !== 'supports' && verdict !== 'partly') gaps.push(`${key} is ${verdict}`)
    for (const id of group.allOf) {
      const kind = evidence(id)?.source.kind
      if (kind && VERIFIABLE_KINDS.has(kind)) {
        const status = verificationStatus(group, id)
        if (status !== 'verified') gaps.push(`${id} in ${key} is ${status}`)
      }
    }
  })
  if (claim.supports.length === 0) gaps.push('no support')
  return gaps
}

export type { SourceVerification }
