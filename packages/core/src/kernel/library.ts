import type {
  Claim,
  ConditionTest,
  Dimension,
  Dispute,
  EvidenceRecord,
  Issue,
  KnowledgeItemStatus,
  Maturity,
  ObjectVersion,
  OperationParsed,
  RelationVersion,
  ResolvedOperation,
  ResolvedWrite,
  SourceMeta,
} from '@kalyth/contracts'
import { EXCERPT_LIMITS, MATURITY_TRANSITIONS, VERIFICATION_TRANSITIONS } from '@kalyth/contracts'
import { AffectsProperties } from '../registry/knowledge.ts'
import type { OverlayState, StateView } from './state.ts'
import {
  establishedGaps,
  groupCounts,
  supportGroupKey,
  VERIFIABLE_KINDS,
  verificationStatus,
} from './support.ts'
import { jointlySatisfiable, parseDecimal, toBase } from './units.ts'

type Add = (code: string, message: string, path?: (string | number)[]) => void
type Record_ = ObjectVersion | RelationVersion
type Curation = Extract<ResolvedOperation, { op: 'setMaturity' | 'reviewSupport' | 'verifySource' }>

export const CURATION_OPS = new Set(['setMaturity', 'reviewSupport', 'verifySource'])

export const isKnowledgeType = (type: string): boolean => type.startsWith('knowledge.')

/** A knowledge claim: on a knowledge object, or on a relation between two knowledge objects. */
export function isKnowledgeRecord(state: StateView, record: Record_): boolean {
  if ('from' in record) {
    const from = state.getObject(record.from)
    const to = state.getObject(record.to)
    return Boolean(from && to && isKnowledgeType(from.type) && isKnowledgeType(to.type))
  }
  return isKnowledgeType(record.type)
}

const metaOf = (e: EvidenceRecord | undefined): SourceMeta | undefined =>
  e && (e.source.kind === 'document' || e.source.kind === 'external') ? e.source.meta : undefined

/** Where a source sits, for counting quotes per source: its uri. */
const sourceKey = (e: EvidenceRecord): string | undefined =>
  e.source.kind === 'document' || e.source.kind === 'external' ? e.source.uri : undefined

/**
 * Rules for evidence recorded in a library (ADR 0026 §7, ADR 0030 A5). The excerpt's length is
 * checked on the submitted text, before it is stored; see `libraryInputIssues`.
 */
export function checkLibraryEvidence(
  op: Extract<ResolvedOperation, { op: 'recordEvidence' }>,
  add: Add,
): void {
  const source = op.source
  if (source.kind === 'sourceSpan') {
    add('library.source_span_not_allowed', 'a library cites documents and statements, not code')
    return
  }
  if (source.kind !== 'document' && source.kind !== 'external') return
  if (!source.meta) {
    add('library.source_meta_required', 'a library source needs SourceMeta', ['evidence', 'meta'])
    return
  }
  const locator =
    source.kind === 'document' ? (source.locator ?? source.meta.locator) : source.meta.locator
  if (!locator)
    add('library.locator_required', 'say where in the source the passage is', ['evidence'])
  if (source.meta.quotePolicy === 'none' && op.excerpt)
    add('library.quote_not_allowed', 'this source allows a paraphrase and locator only', [
      'evidence',
      'excerpt',
    ])
}

/** Checks on the submitted operations that need the excerpt text itself. */
export function libraryInputIssues(ops: readonly OperationParsed[]): Issue[] {
  const issues: Issue[] = []
  ops.forEach((op, index) => {
    if (op.op !== 'recordEvidence') return
    const source = op.evidence.source
    const meta = source.kind === 'document' || source.kind === 'external' ? source.meta : undefined
    const excerpt = op.evidence.excerpt
    if (meta?.quotePolicy === 'excerpt' && excerpt && excerpt.length > EXCERPT_LIMITS.maxChars)
      issues.push({
        code: 'library.quote_too_long',
        message: `quotes from this source are at most ${EXCERPT_LIMITS.maxChars} characters`,
        op: index,
        path: ['evidence', 'excerpt'],
      })
  })
  return issues
}

// ---------- curation operations (ADR 0030 §3, A1 to A4) ----------

