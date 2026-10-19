import type { GroundingReport, OperationInput } from '@kalyth/contracts'
import type { ContextEvidence, ModelContext } from './context.ts'
import { checkCitations, type GroundingOptions } from './grounding.ts'
import type {
  AlternativesOutput,
  Citation,
  NewElement,
  RefineOutput,
  SummaryOutput,
} from './schemas.ts'

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
    newElements: number
  }
}

/** The collector recorded on statement evidence: Kalyth copied the person's words verbatim. */
export const STATEMENT_COLLECTOR = { tool: 'kalyth-navigator', toolVersion: '0.2.0' } as const

/**
 * Statement evidence for every statement a kept item cites (ADR 0022): the person's words, as
 * they typed them, recorded under the local ref the citations use. Uncited statements are not
 * recorded.
 */
function statementEvidence(context: ModelContext, cited: ReadonlySet<string>): OperationInput[] {
  return context.evidence.flatMap((e): OperationInput[] =>
    e.statedBy !== undefined && cited.has(e.id)
      ? [
          {
            op: 'recordEvidence',
            ref: e.id,
            evidence: {
              source: { kind: 'statement', statedBy: e.statedBy },
              excerpt: e.excerpt,
              collectedBy: STATEMENT_COLLECTOR,
            },
          },
        ]
      : [],
  )
}

const ENDPOINT_NAME = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(\/\S*)$/

/** A proposed element's attributes for its type, or why it cannot be one (ADR 0022). */
function proposedAttributes(
  el: NewElement,
): { ok: true; attributes: Record<string, string> } | { ok: false; reason: string } {
  switch (el.type) {
    case 'software.Endpoint': {
      const m = ENDPOINT_NAME.exec(el.name.trim())
      if (!m) return { ok: false, reason: 'an endpoint name must be "METHOD /path"' }
      return { ok: true, attributes: { method: m[1] as string, path: m[2] as string } }
    }
    case 'software.Component':
      return { ok: true, attributes: { name: el.name, responsibility: el.description } }
    default:
      return { ok: true, attributes: { name: el.name } }
  }
}

