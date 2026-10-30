import type {
  ConditionTest,
  DependencySet,
  Dimension,
  Explanation,
  ExplanationStep,
  KnowledgeRead,
  MissingValue,
  ObjectVersion,
  ParameterValue,
  Verdict,
} from '@kalyth/contracts'
import { ParameterNature, UNIT_CATALOGUE_VERSION } from '@kalyth/contracts'
import type { SqliteStore } from '../store/sqlite-store.ts'
import { canonicalV1 } from './canonical.ts'
import { disputeOf } from './library.ts'
import { type PinSource, resolvePin, versionAt } from './pins.ts'
import type { StateView } from './state.ts'
import { type Interval, parseDecimal, type Rational, relateToTest, toBase } from './units.ts'

/** Part of every assessment: a change to the evaluator or the units marks assessments stale. */
export const EVALUATOR_VERSION = `kalyth-applicability/1 units/${UNIT_CATALOGUE_VERSION}`

export const VERDICT_MEANING =
  'conditionsMet means only that every condition the library declares for this item holds for the stated parameters. It is not a recommendation: it does not say the item is appropriate, best, sufficient or safe, and undeclared considerations, the library’s coverage and the alternatives’ trade-offs remain for people to weigh. conditionsNotMet means a declared condition rules the item out, not that nothing like it could work. unknown means a value is missing, unknown, straddles a threshold or is contradictory.'

export type Evaluation =
  | { ok: true; verdict: Verdict; explanation: Explanation; inputs: DependencySet }
  | { ok: false; code: string; message: string }

type Result3 = 'true' | 'false' | 'unknown'

/**
 * Deterministic applicability (ADR 0028 §4 to §6): the verdict of one pinned pattern or principle,
 * for one scenario and element, from the declared conditions of its library at the pinned
 * revision and the project's parameters. It reads only through `read*`, so the dependency set is
 * exactly what it read (ADR 0029 §2), and the same inputs always give the same explanation.
 */
