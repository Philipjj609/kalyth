import type {
  ConditionTest,
  DependencySet,
  Dimension,
  EvidenceRecord,
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
export const EVALUATOR_VERSION = `kalyth-applicability/3 units/${UNIT_CATALOGUE_VERSION}`

export const VERDICT_MEANING =
  'conditionsMet means only that every condition the library declares for this item holds for the stated parameters, and that it declares at least one that must hold. It is not a recommendation: it does not say the item is appropriate, best, sufficient or safe, and undeclared considerations, the library’s coverage and the alternatives’ trade-offs remain for people to weigh. conditionsNotMet means a declared condition rules the item out, not that nothing like it could work. unknown means a value is missing, unknown, straddles a threshold or is contradictory, or that the item declares nothing that must hold. conflicting means libraries disagree and no decision has chosen between them.'

export interface EvaluateOptions {
  /**
   * Pins filed in the same proposal as the assessment, not yet in the state (ADR 0033 §9). The
   * verdict, explanation and inputs name an item by library, id and revision, never by the pin's
   * evidence id, so they are the same before and after the pin is committed.
   */
  pins?: (evidenceId: string) => EvidenceRecord | undefined
}

export type Evaluation =
  | { ok: true; verdict: Verdict; explanation: Explanation; inputs: DependencySet }
  | { ok: false; code: string; message: string }

type Result3 = 'true' | 'false' | 'unknown'
type Specification = 'sufficient' | 'underspecified'

interface Candidate {
  p: ObjectVersion
  correspondence: ObjectVersion | undefined
}

interface ItemOutcome {
  pin: PinSource
  evidenceId: string
  name: string
  type: string
  maturity: string
  disputed: boolean
  steps: ExplanationStep[]
  evaluated: Verdict
  verdict: Verdict
  specification: Specification
}

const DEFINITE = new Set<Verdict>(['conditionsMet', 'conditionsNotMet', 'excepted'])

/**
 * Deterministic applicability (ADR 0028 §4 to §6, ADR 0027 §5): the verdict of one pinned pattern
 * or principle, for one scenario, element and nature, from the declared conditions of its library
 * at the pinned revision and the project's parameters. The same guidance in other libraries, named
 * by the project's correspondences, is assessed separately; when the libraries disagree, the
 * verdict is `conflicting` unless an accepted decision chose one. Everything is read through the
 * `read*` helpers, so the dependency set is exactly what was read (ADR 0029 §2).
 */
export function evaluate(
  store: SqliteStore,
  projectId: string,
  revision: number,
  input: {
    item: string
    scenario: string
    element?: string | undefined
    /** Required for new requests; stored assessments without one were about expected values. */
    nature?: ParameterNature | undefined
  },
  options: EvaluateOptions = {},
): Evaluation {
  const view = store.view(projectId, revision)
  const fail = (code: string, message: string): Evaluation => ({ ok: false, code, message })
  const nature: ParameterNature = input.nature ?? 'expected'
  const deps = {
    knowledge: new Map<string, KnowledgeRead>(),
    parameters: new Map<string, number>(),
    scenarios: new Map<string, number>(),
    elements: new Map<string, number>(),
    libraryUses: new Map<string, number>(),
    correspondences: new Map<string, number>(),
    decisions: new Map<string, number>(),
  }
  const readRecord = (into: Map<string, number>, o: ObjectVersion) => into.set(o.id, o.revision)

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
      if (e?.lifecycle !== 'active')
        return fail('assessment.element_invalid', `${id} is not an active element`)
      if (lineage.some((x) => x.id === e.id)) break
      lineage.push(e)
      readRecord(deps.elements, e)
      id = view.listRelations({ types: ['contains'], to: id })[0]?.from
    }
  }

  const parameters = view.listObjects({ types: ['core.Parameter'] })
  const correspondences = view.listObjects({ types: ['core.Correspondence'] })
  const pinOf = (evidenceId: unknown): PinSource | undefined => {
    const e: EvidenceRecord | undefined =
      options.pins?.(String(evidenceId)) ?? view.getEvidence(String(evidenceId))
    return e?.source.kind === 'knowledge' ? e.source : undefined
  }
  /** A pinned concept's content, from the project's own copy. */
  const pinnedConcept = (evidenceId: string) => {
    const pin = pinOf(evidenceId)
    const resolved = pin ? resolvePin(store, projectId, pin) : undefined
    return resolved?.state === 'resolved'
      ? (resolved.content as { attributes?: { name?: string; dimension?: string } })
      : undefined
  }
  const missing: MissingValue[] = []

  /** Evaluates one pinned item on its own library (ADR 0028 §4, §5). */
  const evaluateItem = (evidenceId: string): ItemOutcome | { code: string; message: string } => {
    const pin = pinOf(evidenceId)
    if (pin?.target !== 'object')
      return {
        code: 'assessment.item_not_pinned',
        message: `${evidenceId} is not a pin of a knowledge item`,
      }
    const resolved = resolvePin(store, projectId, pin)
    if (resolved.state !== 'resolved')
      return {
        code: 'assessment.pin_unresolved',
        message: `${pin.id}: ${resolved.reason} (${resolved.detail})`,
      }
    if (!store.getProject(pin.library))
      return {
        code: 'library.not_present',
        message: `assessing reads the conditions of ${pin.library}, which is not present`,
      }
    const [use] = view.listObjects({
      types: ['core.LibraryUse'],
      attributeEquals: { library: pin.library },
    })
    if (!use)
      return {
        code: 'pin.no_library_use',
        message: `the project declares no LibraryUse of ${pin.library}`,
      }
    readRecord(deps.libraryUses, use)
    const lib = store.view(pin.library, pin.revision)
    const readKnowledge = (target: 'object' | 'relation', id: string) => {
      const v = versionAt(store, { library: pin.library, target, id, revision: pin.revision })
      if (v.ok)
        deps.knowledge.set(`${pin.library}:${target}:${id}`, {
          library: pin.library,
          target,
          id,
          revision: pin.revision,
          versionSha256: v.sha256,
        })
    }

    /**
     * Parameters for a concept of this library: on a pin of that concept, or, across libraries,
     * on a pin that a committed `sameAs` correspondence links to one (ADR 0027 §5, I1).
     */
    const conceptParameters = (conceptId: string): Candidate[] => {
      const own = new Set<string>()
      const via = new Map<string, ObjectVersion>()
      for (const p of parameters) {
        const pin2 = pinOf(p.attributes.concept)
        if (pin2?.library === pin.library && pin2.id === conceptId) own.add(p.id)
      }
      for (const c of correspondences) {
        if (c.attributes.relation !== 'sameAs') continue
        const [mine, theirs] = [c.attributes.a, c.attributes.b].map((x) => pinOf(x))
        const sides: [PinSource | undefined, unknown][] = [
          [mine, c.attributes.b],
          [theirs, c.attributes.a],
        ]
        for (const [side, other] of sides)
          if (side?.library === pin.library && side.id === conceptId) via.set(String(other), c)
      }
      return parameters.flatMap((p): Candidate[] => {
        if (own.has(p.id)) return [{ p, correspondence: undefined }]
        const c = via.get(String(p.attributes.concept))
        return c ? [{ p, correspondence: c }] : []
      })
    }

    /** The most specific parameters of one nature (ADR 0028 §3, A1): scenario first, then element. */
    const resolveParameters = (candidates: Candidate[], wanted: ParameterNature) => {
      const ofNature = candidates.filter((c) => c.p.attributes.nature === wanted)
      for (const [depth, s] of chain.entries()) {
        const inScenario = ofNature.filter((c) => c.p.attributes.scenario === s.id)
        const prefix = depth === 0 ? '' : `base:${s.id}/`
        const steps: [string, typeof inScenario][] = [
          ...lineage.map((e, i): [string, typeof inScenario] => [
            i === 0 ? 'element' : `ancestor:${e.id}`,
            inScenario.filter((c) => (c.p.attributes.elements as string[]).includes(e.id)),
          ]),
          ['system', inScenario.filter((c) => (c.p.attributes.elements as string[]).length === 0)],
        ]
        for (const [step, found] of steps)
          if (found.length > 0) return { step: prefix + step, found }
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
      const subjectName = String(subject?.attributes.name ?? subjectId)
      const base = {
        condition: conditionId,
        text: String(condition.attributes.text),
        relation,
        concept: subjectId,
        test,
      }
      const dimension = subject?.attributes.dimension as Dimension | undefined
      const candidates = conceptParameters(subjectId)
      const found = resolveParameters(candidates, nature)
      const context = ParameterNature.options
        .filter((n) => n !== nature)
        .flatMap((n) => {
          const other = resolveParameters(candidates, n)
          return (other?.found ?? []).map(({ p }) => {
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
        // A value on a same-named concept of another library is not used without a sameAs
        // correspondence (ADR 0027 §5); say so instead of calling it missing.
        const lookalike = parameters.find((p) => {
          const other = pinOf(p.attributes.concept)
          return (
            other !== undefined &&
            other.library !== pin.library &&
            p.attributes.nature === nature &&
            pinnedConcept(String(p.attributes.concept))?.attributes?.name?.toLowerCase() ===
              subjectName.toLowerCase()
          )
        })
        if (lookalike) {
          readRecord(deps.parameters, lookalike)
          return {
            ...base,
            parameters: [],
            ...withContext,
            result: 'unknown',
            reason: 'no-correspondence',
            note: `${lookalike.id} gives "${subjectName}" for a concept of another library, and no sameAs correspondence links the two`,
          }
        }
        missing.push({
          concept: subjectId,
          conceptName: subjectName,
          scenario: scenario.id,
          ...(input.element ? { element: input.element } : {}),
          nature,
          ...(dimension ? { dimension } : {}),
        })
        return { ...base, parameters: [], ...withContext, result: 'unknown', reason: 'missing' }
      }
      for (const { p, correspondence } of found.found) {
        readRecord(deps.parameters, p)
        if (correspondence) readRecord(deps.correspondences, correspondence)
      }
      const via = found.found.find((f) => f.correspondence)?.correspondence
      const used = found.found.map(({ p }) => ({
        id: p.id,
        revision: p.revision,
        value: p.attributes.value as ParameterValue,
        resolvedFrom: found.step,
      }))
      const linked = via ? { correspondence: via.id } : {}
      // Across libraries, a sameAs link joins concepts only if their dimensions agree.
      if (via) {
        const sides = [via.attributes.a, via.attributes.b].map(
          (x) => pinnedConcept(String(x))?.attributes?.dimension,
        )
        if (sides[0] !== sides[1])
          return {
            ...base,
            parameters: used,
            ...withContext,
            ...linked,
            result: 'unknown',
            reason: 'incompatible',
            note: 'the corresponding concepts have different dimensions',
          }
      }
      // Two values of one nature for one concept at the same step are a conflict (I3, A1).
      const values = new Set(used.map((u) => canonicalV1(u.value)))
      if (values.size > 1)
        return {
          ...base,
          parameters: used,
          ...withContext,
          ...linked,
          result: 'unknown',
          reason: 'contradictory',
        }
      const outcome = testValue(test, used[0]?.value as ParameterValue, dimension)
      return { ...base, parameters: used, ...withContext, ...linked, ...outcome }
    }

    const item = lib.getObject(pin.id)
    if (!item)
      return { code: 'assessment.pin_unresolved', message: `${pin.id} is not in its library` }
    readKnowledge('object', pin.id)
    const maturity = String(item.attributes.maturity ?? 'proposed')
    const disputed = disputeOf(lib, item).status === 'disputed'
    const name = String(item.attributes.name ?? item.attributes.statement ?? pin.id)
    const steps: ExplanationStep[] = []
    if (maturity === 'hypothesis') {
      // A hypothesis never decides a verdict (ADR 0026 I5).
      return {
        pin,
        evidenceId,
        name,
        type: item.type,
        maturity,
        disputed,
        steps,
        evaluated: 'notAssessed',
        verdict: 'notAssessed',
        specification: 'sufficient',
      }
    }
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
        const definite = required === 'conditionsMet' || required === 'conditionsNotMet'
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
          ...(definite ? {} : { reason: 'notAssessed' as const }),
          requiredVerdict: required,
        })
      } else steps.push(evaluateCondition(r.type as ExplanationStep['relation'], r.to))
    }
    const evaluated = combine(item.type, steps)
    // An empty conjunction is true, but declaring nothing that must hold establishes nothing
    // (ADR 0028 amendment A3): the logic is kept, the verdict presented is unknown.
    const declaresWhatMustHold = steps.some(
      (s) => s.relation === 'appliesWhen' || s.relation === 'requires',
    )
    const specification: Specification = declaresWhatMustHold ? 'sufficient' : 'underspecified'
    const verdict = evaluated === 'conditionsMet' && !declaresWhatMustHold ? 'unknown' : evaluated
    return {
      pin,
      evidenceId,
      name,
      type: item.type,
      maturity,
      disputed,
      steps,
      evaluated,
      verdict,
      specification,
    }
  }

  const primary = evaluateItem(input.item)
  if ('code' in primary) return fail(primary.code, primary.message)

  // The same guidance in other libraries, named by the project's correspondences (ADR 0027 §5).
  const related = correspondences
    .filter((c) => c.attributes.relation === 'sameAs' || c.attributes.relation === 'conflictsWith')
    .flatMap((c) => {
      const other =
        c.attributes.a === input.item
          ? c.attributes.b
          : c.attributes.b === input.item
            ? c.attributes.a
            : undefined
      const otherPin = other === undefined ? undefined : pinOf(other)
      return otherPin?.target === 'object' && otherPin.library !== primary.pin.library
        ? [{ c, other: String(other) }]
        : []
    })
  const alternatives: ItemOutcome[] = []
  const altMeta: { correspondence: ObjectVersion }[] = []
  for (const { c, other } of related) {
    readRecord(deps.correspondences, c)
    const outcome = evaluateItem(other)
    if ('code' in outcome) return fail(outcome.code, `${other}: ${outcome.message}`)
    alternatives.push(outcome)
    altMeta.push({ correspondence: c })
  }

  // Opposing guidance: definite verdicts that disagree, or a stated conflict (ADR 0027 §5).
  const all = [primary, ...alternatives]
  const definite = new Set(all.map((o) => o.verdict).filter((v) => DEFINITE.has(v)))
  const statedConflict = altMeta.some(
    (m) => m.correspondence.attributes.relation === 'conflictsWith',
  )
  const opposing = definite.size > 1 || (statedConflict && alternatives.length > 0)
  let verdict: Verdict = primary.verdict
  let settledBy: Explanation['settledBy']
  if (opposing) {
    // A person may settle it with a decision: an accepted alternative citing one of the pins.
    const pins = new Set(all.map((o) => o.evidenceId))
    const chosen = view
      .listObjects({ types: ['core.Alternative'], attributeEquals: { status: 'accepted' } })
      .flatMap((alt) => {
        const decisionId = view.listRelations({ types: ['alternativeOf'], from: alt.id })[0]?.to
        const decision = decisionId ? view.getObject(decisionId) : undefined
        const cited = alt.claim.supports.flatMap((g) => g.allOf).filter((e) => pins.has(e))
        return decision?.attributes.status === 'accepted' && cited.length === 1
          ? [{ alt, decision, cited: cited[0] as string }]
          : []
      })
    const [settlement, ...more] = chosen
    if (settlement && more.length === 0) {
      readRecord(deps.decisions, settlement.decision)
      readRecord(deps.decisions, settlement.alt)
      const winner = all.find((o) => o.evidenceId === settlement.cited) as ItemOutcome
      verdict = winner.verdict
      settledBy = {
        decision: settlement.decision.id,
        alternative: settlement.alt.id,
        item: settlement.cited,
      }
    } else verdict = 'conflicting'
  }

  const inputs: DependencySet = {
    knowledge: [...deps.knowledge.values()].sort((a, b) =>
      `${a.library}${a.id}` < `${b.library}${b.id}` ? -1 : 1,
    ),
    parameters: sorted(deps.parameters),
    scenarios: sorted(deps.scenarios),
    elements: sorted(deps.elements),
    libraryUses: sorted(deps.libraryUses),
    correspondences: sorted(deps.correspondences),
    decisions: sorted(deps.decisions),
    evaluatorVersion: EVALUATOR_VERSION,
  }
  const explanation: Explanation = {
    item: {
      library: primary.pin.library,
      id: primary.pin.id,
      revision: primary.pin.revision,
      name: primary.name,
    },
    verdict,
    evaluatorVersion: EVALUATOR_VERSION,
    nature,
    steps: primary.steps,
    missing,
    knowledge: { maturity: primary.maturity, disputed: primary.disputed },
    scenario: {
      id: scenario.id,
      status: String(scenario.attributes.status),
      rationale: String(scenario.attributes.rationale),
    },
    evaluatedVerdict: primary.evaluated,
    specification: primary.specification,
    ...(alternatives.length > 0
      ? {
          alternatives: alternatives.map((o, i) => ({
            item: { library: o.pin.library, id: o.pin.id, revision: o.pin.revision, name: o.name },
            verdict: o.verdict,
            specification: o.specification,
            correspondence: altMeta[i]?.correspondence.id as string,
            relation: altMeta[i]?.correspondence.attributes.relation as 'sameAs' | 'conflictsWith',
          })),
        }
      : {}),
    conflict: !opposing
      ? { state: 'none', note: 'no library consulted here disagrees' }
      : settledBy
        ? {
            state: 'settled',
            note: `the libraries disagree; decision ${settledBy.decision} chose which guidance this project follows. It does not make the other guidance wrong, and the disagreement stays recorded in alternatives`,
          }
        : {
            state: 'unsettled',
            note: 'the libraries disagree and no accepted decision has chosen between them',
          },
    ...(settledBy ? { settledBy } : {}),
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
  const evaluated = combine(pattern.type, steps)
  // A required pattern that declares nothing that must hold does not count as met either (A3).
  const declares = steps.some((s) => s.relation === 'appliesWhen' || s.relation === 'requires')
  return evaluated === 'conditionsMet' && !declares ? 'unknown' : evaluated
}

/** Three-valued combination (ADR 0028 §5), kept exactly as approved. */
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
  if (toRational('0', test.unit) === undefined) return unknown('incompatible')
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
