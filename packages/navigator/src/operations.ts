import type { GroundingReport, OperationInput } from '@kalyth/contracts'
import type { ContextEvidence, ModelContext } from './context.ts'
import { checkCitations, type GroundingOptions } from './grounding.ts'
import type { AlternativesOutput, Citation, RefineOutput, SummaryOutput } from './schemas.ts'

export interface ModelIdentity {
  provider: string
  model: string
}

export interface Mapped {
  ops: OperationInput[]
  grounding: GroundingReport
  output: {
    assertions: number
    decisions: number
    alternatives: number
    questions: number
    directImpacts: number
  }
}

const evidenceIndex = (context: ModelContext) =>
  new Map<string, ContextEvidence>(context.evidence.map((e) => [e.handle, e]))

/** At most this many normalised matches are kept in a run's report for audit. */
const MAX_NORMALIZED_KEPT = 100

/**
 * Checks citations and adds them to the run's grounding report, keeping exact and normalised
 * acceptances apart (ADR 0017). Each normalised match is recorded with both texts verbatim.
 */
function groundingTally(evidence: ReadonlyMap<string, ContextEvidence>, options: GroundingOptions) {
  const grounding = {
    citations: 0,
    validCitations: 0,
    exactCitations: 0,
    normalizedCitations: 0,
    normalizedMatches: [] as NonNullable<GroundingReport['normalizedMatches']>,
    itemsKept: 0,
    itemsRejected: [] as GroundingReport['itemsRejected'],
  } satisfies GroundingReport
  const cite = (item: string, citations: readonly Citation[]) => {
    const check = checkCitations(citations, evidence, options)
    grounding.citations += citations.length
    grounding.validCitations += check.valid
    grounding.exactCitations += check.exact
    grounding.normalizedCitations += check.normalized
    for (const o of check.outcomes) {
      if (o.match !== 'normalized' || grounding.normalizedMatches.length >= MAX_NORMALIZED_KEPT) {
        continue
      }
      grounding.normalizedMatches.push({
        item,
        ref: o.ref,
        quote: o.quote,
        source: o.source ?? '',
        differences: o.differences ?? [],
      })
    }
    return check
  }
  return { grounding, cite }
}

const inferred = (
  model: ModelIdentity,
  method: string,
  confidence: { level: 'low' | 'medium' | 'high'; rationale: string },
  evidenceIds: string[] = [],
  derivedFrom: string[] = [],
) => ({
  basis: 'inferred' as const,
  confidence,
  model,
  method,
  supports: evidenceIds.length > 0 ? [{ allOf: evidenceIds }] : [],
  contradictedBy: [],
  derivedFrom,
})

/**
 * Cited statements about one element become assertions linked to it by `concerns`. A statement
 * with any invalid citation, or without a valid one, is rejected (ADR 0010).
 */
export function mapSummary(
  out: SummaryOutput,
  context: ModelContext,
  elementId: string,
  model: ModelIdentity,
  options: GroundingOptions = {},
): Mapped {
  const evidence = evidenceIndex(context)
  const ops: OperationInput[] = []
  const { grounding, cite } = groundingTally(evidence, options)
  out.statements.forEach((s, i) => {
    const item = `statement ${i + 1}`
    const check = cite(item, s.citations)
    const firstInvalid = check.invalid[0]
    if (firstInvalid) {
      grounding.itemsRejected.push({ item, reason: firstInvalid.reason, ref: firstInvalid.ref })
      return
    }
    if (check.evidenceIds.length === 0) {
      grounding.itemsRejected.push({ item, reason: 'no valid citation' })
      return
    }
    grounding.itemsKept++
    const ref = `$s${i + 1}`
    const confidence = { level: s.confidence, rationale: s.rationale }
    ops.push(
      {
        op: 'createObject',
        ref,
        type: 'core.Assertion',
        stance: 'asIs',
        attributes: { statement: s.text },
        claim: inferred(model, 'navigator.summarize', confidence, check.evidenceIds),
      },
      {
        op: 'createRelation',
        type: 'concerns',
        from: ref,
        to: elementId,
        stance: 'asIs',
        properties: {},
        claim: inferred(model, 'navigator.summarize', confidence, [], [ref]),
      },
    )
  })
  return {
    ops,
    grounding,
    output: {
      assertions: grounding.itemsKept,
      decisions: 0,
      alternatives: 0,
      questions: 0,
      directImpacts: 0,
    },
  }
}

/** An open decision being explored again: its id and its alternatives in handle order (A1 first). */
export interface ExistingDecision {
  id: string
  alternatives: readonly string[]
}