export function evaluate(
  store: SqliteStore,
  projectId: string,
  revision: number,
  input: {
    item: string
    scenario: string
    element?: string | undefined
    nature?: ParameterNature | undefined
  },
): Evaluation {
  const view = store.view(projectId, revision)
  const fail = (code: string, message: string): Evaluation => ({ ok: false, code, message })
  const deps = {
    knowledge: new Map<string, KnowledgeRead>(),
    parameters: new Map<string, number>(),
    scenarios: new Map<string, number>(),
    elements: new Map<string, number>(),
    libraryUses: new Map<string, number>(),
  }
  const readRecord = (into: Map<string, number>, o: ObjectVersion) => into.set(o.id, o.revision)

  const itemEvidence = view.getEvidence(input.item)
  if (itemEvidence?.source.kind !== 'knowledge' || itemEvidence.source.target !== 'object')
    return fail('assessment.item_not_pinned', `${input.item} is not a pin of a knowledge item`)
  const pin = itemEvidence.source
  const resolved = resolvePin(store, projectId, pin)
  if (resolved.state !== 'resolved')
    return fail('assessment.pin_unresolved', `${pin.id}: ${resolved.reason} (${resolved.detail})`)
  const library = store.getProject(pin.library)
  if (!library)
    return fail(
      'library.not_present',
      `assessing reads the conditions of ${pin.library}, which is not present`,
    )
  const lib = store.view(pin.library, pin.revision)
  const readKnowledge = (target: 'object' | 'relation', id: string) => {
    const v = versionAt(store, { library: pin.library, target, id, revision: pin.revision })
    if (v.ok)
      deps.knowledge.set(`${target}:${id}`, {
        library: pin.library,
        target,
        id,
        revision: pin.revision,
        versionSha256: v.sha256,
      })
  }

  const [use] = view.listObjects({
    types: ['core.LibraryUse'],
    attributeEquals: { library: pin.library },
  })
  if (!use)
    return fail('pin.no_library_use', `the project declares no LibraryUse of ${pin.library}`)
  readRecord(deps.libraryUses, use)

  // The scenario and its base chain, most specific first.
  const chain: ObjectVersion[] = []
  for (let id: string | undefined = input.scenario; id; ) {
    const s = view.getObject(id)
    if (s?.type !== 'core.Scenario' || s.lifecycle !== 'active')
      return fail('assessment.scenario_invalid', `${id} is not an active scenario`)
    if (chain.some((c) => c.id === s.id)) return fail('scenario.base_cycle', 'the base chain loops')
    chain.push(s)
    readRecord(deps.scenarios, s)
    id = typeof s.attributes.base === 'string' ? s.attributes.base : undefined
  }
  const scenario = chain[0] as ObjectVersion

  // The element and its `contains` ancestors, nearest first.
  const lineage: ObjectVersion[] = []
  if (input.element) {
    for (let id: string | undefined = input.element; id; ) {
      const e = view.getObject(id)
      if (!e || e.lifecycle !== 'active')
        return fail('assessment.element_invalid', `${id} is not an active element`)
      if (lineage.some((x) => x.id === e.id)) break
      lineage.push(e)
      readRecord(deps.elements, e)
      id = view.listRelations({ types: ['contains'], to: id })[0]?.from
    }
  }

  const nature: ParameterNature = input.nature ?? 'expected'
  const parameters = view.listObjects({ types: ['core.Parameter'] })
  const missing: MissingValue[] = []

  /** The most specific parameters for one concept (ADR 0028 §3): scenario first, then element. */
  const resolveParameters = (conceptId: string, wanted: ParameterNature) => {
    const forConcept = parameters.filter((p) => {
      if (p.attributes.nature !== wanted) return false
      const e = view.getEvidence(String(p.attributes.concept))
      return (
        e?.source.kind === 'knowledge' &&
        e.source.library === pin.library &&
        e.source.id === conceptId
      )
    })
    for (const [depth, s] of chain.entries()) {
      const inScenario = forConcept.filter((p) => p.attributes.scenario === s.id)
      const prefix = depth === 0 ? '' : `base:${s.id}/`
      const steps: [string, ObjectVersion[]][] = [
        ...lineage.map((e, i): [string, ObjectVersion[]] => [
          i === 0 ? 'element' : `ancestor:${e.id}`,
          inScenario.filter((p) => (p.attributes.elements as string[]).includes(e.id)),
        ]),
        ['system', inScenario.filter((p) => (p.attributes.elements as string[]).length === 0)],
      ]
      for (const [step, found] of steps) if (found.length > 0) return { step: prefix + step, found }
    }
    return undefined
  }

  const evaluateCondition = (
    relation: ExplanationStep['relation'],
    conditionId: string,
  ): ExplanationStep => {
    const condition = lib.getObject(conditionId) as ObjectVersion
    readKnowledge('object', conditionId)
    const test = condition.attributes.test as ConditionTest
    const subjectId = String(condition.attributes.subject)
    const subject = lib.getObject(subjectId)
    readKnowledge('object', subjectId)
    const base = {
      condition: conditionId,
      text: String(condition.attributes.text),
      relation,
      concept: subjectId,
      test,
    }
    const dimension = subject?.attributes.dimension as Dimension | undefined
    const found = resolveParameters(subjectId, nature)
    // Values of other natures are shown beside the result, never used for it (A1).
    const context = ParameterNature.options
      .filter((n) => n !== nature)
      .flatMap((n) => {
        const other = resolveParameters(subjectId, n)
        return (other?.found ?? []).map((p) => {
          readRecord(deps.parameters, p)
          return {
            id: p.id,
            nature: n,
            value: p.attributes.value as ParameterValue,
            resolvedFrom: other?.step ?? '',
          }
        })
      })
    const withContext = context.length > 0 ? { context } : {}
    if (!found) {
      missing.push({
        concept: subjectId,
        conceptName: String(subject?.attributes.name ?? subjectId),
        scenario: scenario.id,
        ...(input.element ? { element: input.element } : {}),
        nature,
        ...(dimension ? { dimension } : {}),
      })
      return { ...base, parameters: [], ...withContext, result: 'unknown', reason: 'missing' }
    }
    for (const p of found.found) readRecord(deps.parameters, p)
    const used = found.found.map((p) => ({
      id: p.id,
      revision: p.revision,
      value: p.attributes.value as ParameterValue,
      resolvedFrom: found.step,
    }))
    // Two values of one nature for one concept at the same step are a conflict, never merged
    // (ADR 0028 I3, A1).
    const values = new Set(used.map((u) => canonicalV1(u.value)))
    if (values.size > 1)
      return {
        ...base,
        parameters: used,
        ...withContext,
        result: 'unknown',
        reason: 'contradictory',
      }
    const outcome = testValue(test, used[0]?.value as ParameterValue, dimension)
    return { ...base, parameters: used, ...withContext, ...outcome }
  }

  const item = lib.getObject(pin.id) as ObjectVersion
  readKnowledge('object', pin.id)
  const maturity = String(item.attributes.maturity ?? 'proposed')
  const disputed = disputeOf(lib, item).status === 'disputed'

  const steps: ExplanationStep[] = []
  let verdict: Verdict
  if (maturity === 'hypothesis') {
    // A hypothesis never decides a verdict (ADR 0026 I5).
    verdict = 'notAssessed'
  } else {
    const relations = lib
      .listRelations({ from: item.id })
      .filter((r) => ['appliesWhen', 'unsuitableWhen', 'exceptWhen', 'requires'].includes(r.type))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    for (const r of relations) {
      readKnowledge('relation', r.id)
      if (r.type === 'requires') {
        const required = requiredVerdict(
          lib,
          r.to,
          evaluateCondition,
          readKnowledge,
          new Set([item.id]),
        )
        steps.push({
          condition: r.to,
          text: String(lib.getObject(r.to)?.attributes.name ?? r.to),
          relation: 'requires',
          parameters: [],
          result:
            required === 'conditionsMet'
              ? 'true'
              : required === 'conditionsNotMet'
                ? 'false'
                : 'unknown',
          ...(required === 'conditionsMet' || required === 'conditionsNotMet'
            ? {}
            : { reason: 'notAssessed' as const }),
          requiredVerdict: required,
        })
      } else steps.push(evaluateCondition(r.type as ExplanationStep['relation'], r.to))
    }
    verdict = combine(item.type, steps)
  }

  const inputs: DependencySet = {
    knowledge: [...deps.knowledge.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    parameters: sorted(deps.parameters),
    scenarios: sorted(deps.scenarios),
    elements: sorted(deps.elements),
    libraryUses: sorted(deps.libraryUses),
    evaluatorVersion: EVALUATOR_VERSION,
  }
  const explanation: Explanation = {
    item: {
      library: pin.library,
      id: pin.id,
      revision: pin.revision,
      name: String(item.attributes.name ?? item.attributes.statement ?? pin.id),
    },
    verdict,
    evaluatorVersion: EVALUATOR_VERSION,
    nature,
    steps,
    missing,
    knowledge: { maturity, disputed },
    scenario: {
      id: scenario.id,
      status: String(scenario.attributes.status),
      rationale: String(scenario.attributes.rationale),
    },
    meaning: VERDICT_MEANING,
  }
  return { ok: true, verdict, explanation, inputs }
}

const sorted = (m: Map<string, number>) =>
  [...m].map(([id, revision]) => ({ id, revision })).sort((a, b) => (a.id < b.id ? -1 : 1))

/** A required pattern's own verdict, at the same scenario and element (ADR 0028 §5). */
function requiredVerdict(
  lib: StateView,
  patternId: string,
  evaluateCondition: (
    relation: ExplanationStep['relation'],
    conditionId: string,
  ) => ExplanationStep,
  readKnowledge: (target: 'object' | 'relation', id: string) => void,
  seen: Set<string>,
): Verdict {
  const pattern = lib.getObject(patternId)
  readKnowledge('object', patternId)
  if (!pattern || seen.has(patternId)) return 'unknown'
  if (pattern.attributes.maturity === 'hypothesis') return 'notAssessed'
  seen.add(patternId)
  const steps: ExplanationStep[] = []
  for (const r of lib.listRelations({ from: patternId }).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (r.type === 'appliesWhen' || r.type === 'unsuitableWhen') {
      readKnowledge('relation', r.id)
      steps.push(evaluateCondition(r.type, r.to))
    } else if (r.type === 'requires') {
      readKnowledge('relation', r.id)
      const v = requiredVerdict(lib, r.to, evaluateCondition, readKnowledge, seen)
      steps.push({
        condition: r.to,
        text: r.to,
        relation: 'requires',
        parameters: [],
        result: v === 'conditionsMet' ? 'true' : v === 'conditionsNotMet' ? 'false' : 'unknown',
        requiredVerdict: v,
      })
    }
  }
  return combine(pattern.type, steps)
}

/** Three-valued combination (ADR 0028 §5). */
function combine(type: string, steps: readonly ExplanationStep[]): Verdict {
  const of = (relation: string) => steps.filter((s) => s.relation === relation).map((s) => s.result)
  const applies = [...of('appliesWhen'), ...of('requires')]
  if (type === 'knowledge.Principle') {
    const except = of('exceptWhen')
    if (except.includes('true')) return 'excepted'
    if (applies.every((r) => r === 'true') && except.every((r) => r === 'false'))
      return 'conditionsMet'
    return 'unknown'
  }
  const unsuitable = of('unsuitableWhen')
  if (unsuitable.includes('true') || applies.includes('false')) return 'conditionsNotMet'
  if (applies.every((r) => r === 'true') && unsuitable.every((r) => r === 'false'))
    return 'conditionsMet'
  return 'unknown'
}

/** One test against one value (ADR 0028 §4). Units convert exactly; dimensions never mix. */
function testValue(
  test: ConditionTest,
  value: ParameterValue,
  dimension: Dimension | undefined,
): { result: Result3; reason?: ExplanationStep['reason'] } {
  const unknown = (reason: NonNullable<ExplanationStep['reason']>) => ({
    result: 'unknown' as const,
    reason,
  })
  if (value.kind === 'unknown') return unknown('declared-unknown')
  if (test.op === 'is')
    return value.kind === 'boolean'
      ? { result: String(value.value === test.value) as Result3 }
      : unknown('incompatible')
  if (test.op === 'in')
    return value.kind === 'category'
      ? { result: String(test.values.includes(value.value)) as Result3 }
      : unknown('incompatible')
  if ((value.kind !== 'point' && value.kind !== 'interval') || !dimension)
    return unknown('incompatible')
  const toRational = (v: string, unit: string): Rational | undefined => {
    const r = toBase(v, unit, dimension)
    return 'error' in r ? undefined : r.value
  }
  // Money compares only within one currency.
  if (dimension === 'money' && value.unit !== test.unit) return unknown('incompatible')
  const testUnitOk = toRational('0', test.unit) !== undefined
  if (!testUnitOk) return unknown('incompatible')
  const bound = (v: string | undefined, inclusive: boolean) => {
    if (v === undefined) return undefined
    const at = toRational(v, value.unit)
    return at ? { at, inclusive } : null
  }
  const interval: Interval | null =
    value.kind === 'point'
      ? (() => {
          const b = bound(value.value, true)
          return b ? { min: b, max: b } : null
        })()
      : (() => {
          const min = bound(value.min, value.minInclusive)
          const max = bound(value.max, value.maxInclusive)
          return min === null || max === null ? null : { min, max }
        })()
  if (!interval) return unknown('incompatible')
  const relation = relateToTest(interval, test, (v) => toRational(v, test.unit) ?? parseDecimal(v))
  if (relation === 'all') return { result: 'true' }
  if (relation === 'none') return { result: 'false' }
  return unknown('straddles')
}

export type { PinSource }
