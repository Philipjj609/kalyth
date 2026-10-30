import type {
  CheckName,
  CheckResult,
  Issue,
  MissingValue,
  ObjectVersion,
  Verdict,
} from '@kalyth/contracts'
import {
  CHECK_CATALOGUE_VERSION,
  CheckName as CheckNames,
  MANDATORY_CHECKS,
} from '@kalyth/contracts'
import type { StateView } from './state.ts'

/** What the checks read about one pinned item, at its pinned revision. */
export interface PinnedFacts {
  name: string
  type: string
  maturity: string
  disputed: boolean
  /** Names of the qualities its `affects` relations worsen. */
  worsens: string[]
}
export type FactsOf = (pin: string, state: StateView) => PinnedFacts | undefined

interface Basis {
  pins: string[]
  covers: string[]
  ruledOut: string[]
  disclosed: {
    disputed: string[]
    hypotheses: string[]
    worsens: string[]
    underspecified: string[]
  }
  unbacked: boolean
}

const basisOf = (o: ObjectVersion): Basis | undefined =>
  o.type === 'core.Alternative' ? (o.attributes.basis as unknown as Basis | undefined) : undefined

/** The text of the open Question asked for one missing value (ADR 0028 §3a). */
export function missingQuestionText(m: MissingValue): string {
  const where = m.element ?? 'the whole system'
  const unit = m.dimension ? ` (${m.dimension})` : ''
  return `What is the ${m.nature} value of "${m.conceptName}" for ${where} in scenario ${m.scenario}${unit}?`
}

const contextKey = (a: ObjectVersion) =>
  [a.attributes.item, a.attributes.scenario, a.attributes.element ?? '', a.attributes.nature].join(
    '|',
  )
const COVERS = new Set<Verdict>(['conditionsMet', 'unknown'])

/**
 * An alternative's basis must not mislead (ADR 0033 §6, A1): every listed assessment exists, is
 * active, assesses one of its pins and has a verdict that matches its list; no exact context is
 * in both lists; every pin has a listed assessment; and what it discloses is among its pins.
 */
export function basisIssues(overlay: StateView, written: ReadonlyMap<string, number>): Issue[] {
  const issues: Issue[] = []
  for (const id of written.keys()) {
    const alt = overlay.getObject(id)
    const basis = alt && alt.lifecycle === 'active' ? basisOf(alt) : undefined
    if (!basis) continue
    const op = written.get(id)
    const add = (message: string) =>
      issues.push({
        code: 'alternative.basis_inconsistent',
        message: `${id}: ${message}`,
        ...(op === undefined ? {} : { op }),
      })
    const pins = new Set(basis.pins)
    const listed = new Map<string, Set<string>>()
    for (const [list, ids] of [
      ['covers', basis.covers],
      ['ruledOut', basis.ruledOut],
    ] as const) {
      for (const aid of ids) {
        const a = overlay.getObject(aid)
        if (a?.type !== 'core.Assessment' || a.lifecycle !== 'active') {
          add(`${aid} in ${list} is not an active assessment`)
          continue
        }
        if (!pins.has(String(a.attributes.item))) {
          add(`${aid} in ${list} assesses ${a.attributes.item}, which the basis does not rely on`)
          continue
        }
        const verdict = a.attributes.verdict as Verdict
        if (list === 'covers' ? !COVERS.has(verdict) : verdict !== 'conditionsNotMet')
          add(`${aid} is ${verdict}, so it cannot be in ${list}`)
        const key = contextKey(a)
        const lists = listed.get(key) ?? new Set<string>()
        lists.add(list)
        listed.set(key, lists)
        pins.delete(String(a.attributes.item))
      }
    }
    for (const [key, lists] of listed)
      if (lists.size > 1) add(`one context (${key}) is both covered and ruled out`)
    for (const pin of pins) add(`${pin} has no listed assessment`)
    const all = new Set(basis.pins)
    const { disputed, hypotheses, underspecified } = basis.disclosed
    for (const pin of [...disputed, ...hypotheses, ...underspecified])
      if (!all.has(pin)) add(`${pin} is disclosed but not relied on`)
  }
  return issues
}

