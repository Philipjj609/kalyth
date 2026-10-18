import type { Caller, ObjectVersion } from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import { NavigatorError } from './context.ts'
import type { ExistingDecision } from './operations.ts'
import type { Refinement } from './prompts.ts'

export interface DecisionToRefine {
  prompt: Refinement
  existing: ExistingDecision
  /** Elements the existing alternatives change, to put first in the context. */
  targets: string[]
}

const PAGE = 1000

/**
 * Reads an open decision for exploring it again (Journey 1): its alternatives in the order they
 * were created (A1 first), the elements they change, and its questions, answered or open, with
 * the questions about its alternatives. Refuses a decision that is not open.
 */
export function readDecisionToRefine(
  services: KalythServices,
  caller: Caller,
  projectId: string,
  revision: number,
  decisionId: string,
): DecisionToRefine {
  const objects = (types: string[], ids?: string[]): ObjectVersion[] => {
    const r = services.queryObjects(caller, {
      projectId,
      revision,
      types,
      ...(ids ? { ids } : {}),
      limit: PAGE,
    })
    if (!r.ok) throw new NavigatorError(r.error)
    return r.value.objects
  }
  const relations = (type: string) => {
    const r = services.queryRelations(caller, { projectId, revision, types: [type], limit: PAGE })
    if (!r.ok) throw new NavigatorError(r.error)
    return r.value.relations
  }

  const decision = objects(['core.Decision'], [decisionId])[0]
  if (!decision) {
    throw new NavigatorError({
      code: 'not_found',
      message: `no decision ${decisionId} at revision ${revision}`,
      issues: [],
    })
  }
  const a = decision.attributes as Record<string, unknown>
  if (a.status !== 'open') {
    throw new NavigatorError({
      code: 'conflicting',
      message: `the decision is ${String(a.status)}; only an open decision can be explored again`,
      issues: [],
    })
  }

  const altIds = relations('alternativeOf')
    .filter((r) => r.to === decisionId)
    .map((r) => r.from)
  const alternatives = altIds.length > 0 ? objects(['core.Alternative'], altIds) : []
  // Ids are time-ordered within a store, so this is the order the alternatives were created in.
  alternatives.sort((x, y) => (x.id < y.id ? -1 : 1))
  const about = new Set([decisionId, ...alternatives.map((x) => x.id)])
  const questionIds = relations('concerns')
    .filter((r) => about.has(r.to))
    .map((r) => r.from)
  const questions =
    questionIds.length > 0
      ? objects(['core.Question'], [...new Set(questionIds)]).sort((x, y) => (x.id < y.id ? -1 : 1))
      : []
  const altSet = new Set(alternatives.map((x) => x.id))
  const targets = [
    ...new Set(
      relations('impacts')
        .filter((r) => altSet.has(r.from))
        .map((r) => r.to),
    ),
  ]
  const text = (o: ObjectVersion, key: string) => {
    const v = (o.attributes as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  return {
    prompt: {
      title: text(decision, 'title'),
      question: text(decision, 'question'),
      alternatives: alternatives.map((x, i) => ({
        handle: `A${i + 1}`,
        title: text(x, 'title'),
        summary: text(x, 'summary'),
        status: text(x, 'status') || 'proposed',
      })),
      answered: questions
        .filter((q) => text(q, 'status') === 'answered' && text(q, 'answer'))
        .map((q) => ({ text: text(q, 'text'), answer: text(q, 'answer') })),
      open: questions
        .filter((q) => (text(q, 'status') || 'open') === 'open')
        .map((q) => text(q, 'text')),
    },
    existing: { id: decisionId, alternatives: alternatives.map((x) => x.id) },
    targets,
  }
}
