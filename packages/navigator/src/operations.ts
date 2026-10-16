import type { GroundingReport, OperationInput } from '@kalyth/contracts'
import type { ContextEvidence, ModelContext } from './context.ts'
import { checkCitations } from './grounding.ts'
import type { AlternativesOutput, SummaryOutput } from './schemas.ts'

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
): Mapped {
  const evidence = evidenceIndex(context)
  const ops: OperationInput[] = []
  const grounding: GroundingReport = {
    citations: 0,
    validCitations: 0,
    itemsKept: 0,
    itemsRejected: [],
  }
  out.statements.forEach((s, i) => {
    const check = checkCitations(s.citations, evidence)
    grounding.citations += s.citations.length
    grounding.validCitations += check.valid
    const item = `statement ${i + 1}`
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

/**
 * A decision with its alternatives, each alternative's direct changes (`impacts`) and the open
 * questions. A direct change naming an unknown element or with any invalid citation is rejected;
 * the alternative itself is a to-be design and stays.
 */
export function mapAlternatives(
  out: AlternativesOutput,
  context: ModelContext,
  model: ModelIdentity,
): Mapped {
  const evidence = evidenceIndex(context)
  const elements = new Map(context.elements.map((e) => [e.handle, e]))
  const ops: OperationInput[] = []
  const grounding: GroundingReport = {
    citations: 0,
    validCitations: 0,
    itemsKept: 0,
    itemsRejected: [],
  }
  const method = 'navigator.alternatives'
  const framing = {
    level: 'medium' as const,
    rationale: 'Framed by the Navigator from the change request.',
  }
  let directImpacts = 0

  ops.push({
    op: 'createObject',
    ref: '$decision',
    type: 'core.Decision',
    stance: 'toBe',
    attributes: { title: out.decision.title, question: out.decision.question },
    claim: inferred(model, method, framing),
  })
  out.alternatives.forEach((alt, a) => {
    const ref = `$alt${a + 1}`
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
        to: '$decision',
        stance: 'toBe',
        properties: {},
        claim: inferred(model, method, confidence),
      },
    )
    const targets = new Set<string>()
    alt.directChanges.forEach((change, c) => {
      const item = `alternative ${a + 1}, change ${c + 1}`
      const check = checkCitations(change.citations, evidence)
      grounding.citations += change.citations.length
      grounding.validCitations += check.valid
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
        to: '$decision',
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
      decisions: 1,
      alternatives: out.alternatives.length,
      questions: out.questions.length,
      directImpacts,
    },
  }
}
