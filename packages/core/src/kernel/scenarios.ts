import type { Dimension, Issue, ObjectVersion, ParameterValue } from '@kalyth/contracts'
import { isKnowledgeType } from './library.ts'
import type { StateView } from './state.ts'
import { toBase } from './units.ts'

/** A pinned version's content, from the project's embedded copy (ADR 0027 §1). */
export type PinContent = (versionSha256: string) => unknown

/**
 * Rules on scenarios, parameters and assessments, on the state a proposal produces (ADR 0028 §2,
 * §3, ADR 0029 §1). A scenario's base chain is acyclic. A parameter names a pinned quantity or
 * property concept, an active scenario and active project elements; its value fits the concept's
 * dimension; its provenance matches its claim's basis, and `runtimeMeasured` waits for its own
 * basis (I5). Contradicting parameters are kept: evaluation reports them (I3). An assessment is
 * never edited.
 */
export function checkScenarioRecords(
  overlay: StateView,
  before: StateView,
  written: ReadonlyMap<string, number>,
  pinContent: PinContent | undefined,
): Issue[] {
  const issues: Issue[] = []
  for (const id of written.keys()) {
    const o = overlay.getObject(id)
    if (!o) continue
    const op = written.get(id)
    const add = (code: string, message: string) =>
      issues.push(op === undefined ? { code, message } : { code, message, op })
    const previous = before.getObject(id)
    if (o.type === 'core.Assessment' && previous && previous.lifecycle === o.lifecycle)
      add('assessment.immutable', 'an assessment is never edited; a newer one supersedes it')
    if (o.lifecycle !== 'active') continue
    if (o.type === 'core.Scenario') checkScenario(overlay, o, add)
    if (o.type === 'core.Parameter') checkParameter(overlay, o, pinContent, add)
  }
  return issues
}

function checkScenario(state: StateView, s: ObjectVersion, add: (c: string, m: string) => void) {
  const seen = new Set<string>([s.id])
  for (let id = s.attributes.base as string | undefined; id; ) {
    const base = state.getObject(id)
    if (base?.type !== 'core.Scenario' || base.lifecycle !== 'active') {
      add('scenario.base_invalid', `${id} is not an active scenario`)
      return
    }
    if (seen.has(id)) {
      add('scenario.base_cycle', 'a scenario cannot be based, directly or not, on itself')
      return
    }
    seen.add(id)
    id = base.attributes.base as string | undefined
  }
}

function checkParameter(
  state: StateView,
  p: ObjectVersion,
  pinContent: PinContent | undefined,
  add: (c: string, m: string) => void,
) {
  const a = p.attributes as {
    concept: string
    scenario: string
    elements: string[]
    value: ParameterValue
    provenance: string
  }
  const scenario = state.getObject(a.scenario)
  if (scenario?.type !== 'core.Scenario' || scenario.lifecycle !== 'active')
    add('parameter.scenario_invalid', `${a.scenario} is not an active scenario`)
  for (const e of a.elements) {
    const element = state.getObject(e)
    if (
      element?.lifecycle !== 'active' ||
      isKnowledgeType(element.type) ||
      ['core.Scenario', 'core.Parameter', 'core.Assessment', 'core.LibraryUse'].includes(
        element.type,
      )
    )
      add('parameter.element_invalid', `${e} is not an active element of this project`)
  }
  if (a.provenance === 'runtimeMeasured')
    add(
      'parameter.runtime_measured_reserved',
      'runtime measurements need their own basis, which does not exist yet (ADR 0028 I5)',
    )
  if (a.provenance === 'stated' && p.claim.basis !== 'stated')
    add('parameter.provenance_basis', 'a stated parameter has a stated claim')
  if (a.provenance === 'sourceObserved' && p.claim.basis !== 'observed')
    add('parameter.provenance_basis', 'a source-observed parameter has an observed claim')

  const pin = state.getEvidence(a.concept)
  if (pin?.source.kind !== 'knowledge' || pin.source.target !== 'object') {
    add('parameter.concept_invalid', `${a.concept} is not a pin of a concept`)
    return
  }
  const content = pinContent?.(pin.source.versionSha256 ?? '') as
    | { type?: string; attributes?: { kind?: string; dimension?: Dimension; values?: string[] } }
    | undefined
  if (!content) return
  if (
    content.type !== 'knowledge.Concept' ||
    !['quantity', 'property'].includes(content.attributes?.kind ?? '')
  )
    return add(
      'parameter.concept_invalid',
      'a parameter gives the value of a quantity or property concept',
    )
  const problem = valueProblem(a.value, content.attributes?.dimension, content.attributes?.values)
  if (problem) add('parameter.value_invalid', problem)
}

function valueProblem(
  value: ParameterValue,
  dimension: Dimension | undefined,
  values: readonly string[] | undefined,
): string | undefined {
  if (value.kind === 'unknown') return undefined
  if (!dimension) return 'the concept has no dimension'
  if (value.kind === 'boolean')
    return dimension === 'boolean' ? undefined : `a ${dimension} is not true or false`
  if (value.kind === 'category') {
    if (dimension !== 'category') return `a ${dimension} is not a category`
    return values?.includes(value.value)
      ? undefined
      : `${value.value} is not a value of the concept`
  }
  const numbers =
    value.kind === 'point'
      ? [value.value]
      : [value.min, value.max].filter((v): v is string => v !== undefined)
  for (const n of numbers) {
    const r = toBase(n, value.unit, dimension)
    if ('error' in r) return r.error
  }
  return undefined
}
