import type {
  ClaimFreshness,
  DecisionFacets,
  ObjectVersion,
  RelationVersion,
} from '@kalyth/contracts'

/** Freshness that means a change needs review before anyone relies on it (ADR 0009). */
const NEEDS_REVIEW = new Set(['stale', 'derived-stale', 'weakened'])

const text = (o: ObjectVersion, key: string) => {
  const v = (o.attributes as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

/**
 * A decision's facets at one revision (ADR 0023), each computed on read and on its own:
 *
 * - freshness: whether the direct changes it rests on still match the source. A change needs
 *   review when its own claim, or the claim of the element it changes, is stale or weakened.
 *   Once an alternative is accepted, only its changes count; while the decision is open, all do.
 * - implementation: how far the tasks that implement the decision or one of its alternatives got.
 * - verification: what git confirmed about the latest report on each of those tasks.
 *
 * Acceptance is the decision's own status and is not repeated here. Nothing is written.
 */
export function decisionFacets(
  decisionId: string,
  objects: ReadonlyMap<string, ObjectVersion>,
  relations: readonly RelationVersion[],
  freshness: ReadonlyMap<string, ClaimFreshness>,
  labelOf: (id: string) => string,
): DecisionFacets {
  const active = relations.filter((r) => r.lifecycle === 'active')
  const alternatives = active
    .filter((r) => r.type === 'alternativeOf' && r.to === decisionId)
    .map((r) => objects.get(r.from))
    .filter((o): o is ObjectVersion => o !== undefined)
  const accepted = alternatives.filter((a) => text(a, 'status') === 'accepted')
  const considered = new Set((accepted.length > 0 ? accepted : alternatives).map((a) => a.id))
  const changes = active.filter((r) => r.type === 'impacts' && considered.has(r.from))

  const stale: DecisionFacets['freshness']['stale'] = []
  let checkable = 0
  for (const change of changes) {
    const own = freshness.get(change.id)
    const target = freshness.get(change.to)
    const checks = (f: ClaimFreshness | undefined) =>
      f !== undefined && f.status !== 'not-applicable'
    if (checks(own) || checks(target)) checkable++
    const worst = [own, target].find((f) => f !== undefined && NEEDS_REVIEW.has(f.status))
    if (!worst) continue
    stale.push({
      relationId: change.id,
      target: change.to,
      label: labelOf(change.to),
      status: worst.status,
      reason:
        worst === own
          ? `the evidence this change cites ${worst.reason.startsWith('derived') ? 'derives from a claim that needs review' : 'no longer matches the source'}`
          : `${labelOf(change.to)} no longer matches the source`,
    })
  }

  // Tasks implementing the decision or one of its alternatives, oldest first.
  const implemented = new Set([decisionId, ...alternatives.map((a) => a.id)])
  const tasks = [
    ...new Set(
      active.filter((r) => r.type === 'implements' && implemented.has(r.to)).map((r) => r.from),
    ),
  ]
    .map((id) => objects.get(id))
    .filter((o): o is ObjectVersion => o?.type === 'core.Task' && o.lifecycle === 'active')
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const statuses = tasks.map((t) => text(t, 'status'))
  const live = statuses.filter((s) => s !== 'cancelled')
  const done = live.filter((s) => s === 'completed').length

  const latest = (type: string, to: string, kind: string) =>
    active
      .filter((r) => r.type === type && r.to === to)
      .map((r) => objects.get(r.from))
      .filter((o): o is ObjectVersion => o?.type === kind)
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0]
  const verdicts = tasks
    .filter((t) => text(t, 'status') !== 'cancelled')
    .map((t) => {
      const report = latest('reports', t.id, 'core.ExecutionReport')
      const check = report ? latest('verifies', report.id, 'core.Verification') : undefined
      return { report, check }
    })
  const partialReport = verdicts.some(
    (v, i) => statuses[i] === 'completed' && v.report && text(v.report, 'outcome') === 'partial',
  )

  let implementation: DecisionFacets['implementation']['state'] = 'none'
  if (live.length > 0) {
    if (done === live.length) implementation = partialReport ? 'partial' : 'complete'
    else if (done > 0) implementation = 'partial'
    else if (live.includes('review')) implementation = 'reported'
    else if (live.includes('running') || live.includes('unknown_outcome'))
      implementation = 'in-progress'
    else implementation = 'planned'
  }

  const passed = verdicts.filter((v) => v.check && text(v.check, 'outcome') === 'pass')
  const failed = verdicts.some((v) => v.check && text(v.check, 'outcome') === 'fail')
  let verification: DecisionFacets['verification']['state'] = 'none'
  if (passed.length > 0 && passed.length === verdicts.length) verification = 'passed'
  else if (passed.length > 0) verification = 'partial'
  else if (failed) verification = 'failed'
  const lastPass = passed
    .map((v) => v.check as ObjectVersion)
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0]

  return {
    freshness: {
      status: stale.length > 0 ? 'stale' : checkable > 0 ? 'current' : 'unchecked',
      changes: changes.length,
      stale,
    },
    implementation: {
      state: implementation,
      tasks: tasks.map((t) => ({ id: t.id, title: text(t, 'title'), status: text(t, 'status') })),
    },
    verification: {
      state: verification,
      coverage: lastPass?.claim.observation?.coverage ?? null,
    },
  }
}