/**
 * A decision with its alternatives, each alternative's direct changes (`impacts`), the hybrids'
 * `combines` links and the open questions. With `existing`, the alternatives and questions are
 * added to that open decision instead (Journey 1). A direct change naming an unknown element or
 * with any invalid citation is rejected, and so is a hybrid link to an alternative that is not
 * listed before it; the alternative itself is a to-be design and stays.
 */
export function mapAlternatives(
  out: AlternativesOutput | RefineOutput,
  context: ModelContext,
  model: ModelIdentity,
  existing?: ExistingDecision,
  options: GroundingOptions = {},
): Mapped {
  const evidence = evidenceIndex(context)
  const elements = new Map(context.elements.map((e) => [e.handle, e]))
  const ops: OperationInput[] = []
  const { grounding, cite } = groundingTally(evidence, options)
  const method = existing ? 'navigator.refine' : 'navigator.alternatives'
  const framing = {
    level: 'medium' as const,
    rationale: existing
      ? 'Raised by the Navigator while exploring the decision again.'
      : 'Framed by the Navigator from the change request.',
  }
  let directImpacts = 0

  const decision = existing ? existing.id : '$decision'
  if (!existing && 'decision' in out) {
    ops.push({
      op: 'createObject',
      ref: '$decision',
      type: 'core.Decision',
      stance: 'toBe',
      attributes: { title: out.decision.title, question: out.decision.question },
      claim: inferred(model, method, framing),
    })
  }
  // A1..Ak are the decision's existing alternatives; the new ones continue the numbering.
  const offset = existing?.alternatives.length ?? 0
  const byHandle = new Map<string, string>()
  existing?.alternatives.forEach((id, i) => {
    byHandle.set(`A${i + 1}`, id)
  })
  out.alternatives.forEach((_, a) => {
    byHandle.set(`A${offset + a + 1}`, `$alt${a + 1}`)
  })

  out.alternatives.forEach((alt, a) => {
    const ref = `$alt${a + 1}`
    const own = offset + a + 1
    const confidence = { level: alt.confidence, rationale: alt.rationale }
    ops.push(
      {
        op: 'createObject',
        ref,
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: { title: alt.title, summary: alt.summary, tradeoffs: alt.tradeoffs },
        claim: inferred(model, method, confidence),
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: ref,
        to: decision,
        stance: 'toBe',
        properties: {},
        claim: inferred(model, method, confidence),
      },
    )
    for (const handle of new Set(alt.combines)) {
      const target = byHandle.get(handle)
      if (!target || Number(handle.slice(1)) >= own) {
        grounding.itemsRejected.push({
          item: `alternative ${a + 1}, combines ${handle}`,
          reason: 'combines an alternative that is not listed before it',
          ref: handle,
        })
        continue
      }
      ops.push({
        op: 'createRelation',
        type: 'combines',
        from: ref,
        to: target,
        stance: 'toBe',
        properties: {},
        claim: inferred(model, method, confidence),
      })
    }
    const targets = new Set<string>()
    alt.directChanges.forEach((change, c) => {
      const item = `alternative ${a + 1}, change ${c + 1}`
      const check = cite(item, change.citations)
      const target = elements.get(change.element)
      if (!target) {
        grounding.itemsRejected.push({
          item,
          reason: 'names an element that was not provided',
          ref: change.element,
        })
        return
      }
      const firstInvalid = check.invalid[0]
      if (firstInvalid) {
        grounding.itemsRejected.push({ item, reason: firstInvalid.reason, ref: firstInvalid.ref })
        return
      }
      if (targets.has(target.id)) return
      targets.add(target.id)
      grounding.itemsKept++
      directImpacts++
      ops.push({
        op: 'createRelation',
        type: 'impacts',
        from: ref,
        to: target.id,
        stance: 'toBe',
        properties: { change: change.change },
        claim: inferred(model, method, confidence, check.evidenceIds),
      })
    })
  })
  out.questions.forEach((q, i) => {
    const ref = `$q${i + 1}`
    const text = q.options.length > 0 ? `${q.text}\nOptions: ${q.options.join('; ')}` : q.text
    ops.push(
      {
        op: 'createObject',
        ref,
        type: 'core.Question',
        stance: 'toBe',
        attributes: { text, inquiryRole: q.inquiryRole, status: 'open' },
        claim: inferred(model, method, framing),
      },
      {
        op: 'createRelation',
        type: 'concerns',
        from: ref,
        to: decision,
        stance: 'toBe',
        properties: {},
        claim: inferred(model, method, framing),
      },
    )
  })
  return {
    ops,
    grounding,
    output: {
      assertions: 0,
      decisions: existing ? 0 : 1,
      alternatives: out.alternatives.length,
      questions: out.questions.length,
      directImpacts,
    },
  }
}