/** Types that may contain a proposed element of each type (the `contains` rule, ADR 0005). */
const CONTAINERS = new Set([
  'software.System',
  'software.Container',
  'software.Component',
  'software.Module',
])

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
      newElements: 0,
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
 *
 * New elements (ADR 0022) become to-be objects, created only when a kept direct change uses them
 * (or they contain one that is). Statements a kept item cites are recorded as statement evidence.
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
  const { grounding, cite } = groundingTally(evidence, options)
  const reject = (item: string, reason: string, ref?: string) => {
    grounding.itemsRejected.push(ref === undefined ? { item, reason } : { item, reason, ref })
  }
  const method = existing ? 'navigator.refine' : 'navigator.alternatives'
  const framing = {
    level: 'medium' as const,
    rationale: existing
      ? 'Raised by the Navigator while exploring the decision again.'
      : 'Framed by the Navigator from the change request.',
  }
  const cited = new Set<string>()
  const keep = (ids: readonly string[]) => {
    for (const id of ids) cited.add(id)
    return [...ids]
  }
  let directImpacts = 0

  // New elements are checked first, so direct changes can name them.
  interface Proposed {
    el: NewElement
    ref: string
    index: number
    attributes: Record<string, string>
    evidenceIds: string[]
    used: boolean
  }
  const proposed = new Map<string, Proposed>()
  out.newElements.forEach((el, i) => {
    const item = `new element ${el.ref}`
    if (proposed.has(el.ref)) {
      reject(item, 'declares the same new element twice', el.ref)
      return
    }
    const shape = proposedAttributes(el)
    if (!shape.ok) {
      reject(item, shape.reason, el.ref)
      return
    }
    const check = cite(item, el.citations)
    const firstInvalid = check.invalid[0]
    if (firstInvalid) {
      reject(item, firstInvalid.reason, firstInvalid.ref)
      return
    }
    proposed.set(el.ref, {
      el,
      ref: `$new${i + 1}`,
      index: i,
      attributes: shape.attributes,
      evidenceIds: check.evidenceIds,
      used: false,
    })
  })

  const decisionOps: OperationInput[] = []
  const decision = existing ? existing.id : '$decision'
  if (!existing && 'decision' in out) {
    decisionOps.push({
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

  const altOps: OperationInput[] = []
  out.alternatives.forEach((alt, a) => {
    const ref = `$alt${a + 1}`
    const own = offset + a + 1
    const confidence = { level: alt.confidence, rationale: alt.rationale }
    altOps.push(
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
        reject(
          `alternative ${a + 1}, combines ${handle}`,
          'combines an alternative that is not listed before it',
          handle,
        )
        continue
      }
      altOps.push({
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
      const fresh = proposed.get(change.element)
      const target = elements.get(change.element)?.id ?? fresh?.ref
      if (!target) {
        reject(item, 'names an element that was not provided', change.element)
        return
      }
      const firstInvalid = check.invalid[0]
      if (firstInvalid) {
        reject(item, firstInvalid.reason, firstInvalid.ref)
        return
      }
      if (targets.has(target)) return
      targets.add(target)
      if (fresh) fresh.used = true
      grounding.itemsKept++
      directImpacts++
      altOps.push({
        op: 'createRelation',
        type: 'impacts',
        from: ref,
        to: target,
        stance: 'toBe',
        properties: { change: change.change },
        claim: inferred(model, method, confidence, keep(check.evidenceIds)),
      })
    })
  })

  // A used element's container is used too. Later elements first, so a chain is followed.
  const containerOf = (p: Proposed) => {
    const w = proposed.get(p.el.within)
    return w && w.index < p.index && CONTAINERS.has(w.el.type) ? w : undefined
  }
  for (const p of [...proposed.values()].sort((x, y) => y.index - x.index)) {
    const w = p.used ? containerOf(p) : undefined
    if (w) w.used = true
  }
  const newOps: OperationInput[] = []
  let newElements = 0
  for (const p of [...proposed.values()].sort((x, y) => x.index - y.index)) {
    const item = `new element ${p.el.ref}`
    if (!p.used) {
      reject(item, 'no kept change uses it', p.el.ref)
      continue
    }
    newElements++
    grounding.itemsKept++
    const confidence = { level: p.el.confidence, rationale: p.el.description }
    newOps.push({
      op: 'createObject',
      ref: p.ref,
      type: p.el.type,
      stance: 'toBe',
      attributes: p.attributes,
      claim: inferred(model, method, confidence, keep(p.evidenceIds)),
    })
    if (!p.el.within) continue
    const existingContainer = elements.get(p.el.within)
    const container =
      containerOf(p)?.ref ??
      (existingContainer && CONTAINERS.has(existingContainer.type) ? existingContainer.id : null)
    if (!container) {
      reject(`${item}, within ${p.el.within}`, 'is not a container listed before it', p.el.within)
      continue
    }
    newOps.push({
      op: 'createRelation',
      type: 'contains',
      from: container,
      to: p.ref,
      stance: 'toBe',
      properties: {},
      claim: inferred(model, method, confidence, [], [p.ref]),
    })
  }

  const questionOps: OperationInput[] = []
  out.questions.forEach((q, i) => {
    const ref = `$q${i + 1}`
    questionOps.push(
      {
        op: 'createObject',
        ref,
        type: 'core.Question',
        stance: 'toBe',
        attributes: {
          text: q.text,
          inquiryRole: q.inquiryRole,
          status: 'open',
          ...(q.options.length > 0 ? { options: q.options } : {}),
        },
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
    ops: [
      ...statementEvidence(context, cited),
      ...decisionOps,
      ...newOps,
      ...altOps,
      ...questionOps,
    ],
    grounding,
    output: {
      assertions: 0,
      decisions: existing ? 0 : 1,
      alternatives: out.alternatives.length,
      questions: out.questions.length,
      directImpacts,
      newElements,
    },
  }
}