function activeRecord(state: StateView, id: string, add: Add): Record_ | undefined {
  const record = state.getObject(id) ?? state.getRelation(id)
  if (!record) {
    add('record.not_found', `${id} does not exist`)
    return undefined
  }
  if (record.lifecycle !== 'active') {
    add('record.retired', `${id} is retired`)
    return undefined
  }
  if (!isKnowledgeRecord(state, record)) {
    add('knowledge.not_knowledge', `${id} is not a knowledge item`)
    return undefined
  }
  return record
}

function withClaim(record: Record_, claim: Claim, revision: number): ResolvedWrite {
  return 'from' in record
    ? { kind: 'relation', version: { ...record, claim, revision } }
    : { kind: 'object', version: { ...record, claim, revision } }
}

const citing = (record: Record_, evidence: string) =>
  record.claim.supports.some((g) => g.allOf.includes(evidence))

/**
 * Applies one curation operation to the overlay. Returns, for `verifySource` without targets at
 * proposal time, the claims it found, which the proposal records (A1).
 */
export function applyCuration(
  overlay: OverlayState,
  op: Curation,
  revision: number,
  write: (w: ResolvedWrite) => void,
  add: Add,
): string[] | undefined {
  switch (op.op) {
    case 'setMaturity': {
      const current = overlay.getObject(op.id)
      if (current?.lifecycle !== 'active' || !isKnowledgeType(current.type)) {
        add('knowledge.not_knowledge', `${op.id} is not an active knowledge item`)
        return
      }
      const from = current.attributes.maturity as Maturity
      if (!MATURITY_TRANSITIONS[from]?.includes(op.maturity)) {
        add('maturity.transition_invalid', `maturity cannot go from ${from} to ${op.maturity}`)
        return
      }
      write({
        kind: 'object',
        version: {
          ...current,
          attributes: { ...current.attributes, maturity: op.maturity, maturityReason: op.reason },
          revision,
        },
      })
      return
    }

    case 'reviewSupport': {
      const record = activeRecord(overlay, op.target, add)
      if (!record) return
      const supports = record.claim.supports
      const index = supports.findIndex((g) => supportGroupKey(g.allOf) === op.group)
      const group = supports[index]
      if (!group) {
        add('support.group_not_found', `${op.target} has no support group ${op.group}`, ['group'])
        return
      }
      const { verdict, scopeLimit } = op.review
      if (verdict === 'partly' && !scopeLimit) {
        add('support.scope_limit_required', 'a partial review says where the support holds', [
          'scopeLimit',
        ])
        return
      }
      if (verdict !== 'partly' && scopeLimit) {
        add('support.scope_limit_unexpected', 'only a partial review carries a scope limit', [
          'scopeLimit',
        ])
        return
      }
      // A group a person found unsupportive leaves the claim (ADR 0026 §6).
      const next =
        verdict === 'doesNotSupport'
          ? supports.filter((_, i) => i !== index)
          : supports.map((g, i) => (i === index ? { ...g, review: op.review } : g))
      if (next.length === 0) {
        add('claim.support_required', 'the claim would be left without support')
        return
      }
      write(withClaim(record, { ...record.claim, supports: next }, revision))
      return
    }

    case 'verifySource': {
      const evidence = overlay.getEvidence(op.evidence)
      if (!evidence) {
        add('evidence.not_found', `evidence ${op.evidence} does not exist`, ['evidence'])
        return
      }
      if (!VERIFIABLE_KINDS.has(evidence.source.kind)) {
        add(
          'verify.kind_not_verifiable',
          `${evidence.source.kind} evidence is not verified this way`,
        )
        return
      }
      const v = op.verification
      if (v.method === 'retrievedHash' && !v.retrievedSha256)
        add('verify.hash_required', 'a retrieved hash needs retrievedSha256', ['retrievedSha256'])
      if (v.method === 'manual' && v.retrievedSha256)
        add('verify.hash_unexpected', 'a manual check carries no retrieved hash', [
          'retrievedSha256',
        ])
      if (v.status === 'unverified' && v.method !== 'manual')
        add('verify.withdraw_manual', 'withdrawing a verification is a manual step', ['method'])
      const found = [...overlay.listObjects({}), ...overlay.listRelations({})]
        .filter((r) => citing(r, op.evidence) && isKnowledgeRecord(overlay, r))
        .map((r) => r.id)
        .sort()
      let targets = op.targets
      let expansion: string[] | undefined
      if (op.allCiting) {
        if (targets.length === 0) {
          targets = found
          expansion = found
          if (found.length === 0)
            add('verify.no_citing_claims', `no claim in this library cites ${op.evidence}`)
        } else if ([...targets].sort().join() !== found.join()) {
          add(
            'verify.citing_claims_changed',
            `the claims citing ${op.evidence} changed since the proposal was made`,
          )
          return expansion
        }
      }
      for (const id of targets) {
        const record = activeRecord(overlay, id, add)
        if (!record) continue
        if (!citing(record, op.evidence)) {
          add('verify.not_cited', `${id} does not cite ${op.evidence} as support`, ['targets'])
          continue
        }
        let unchanged = false
        const supports = record.claim.supports.map((g) => {
          if (!g.allOf.includes(op.evidence)) return g
          const from = verificationStatus(g, op.evidence)
          if (!VERIFICATION_TRANSITIONS[from].includes(v.status)) unchanged = true
          return { ...g, verifications: { ...g.verifications, [op.evidence]: v } }
        })
        if (unchanged) {
          add('verify.no_change', `${id} has no verification of ${op.evidence} to withdraw`)
          continue
        }
        write(withClaim(record, { ...record.claim, supports }, revision))
      }
      return expansion
    }
  }
}