/** Alternatives with a basis among the records written: the ones a proposal's checks cover. */
export function checkedAlternatives(
  overlay: StateView,
  written: Iterable<string>,
): ObjectVersion[] {
  return [...written]
    .map((id) => overlay.getObject(id))
    .filter((o): o is ObjectVersion => o?.lifecycle === 'active' && basisOf(o) !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

/**
 * The check catalogue, version 1 (ADR 0029 §5, ADR 0033 §8): pure functions of the state the
 * proposal produces and the pinned knowledge, reading each alternative's basis. A mandatory
 * failure is let through only by an active CheckException for the same check, version and target.
 */
export function runChecks(
  state: StateView,
  alternatives: readonly ObjectVersion[],
  facts: FactsOf,
): CheckResult[] {
  const results: CheckResult[] = []
  const exceptions = state.listObjects({ types: ['core.CheckException'] })
  const current = (a: ObjectVersion) =>
    a.lifecycle === 'active' &&
    state.listRelations({ types: ['supersedes'], to: a.id }).length === 0
  const assessments = state.listObjects({ types: ['core.Assessment'] }).filter(current)
  const openQuestions = new Set(
    state
      .listObjects({ types: ['core.Question'], attributeEquals: { status: 'open' } })
      .map((q) => String(q.attributes.text)),
  )

  for (const alt of alternatives) {
    const basis = basisOf(alt) as Basis
    const pins = new Set(basis.pins)
    const listed = (ids: string[]) =>
      ids.map((id) => state.getObject(id)).filter((a): a is ObjectVersion => Boolean(a))
    const covered = listed(basis.covers)
    const ruledOut = listed(basis.ruledOut)
    const record = (check: CheckName, failures: string[]) => {
      const severity = MANDATORY_CHECKS.includes(check) ? 'mandatory' : 'advisory'
      const exception =
        failures.length > 0 && severity === 'mandatory'
          ? exceptions.find(
              (e) =>
                e.attributes.check === check &&
                e.attributes.target === alt.id &&
                e.attributes.checkVersion === CHECK_CATALOGUE_VERSION,
            )
          : undefined
      results.push({
        check,
        version: CHECK_CATALOGUE_VERSION,
        severity,
        target: alt.id,
        passed: failures.length === 0,
        detail: failures.length === 0 ? 'passed' : failures.join('; '),
        ...(exception ? { exceptedBy: exception.id } : {}),
      })
    }

    const cites: string[] = []
    if (covered.length === 0) cites.push('it covers no assessed context')
    for (const pin of pins)
      if (![...covered, ...ruledOut].some((a) => a.attributes.item === pin))
        cites.push(`${pin} has no assessment in covers or ruledOut`)
    record('alternatives-cite-assessments', cites)

    const reliance: string[] = []
    for (const c of covered) {
      const same = (a: ObjectVersion) =>
        a.attributes.scenario === c.attributes.scenario &&
        (a.attributes.element ?? '') === (c.attributes.element ?? '') &&
        a.attributes.nature === c.attributes.nature
      for (const a of assessments)
        if (
          pins.has(String(a.attributes.item)) &&
          same(a) &&
          a.attributes.verdict === 'conditionsNotMet'
        )
          reliance.push(`${a.id} rules out ${a.attributes.item} in a context ${c.id} covers`)
    }
    record('no-reliance-on-ruled-out', [...new Set(reliance)])

    const disputed: string[] = []
    const hypotheses: string[] = []
    const worsens: string[] = []
    for (const pin of pins) {
      const f = facts(pin, state)
      if (!f) {
        disputed.push(`${pin}: its library cannot be read, so whether it is disputed is unknown`)
        hypotheses.push(`${pin}: its library cannot be read, so its maturity is unknown`)
        continue
      }
      if (f.disputed && !basis.disclosed.disputed.includes(pin))
        disputed.push(`${f.name} is disputed and not disclosed`)
      if (f.maturity === 'hypothesis' && !basis.unbacked)
        hypotheses.push(`${f.name} is a hypothesis and the alternative is not marked unbacked`)
      for (const q of f.worsens)
        if (!basis.disclosed.worsens.includes(q))
          worsens.push(`${f.name} worsens ${q}, not disclosed`)
    }
    record('disputed-flagged', disputed)
    record('hypotheses-labelled', hypotheses)
    record('worsens-disclosed', worsens)

    const unasked: string[] = []
    for (const c of covered) {
      if (c.attributes.verdict !== 'unknown') continue
      const missing = (c.attributes.explanation as { missing?: MissingValue[] }).missing ?? []
      for (const m of missing)
        if (!openQuestions.has(missingQuestionText(m)))
          unasked.push(`no open Question asks for ${m.conceptName} (${m.nature}) in ${c.id}`)
    }
    record('unknowns-asked', [...new Set(unasked)])
  }
  return results
}

/** Mandatory failures that no CheckException lets through. */
export const blocking = (results: readonly CheckResult[]) =>
  results.filter((r) => r.severity === 'mandatory' && !r.passed && !r.exceptedBy)

export const ALL_CHECKS = CheckNames.options
