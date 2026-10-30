import { z } from 'zod'
import { ClaimId, ClaimTarget, EvidenceId, EvidenceTarget } from './ids.ts'
import { SourceVerification, SupportReview } from './knowledge.ts'

/**
 * Where a claim's knowledge comes from. Orthogonal to stance, decision status, realisation
 * and verification (ADR 0005).
 *
 * - observed: a deterministic tool observed it in a pinned source, within the coverage the tool
 *   declares (R4). It is a fact about the source, never proof of runtime behaviour.
 * - inferred: a model or heuristic hypothesis.
 * - stated: asserted by a principal (usually a person).
 * - imported: taken from an external document or tool, with provenance.
 */
export const Basis = z.enum(['observed', 'inferred', 'stated', 'imported'])
export type Basis = z.infer<typeof Basis>

/** Whether a record describes existing reality or an intended design. */
export const Stance = z.enum(['asIs', 'toBe'])
export type Stance = z.infer<typeof Stance>

export const Lifecycle = z.enum(['active', 'retired'])
export type Lifecycle = z.infer<typeof Lifecycle>

/** Qualitative, with a reason. Only meaningful for inferred claims; never shown as a probability. */
export const Confidence = z.object({
  level: z.enum(['low', 'medium', 'high']),
  rationale: z.string().min(1).max(2000),
})

/** Required for observed claims (R4): what observed it and what the observation covered. */
export const Observation = z.object({
  tool: z.string().min(1).max(200),
  toolVersion: z.string().min(1).max(100),
  coverage: z.string().min(1).max(2000),
  limitations: z.string().max(2000).optional(),
})

/**
 * Evidence support (R2). Every evidence item in one group is jointly required; separate groups
 * are independent alternatives. A claim is supported while at least one group is entirely fresh.
 */
export const SupportGroupInput = z.object({
  allOf: z.array(EvidenceTarget).min(1).max(64),
})
export const SupportGroup = z.object({
  allOf: z.array(EvidenceId).min(1).max(64),
  /**
   * A curator's review and source verifications, on knowledge claims only (ADR 0030 C1, C6). Only
   * reviewSupport and verifySource write them; a claim input never carries them.
   */
  review: SupportReview.optional(),
  verifications: z.record(EvidenceId, SourceVerification).optional(),
})

export const ModelProvenance = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
})

const claimFields = {
  basis: Basis,
  confidence: Confidence.optional(),
  observation: Observation.optional(),
  method: z.string().min(1).max(200).optional(),
  model: ModelProvenance.optional(),
}

export const ClaimInput = z.object({
  ...claimFields,
  supports: z.array(SupportGroupInput).max(32).default([]),
  contradictedBy: z.array(EvidenceTarget).max(64).default([]),
  derivedFrom: z.array(ClaimTarget).max(64).default([]),
})
export type ClaimInput = z.input<typeof ClaimInput>

/** A claim with every local reference resolved to an id. Stored on each version row. */
export const Claim = z.object({
  ...claimFields,
  supports: z.array(SupportGroup).max(32),
  contradictedBy: z.array(EvidenceId).max(64),
  derivedFrom: z.array(ClaimId).max(64),
})
export type Claim = z.infer<typeof Claim>