// ---------- rules on the state a proposal produces ----------

/**
 * Library rules checked once, on the state the whole proposal produces (ADR 0030 A3): support,
 * groups, quotes, established items, pattern trade-offs and condition validity. `written` maps
 * each written id to the last operation that wrote it, for the issue.
 */
export function checkLibraryState(
  overlay: StateView,
  written: ReadonlyMap<string, number>,
): Issue[] {
  const issues: Issue[] = []
  const at = (id: string) => written.get(id)
  const add = (id: string, code: string, message: string) => {
    const op = at(id)
    issues.push(op === undefined ? { code, message } : { code, message, op })
  }
  const touchedItems = new Set<string>()
  const touchedConcepts = new Set<string>()

  for (const id of written.keys()) {
    const record = overlay.getObject(id) ?? overlay.getRelation(id)
    if (record?.lifecycle !== 'active') {
      // Retiring a trade-off, a condition or a question can break a pattern's rules.
      if (record && 'from' in record) {
        touchedItems.add(record.from)
        touchedItems.add(record.to)
      }
      continue
    }
    if ('from' in record) {
      touchedItems.add(record.from)
      touchedItems.add(record.to)
      checkRelation(overlay, record, (code, message) => add(id, code, message))
    } else {
      if (record.type.startsWith('software.'))
        add(
          id,
          'library.software_not_allowed',
          'a library holds no software elements (ADR 0026 I1)',
        )
      touchedItems.add(id)
      if (record.type === 'knowledge.Concept') touchedConcepts.add(id)
      if (record.type === 'knowledge.Condition')
        checkCondition(overlay, record, (code, message) => add(id, code, message))
      if (record.type === 'knowledge.Condition' || record.type === 'core.Question')
        for (const r of [
          ...overlay.listRelations({ to: id }),
          ...overlay.listRelations({ from: id }),
        ])
          touchedItems.add(r.type === 'concerns' ? r.to : r.from)
    }
    if (isKnowledgeRecord(overlay, record))
      checkKnowledgeClaim(overlay, record, (code, message) => add(id, code, message))
  }

  // A changed concept re-checks the conditions on it.
  for (const concept of touchedConcepts)
    for (const condition of overlay.listObjects({
      types: ['knowledge.Condition'],
      attributeEquals: { subject: concept },
    }))
      checkCondition(overlay, condition, (code, message) => add(concept, code, message))

  for (const id of touchedItems) {
    const item = overlay.getObject(id)
    if (item?.lifecycle !== 'active') continue
    const say = (code: string, message: string) => add(id, code, message)
    if (item.type === 'knowledge.Pattern') checkTradeoff(overlay, item, say)
    if (item.type === 'knowledge.Pattern' || item.type === 'knowledge.Principle')
      checkSatisfiable(overlay, item, say)
  }
  return issues
}

