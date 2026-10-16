import type { Claim, Issue, Stance } from '@kalyth/contracts'
import type { StateView } from './state.ts'

/**
 * Support semantics (R2): every evidence item in a group is jointly required, and groups are
 * independent alternatives. A claim is supported while at least one group is entirely fresh.
 * One fresh item does not keep a group alive if another required item in it went stale.
 */
export function isClaimSupported(
  claim: Pick<Claim, 'supports'>,
  isFresh: (evidenceId: string) => boolean,
): boolean {
  return claim.supports.some((group) => group.allOf.every(isFresh))
}

/**
 * Claim rules (ADR 0005). They make the epistemic facets enforceable rather than descriptive.
 * `selfId` is the id of the record carrying the claim, so it cannot derive from itself.
 */
export function validateClaim(
  claim: Claim,
  stance: Stance,
  selfId: string,
  state: StateView,
  op: number,
): Issue[] {
  const issues: Issue[] = []
  const add = (code: string, message: string) => issues.push({ code, message, op, path: ['claim'] })

  switch (claim.basis) {
    case 'observed':
      // R4: observed means a tool observed it in a source, within declared coverage.
      if (!claim.observation)
        add(
          'claim.observation_required',
          'observed claims must state the observing tool and coverage',
        )
      if (claim.supports.length === 0)
        add('claim.support_required', 'observed claims must cite supporting evidence')
      if (claim.model)
        add('claim.observed_from_model', 'a model output is an inference, not an observation')
      if (claim.confidence)
        add('claim.confidence_not_allowed', 'confidence applies to inferred claims only')
      break
    case 'inferred':
      if (!claim.confidence)
        add('claim.confidence_required', 'inferred claims must state confidence and its rationale')
      if (stance === 'asIs' && claim.supports.length === 0 && claim.derivedFrom.length === 0)
        add(
          'claim.grounding_required',
          'an inference about existing reality must cite evidence or the claims it derives from',
        )
      break
    case 'imported':
      if (claim.supports.length === 0)
        add(
          'claim.support_required',
          'imported claims must cite the source they were imported from',
        )
      if (claim.confidence)
        add('claim.confidence_not_allowed', 'confidence applies to inferred claims only')
      break
    case 'stated':
      if (claim.confidence)
        add('claim.confidence_not_allowed', 'confidence applies to inferred claims only')
      break
  }

  const evidenceIds = [...claim.supports.flatMap((g) => g.allOf), ...claim.contradictedBy]
  for (const id of new Set(evidenceIds)) {
    const evidence = state.getEvidence(id)
    if (!evidence) {
      add('claim.evidence_not_found', `evidence ${id} does not exist`)
    } else if (claim.basis === 'observed' && evidence.source.kind === 'statement') {
      add(
        'claim.observed_needs_source_evidence',
        `evidence ${id} is a statement, not an observed source`,
      )
    }
  }
  for (const id of new Set(claim.derivedFrom)) {
    if (id === selfId) add('claim.derives_from_self', 'a claim cannot derive from itself')
    else if (!state.getObject(id) && !state.getRelation(id))
      add('claim.derived_from_not_found', `claim ${id} does not exist`)
  }
  return issues
}
