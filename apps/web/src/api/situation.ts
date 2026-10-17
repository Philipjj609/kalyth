import type { ClaimFreshness, FreshnessStatus, InstructionOrigin } from '@kalyth/contracts'

/**
 * GET /api/v1/projects/:projectId/situation: what needs attention now. Declared here because the
 * `Situation` type reaches @kalyth/contracts only with main's commit 1593b0e. Once merged, replace
 * this interface with `import type { Situation } from '@kalyth/contracts'`; nothing else changes.
 */
export interface Situation {
  projectId: string
  revision: number
  openDecisions: {
    id: string
    title: string
    alternatives: { id: string; title: string; status: string }[]
  }[]
  openQuestions: { id: string; text: string; inquiryRole: string; concerns: string[] }[]
  pendingProposals: {
    id: string
    proposedBy: string
    origin: InstructionOrigin
    createdAt: string
    /** Number of operations in the proposal. */
    operations: number
    rationale: string
  }[]
  /** Claim count per freshness status. */
  freshness: Partial<Record<FreshnessStatus, number>>
  /** The first 100 stale or derived-stale claims. */
  staleClaims: ClaimFreshness[]
}