function checkKnowledgeClaim(
  state: StateView,
  record: Record_,
  add: (code: string, message: string) => void,
): void {
  const claim = record.claim
  if (claim.supports.length === 0) {
    add('library.support_required', 'knowledge must cite its support (ADR 0026 I2)')
    return
  }
  const keys = claim.supports.map((g) => supportGroupKey(g.allOf))
  if (new Set(keys).size !== keys.length)
    add('support.duplicate_group', 'two support groups cite the same evidence')
  const quotes = new Map<string, number>()
  for (const id of new Set([...claim.supports.flatMap((g) => g.allOf), ...claim.contradictedBy])) {
    const evidence = state.getEvidence(id)
    if (!evidence) continue
    if (evidence.source.kind === 'sourceSpan')
      add('library.source_span_not_allowed', `${id} cites code, which a library may not`)
    const key = sourceKey(evidence)
    if (key && evidence.excerpt && metaOf(evidence)?.quotePolicy === 'excerpt')
      quotes.set(key, (quotes.get(key) ?? 0) + 1)
  }
  for (const [uri, count] of quotes)
    if (count > EXCERPT_LIMITS.maxPerSourcePerClaim)
      add(
        'library.too_many_quotes',
        `${count} quotes from ${uri}; at most ${EXCERPT_LIMITS.maxPerSourcePerClaim} per claim`,
      )
  if (!('from' in record) && record.attributes.maturity === 'established') {
    const gaps = establishedGaps(claim, (id) => state.getEvidence(id))
    if (gaps.length > 0)
      add(
        'maturity.established_gaps',
        `established needs every group reviewed and every source verified (ADR 0026 I3): ${gaps.join('; ')}`,
      )
  }
}

function checkRelation(
  state: StateView,
  relation: RelationVersion,
  add: (code: string, message: string) => void,
): void {
  const from = state.getObject(relation.from)
  const to = state.getObject(relation.to)
  if (!from || !to) return
  const conceptKind = to.type === 'knowledge.Concept' ? (to.attributes.kind as string) : undefined
  switch (relation.type) {
    case 'addresses':
      if (conceptKind !== 'quality' && conceptKind !== 'property')
        add('relation.concept_kind', 'addresses ends at a quality or property concept')
      break
    case 'affects': {
      if (conceptKind !== 'quality')
        add('relation.concept_kind', 'affects ends at a quality concept')
      const parsed = AffectsProperties.safeParse(relation.properties)
      if (!parsed.success) {
        add(
          'relation.properties_invalid',
          'affects needs effect (improves, worsens or mixed) and note',
        )
        break
      }
      for (const c of parsed.data.conditions ?? [])
        if (state.getObject(c)?.type !== 'knowledge.Condition')
          add('relation.properties_invalid', `${c} is not a condition of this library`)
      break
    }
    case 'supersedes':
    case 'requires':
      if (from.type !== to.type || !isKnowledgeType(from.type))
        add('relation.endpoint_type', `in a library, ${relation.type} joins two items of one type`)
      break
  }
}

function checkCondition(
  state: StateView,
  condition: ObjectVersion,
  add: (code: string, message: string) => void,
): void {
  const subject = state.getObject(String(condition.attributes.subject))
  if (
    subject?.lifecycle !== 'active' ||
    subject.type !== 'knowledge.Concept' ||
    !['quantity', 'property'].includes(subject.attributes.kind as string)
  ) {
    add('condition.subject_invalid', 'a condition tests an active quantity or property concept')
    return
  }
  const dimension = subject.attributes.dimension as Dimension | undefined
  const test = condition.attributes.test as ConditionTest
  for (const problem of testProblems(
    test,
    dimension,
    subject.attributes.values as string[] | undefined,
  ))
    add('condition.test_invalid', problem)
}

function testProblems(
  test: ConditionTest,
  dimension: Dimension | undefined,
  values: readonly string[] | undefined,
): string[] {
  if (!dimension) return ['the concept has no dimension to test']
  if (test.op === 'is')
    return dimension === 'boolean' ? [] : [`"is" tests a boolean, not ${dimension}`]
  if (test.op === 'in') {
    if (dimension !== 'category') return [`"in" tests a category, not ${dimension}`]
    const unknown = test.values.filter((v) => !values?.includes(v))
    return unknown.length ? [`not values of the concept: ${unknown.join(', ')}`] : []
  }
  const numbers = test.op === 'between' ? [test.min, test.max] : [test.value]
  const problems = numbers.flatMap((n) => {
    const r = toBase(n, test.unit, dimension)
    return 'error' in r ? [r.error] : []
  })
  if (problems.length === 0 && test.op === 'between') {
    const min = parseDecimal(test.min)
    const max = parseDecimal(test.max)
    if (min.n * max.d > max.n * min.d) problems.push('between needs min <= max')
  }
  return [...new Set(problems)]
}

/** ADR 0026 §3: a pattern states a trade-off, or an open Question says none is known yet. */
function checkTradeoff(
  state: StateView,
  pattern: ObjectVersion,
  add: (c: string, m: string) => void,
) {
  if (state.listRelations({ types: ['affects'], from: pattern.id }).length > 0) return
  const asked = state.listRelations({ types: ['concerns'], to: pattern.id }).some((r) => {
    const q = state.getObject(r.from)
    return q?.type === 'core.Question' && q.lifecycle === 'active' && q.attributes.status === 'open'
  })
  if (!asked)
    add(
      'pattern.tradeoff_required',
      'a pattern states at least one affects trade-off, or an open Question about its trade-offs',
    )
}

/** ADR 0028 §7: the appliesWhen conditions of one item must be able to hold together. */
function checkSatisfiable(
  state: StateView,
  item: ObjectVersion,
  add: (c: string, m: string) => void,
) {
  const bySubject = new Map<string, { tests: ConditionTest[]; dimension: Dimension }>()
  for (const r of state.listRelations({ types: ['appliesWhen'], from: item.id })) {
    const condition = state.getObject(r.to)
    const subject = condition && state.getObject(String(condition.attributes.subject))
    const dimension = subject?.attributes.dimension as Dimension | undefined
    if (!condition || !subject || !dimension) continue
    const test = condition.attributes.test as ConditionTest
    if (testProblems(test, dimension, subject.attributes.values as string[] | undefined).length)
      continue
    const entry = bySubject.get(subject.id) ?? { tests: [], dimension }
    entry.tests.push(test)
    bySubject.set(subject.id, entry)
  }
  for (const [subject, { tests, dimension }] of bySubject) {
    const base = (value: string, unit: string) => {
      const r = toBase(value, unit, dimension)
      return 'error' in r ? parseDecimal(value) : r.value
    }
    if (!jointlySatisfiable(tests, base))
      add(
        'condition.unsatisfiable',
        `the appliesWhen conditions on ${subject} cannot all hold, so the item would never apply`,
      )
  }
}

// ---------- read model: maturity, dispute and support, computed on read ----------

/**
 * Dispute (ADR 0026 §4, ADR 0030 C4): a committed `contradicts` from knowledge that is proposed
 * or established and not superseded, or `contradictedBy` evidence on the item's own claim.
 */
export function disputeOf(state: StateView, item: ObjectVersion): Dispute {
  const by = [
    ...state.listRelations({ types: ['contradicts'], to: item.id }).map((r) => r.from),
    ...state.listRelations({ types: ['contradicts'], from: item.id }).map((r) => r.to),
  ].filter((id) => {
    const other = state.getObject(id)
    if (other?.lifecycle !== 'active' || !isKnowledgeType(other.type)) return false
    if (!['proposed', 'established'].includes(other.attributes.maturity as string)) return false
    return state.listRelations({ types: ['supersedes'], to: id }).length === 0
  })
  const unique = [...new Set(by)].sort()
  const contradictedBy = [...item.claim.contradictedBy]
  return {
    status: unique.length > 0 || contradictedBy.length > 0 ? 'disputed' : 'none',
    by: unique,
    contradictedBy,
  }
}

export function knowledgeStatus(state: StateView, item: ObjectVersion): KnowledgeItemStatus {
  const evidence = (id: string) => state.getEvidence(id)
  const groups = item.claim.supports.map((g) => ({
    key: supportGroupKey(g.allOf),
    allOf: [...g.allOf],
    review: g.review?.verdict ?? 'unreviewed',
    ...(g.review?.scopeLimit ? { scopeLimit: g.review.scopeLimit } : {}),
    sources: g.allOf.map((id) => {
      const e = evidence(id)
      const kind = e?.source.kind ?? 'missing'
      return {
        evidence: id,
        kind,
        quoted: Boolean(e?.excerpt),
        verification: VERIFIABLE_KINDS.has(kind) ? verificationStatus(g, id) : null,
      }
    }),
    counts: groupCounts(g),
  }))
  return {
    id: item.id,
    type: item.type,
    maturity: item.attributes.maturity as Maturity,
    dispute: disputeOf(state, item),
    supported: groups.some((g) => g.counts),
    establishedGaps: establishedGaps(item.claim, evidence),
    groups,
  }
}
