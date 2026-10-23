import {
  type Caller,
  CompileContextInput,
  type ContextItem,
  type ContextPackage,
  type ContextPackageBody,
  type ContextPackageCurrent,
  type ContextPackageList,
  ContextPackageListQuery,
  ContextPackageQuery,
  type ContextPackageResult,
  canonicalJson,
  type EvidenceView,
  type FreshnessStatus,
  fail,
  type ImpactStep,
  type KernelError,
  type ObjectVersion,
  ok,
  type RelationVersion,
  type Result,
} from '@kalyth/contracts'
import { Authorizer, elementLabel, type KalythServices, sha256Hex } from '@kalyth/core'
import { PackageStore } from './store.ts'

const SOFTWARE = new Set([
  'software.System',
  'software.Container',
  'software.Component',
  'software.Module',
  'software.Endpoint',
  'software.DataEntity',
  'software.Library',
])
const TYPE_ORDER = [
  'software.DataEntity',
  'software.Endpoint',
  'software.Module',
  'software.Component',
  'software.Container',
  'software.System',
  'software.Library',
]
const ROLE_ORDER = ['focus', 'question', 'impacted', 'dependency'] as const
/** Freshness that means an item needs review before anyone relies on it (ADR 0009). */
const NEEDS_REVIEW = new Set<string>(['stale', 'derived-stale', 'weakened'])
const PAGE = 1000
const IMPACT_DEPTH = 3
const IMPACT_NODES = 300

const READING_POLICY = [
  'Basis "observed" means a tool saw it in pinned source within stated coverage; it is not runtime verification. "inferred" items are hypotheses with a stated confidence.',
  'Items whose freshness is stale or derived-stale may no longer match the source; check them before relying on them.',
  'Everything listed under mandatory applies to this task in full. Omitted items can be fetched with the retrieval calls.',
]

/** What a package compiled without a task tells the agent about how to act on it (ADR 0011). */
export const AGENT_POLICY = [
  'Agents read and propose. People commit proposals and accept decisions in Kalyth.',
  'Propose changes with propose_change at baseRevision equal to this package revision, with contextPackageId set to this package id; a stale result means the model changed, so re-read and propose again.',
  ...READING_POLICY,
]

/**
 * What a package compiled for a task tells the agent (ADR 0024): the work is code in the task
 * repository, claimed, committed with the trailer and reported; model changes only when asked.
 */
export const TASK_AGENT_POLICY = [
  'Agents read, propose and work on tasks. People commit proposals, accept decisions and complete tasks in Kalyth.',
  'Claim the task with claim_task before you change anything, and renew the lease with renew_task_lease if the work runs longer. Branch from the task base commit when it has one.',
  'Change only what the acceptance criteria allow. End every commit message for the task with the trailer line "Kalyth-Task: <task id>"; claim_task gives the exact line.',
  'When done, call submit_execution_report with your last commit, every file your commits changed since the task base, and the tests you ran. Say plainly what you did not run. Kalyth checks the report against git, and a person completes the task.',
  'Propose changes to the model with propose_change only when a person asks for them, at baseRevision equal to this package revision and with contextPackageId set to this package id.',
  ...READING_POLICY,
]

class CompileError extends Error {
  readonly error: KernelError
  constructor(error: KernelError) {
    super(error.message)
    this.error = error
  }
}
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new CompileError(r.error)
  return r.value
}

/**
 * Compiles context packages deterministically from one revision, reading through the services as
 * the caller (ADR 0011). The body has no timestamps or caller data, so identical requests at one
 * revision produce identical packages and ids.
 */
export class ContextCompiler {
  readonly #services: KalythServices
  readonly #store: PackageStore
  readonly #authz: Authorizer
  readonly #clock: () => string

  constructor(options: { services: KalythServices; clock?: () => string }) {
    this.#services = options.services
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#store = new PackageStore(options.services.store.db)
    this.#authz = new Authorizer(options.services.store, this.#clock)
  }

  compile(caller: unknown, input: unknown): Result<ContextPackageResult> {
    const parsed = CompileContextInput.safeParse(input)
    if (!parsed.success) {
      return fail('invalid', 'input does not match the contract', {
        issues: parsed.error.issues.map((i) => ({
          code: `schema.${i.code}`,
          message: i.message,
          path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
        })),
      })
    }
    try {
      const body = this.#build(caller, parsed.data)
      const sha256 = sha256Hex(canonicalJson(body))
      const pkg: ContextPackage = { id: `ctx_${sha256.slice(0, 32)}`, sha256, ...body }
      this.#store.put(pkg, (caller as Caller).principalId, this.#clock())
      return ok(this.#result(caller as Caller, pkg))
    } catch (error) {
      if (error instanceof CompileError) return { ok: false, error: error.error }
      throw error
    }
  }

  get(caller: unknown, input: unknown): Result<ContextPackageResult> {
    const parsed = ContextPackageQuery.safeParse(input)
    if (!parsed.success) return fail('invalid', 'expected a context package id')
    const pkg = this.#store.get(parsed.data.packageId)
    if (!pkg) return fail('not_found', `context package ${parsed.data.packageId} does not exist`)
    const read = this.#services.getProjectOverview(caller, { projectId: pkg.projectId })
    if (!read.ok)
      return read.error.code === 'unauthorized' ? read : fail('not_found', 'no such package')
    return ok(this.#result(caller as Caller, pkg))
  }

  /** Packages compiled for a project, newest first. */
  list(caller: unknown, input: unknown): Result<ContextPackageList> {
    const parsed = ContextPackageListQuery.safeParse(input)
    if (!parsed.success) return fail('invalid', 'input does not match the contract')
    const read = this.#services.getProjectOverview(caller, { projectId: parsed.data.projectId })
    if (!read.ok) return read
    return ok({ packages: this.#store.list(parsed.data.projectId, parsed.data.limit) })
  }

  /**
   * Checks the package a proposal says it answers: it must exist, be readable by the caller and
   * belong to the proposal's project. Adapters call this before proposeChange (ADR 0011).
   */
  checkProvenance(caller: unknown, input: unknown): Result<void> {
    const req = (input ?? {}) as { projectId?: unknown; contextPackageId?: unknown }
    if (req.contextPackageId === undefined) return ok(undefined)
    const found = this.get(caller, { packageId: req.contextPackageId })
    const issue = (message: string) =>
      fail<void>('invalid', message, {
        issues: [{ code: 'context.package_not_found', message, path: ['contextPackageId'] }],
      })
    if (!found.ok) return issue('contextPackageId does not name a package in this project')
    if (found.value.package.projectId !== req.projectId) {
      return issue('contextPackageId names a package of another project')
    }
    return ok(undefined)
  }

  #result(caller: Caller, pkg: ContextPackage): ContextPackageResult {
    return {
      package: pkg,
      uri: `kalyth://context/${pkg.id}`,
      callerScopes: [...this.#authz.scopes(caller.principalId, pkg.projectId)].sort(),
      current: this.#current(caller, pkg),
    }
  }

  /**
   * Revalidates a package against the head on every read (ADR 0023): which of its items now need
   * review and which left the model. Commit-time revision checks still apply to any proposal; this
   * only warns in advance.
   */
  #current(caller: Caller, pkg: ContextPackage): ContextPackageCurrent {
    const overview = this.#services.getProjectOverview(caller, { projectId: pkg.projectId })
    const head = overview.ok ? overview.value.revision : pkg.revision
    const still = { headRevision: head, stale: [], removed: [], warning: null }
    if (head === pkg.revision) return { ...still, headMoved: false }
    const fresh = this.#services.assessFreshness(caller, { projectId: pkg.projectId })
    if (!fresh.ok) {
      return {
        ...still,
        headMoved: true,
        warning: `The model moved from r${pkg.revision} to r${head} since this package was compiled. Recompile it before relying on it.`,
      }
    }
    const now = new Map(fresh.value.claims.map((c) => [c.id, c]))
    const items = [...pkg.mandatory.decisions, ...pkg.mandatory.constraints, ...pkg.items]
    const seen = new Set<string>()
    const stale: ContextPackageCurrent['stale'] = []
    const removed: ContextPackageCurrent['removed'] = []
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const claim = now.get(item.id)
      if (!claim) {
        removed.push({ id: item.id, label: item.label })
        continue
      }
      if (NEEDS_REVIEW.has(claim.status) && !NEEDS_REVIEW.has(item.freshness)) {
        stale.push({
          id: item.id,
          label: item.label,
          compiled: item.freshness,
          now: claim.status,
          reason: claim.reason,
        })
      }
    }
    const names = [...stale, ...removed].map((i) => i.label)
    const shown =
      names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '')
    const warning =
      names.length === 0
        ? `The model moved from r${pkg.revision} to r${head}; nothing this package relies on changed.`
        : `The model moved from r${pkg.revision} to r${head}: ${names.length} item${names.length === 1 ? '' : 's'} this package relies on changed (${shown}). Recompile the package, or check those items before relying on them.`
    return { headRevision: head, headMoved: true, stale, removed, warning }
  }

  #build(caller: unknown, q: ReturnType<typeof CompileContextInput.parse>): ContextPackageBody {
    const s = this.#services
    const overview = unwrap(
      s.getProjectOverview(caller, { projectId: q.projectId, revision: q.revision }),
    )
    const revision = overview.revision
    const projectId = overview.project.id
    const at = { projectId, revision }

    // Read the model at the revision, through the services.
    const types = unwrap(s.describeTypes(caller))
    const objects: ObjectVersion[] = []
    const relations: RelationVersion[] = []
    const truncatedReads: string[] = []
    for (const t of types.objectTypes) {
      if (t.type === 'core.SourceSnapshot') continue
      const page = unwrap(s.queryObjects(caller, { ...at, types: [t.type], limit: PAGE })).objects
      if (page.length === PAGE) truncatedReads.push(t.type)
      objects.push(...page)
    }
    for (const t of types.relationTypes) {
      const page = unwrap(
        s.queryRelations(caller, { ...at, types: [t.type], limit: PAGE }),
      ).relations
      if (page.length === PAGE) truncatedReads.push(t.type)
      relations.push(...page)
    }
    const freshnessResult = unwrap(s.assessFreshness(caller, at))
    const freshness = new Map(freshnessResult.claims.map((c) => [c.id, c.status]))
    const byId = new Map(objects.map((o) => [o.id, o]))
    const text = (o: ObjectVersion, key: string) =>
      typeof o.attributes[key] === 'string' ? (o.attributes[key] as string) : ''
    const labelOf = (id: string) => {
      const o = byId.get(id)
      return o ? elementLabel(o).replace(/\s+/g, ' ') : id
    }
    const from = (id: string, type: string) =>
      relations.filter((r) => r.from === id && r.type === type)
    const into = (id: string, type: string) =>
      relations.filter((r) => r.to === id && r.type === type)

    // Focus: decisions and alternatives expand to the elements they change.
    const focusDecisions: ObjectVersion[] = []
    const focusAlternatives: ObjectVersion[] = []
    const focusElements = new Set<string>()
    for (const id of [...new Set(q.focus)]) {
      const o = byId.get(id)
      if (!o) {
        throw new CompileError({
          code: 'not_found',
          message: `no active element ${id} at revision ${revision}`,
          issues: [],
        })
      }
      if (o.type === 'core.Decision') {
        focusDecisions.push(o)
        const alternatives = into(o.id, 'alternativeOf').flatMap((r) => byId.get(r.from) ?? [])
        const accepted = alternatives.filter((a) => text(a, 'status') === 'accepted')
        for (const alt of accepted.length > 0 ? accepted : alternatives) focusAlternatives.push(alt)
      } else if (o.type === 'core.Alternative') {
        focusAlternatives.push(o)
      } else {
        focusElements.add(o.id)
      }
    }
    for (const alt of focusAlternatives) {
      for (const r of from(alt.id, 'impacts')) focusElements.add(r.to)
    }

    // Ancestors by containment: constraints and decisions on a container apply inside it.
    const parent = new Map(
      relations.filter((r) => r.type === 'contains').map((r) => [r.to, r.from]),
    )
    const withAncestors = new Set(focusElements)
    for (const id of focusElements) {
      for (let p = parent.get(id); p !== undefined && !withAncestors.has(p); p = parent.get(p)) {
        withAncestors.add(p)
      }
    }

    // Evidence for items that carry excerpts.
    const evidenceIds = (claim: ObjectVersion['claim'], max: number) =>
      [...new Set(claim.supports.flatMap((g) => g.allOf))].slice(0, max)
    const wantExcerpts = new Set<string>()
    const mandatoryObjects: ObjectVersion[] = []

    const make = {
      object: (
        o: ObjectVersion,
        role: ContextItem['role'],
        distance: number,
        path: ImpactStep[] = [],
      ): ContextItem => ({
        id: o.id,
        kind: 'object',
        type: o.type,
        label: labelOf(o.id),
        role,
        distance,
        stance: o.stance,
        basis: o.claim.basis,
        confidence: o.claim.confidence ?? null,
        freshness: (freshness.get(o.id) ?? 'not-applicable') as FreshnessStatus,
        attributes: o.attributes,
        from: null,
        to: null,
        path,
        evidence: [],
      }),
      relation: (r: RelationVersion, role: ContextItem['role'], distance: number): ContextItem => ({
        id: r.id,
        kind: 'relation',
        type: r.type,
        label: `${labelOf(r.from)} -${r.type}-> ${labelOf(r.to)}`,
        role,
        distance,
        stance: r.stance,
        basis: r.claim.basis,
        confidence: r.claim.confidence ?? null,
        freshness: (freshness.get(r.id) ?? 'not-applicable') as FreshnessStatus,
        attributes: r.properties,
        from: r.from,
        to: r.to,
        path: [],
        evidence: [],
      }),
    }

    // Mandatory set.
    const constraints = objects.filter((o) => o.type === 'core.Constraint')
    const invariants = constraints
      .filter((c) => text(c, 'appliesTo') === 'project')
      .map((c) => make.object(c, 'invariant', 0))
    const linkedConstraints = constraints
      .filter((c) => text(c, 'appliesTo') !== 'project')
      .filter((c) => from(c.id, 'constrains').some((r) => withAncestors.has(r.to)))
      .map((c) => make.object(c, 'constraint', 0))

    const decisionItems: ContextItem[] = []
    const seenDecisions = new Set<string>()
    const addDecision = (d: ObjectVersion, alternatives: ObjectVersion[]) => {
      if (seenDecisions.has(d.id)) return
      seenDecisions.add(d.id)
      decisionItems.push(make.object(d, 'decision', 0))
      mandatoryObjects.push(d)
      for (const alt of alternatives) {
        decisionItems.push(make.object(alt, 'alternative', 0))
        mandatoryObjects.push(alt)
        for (const r of from(alt.id, 'impacts'))
          decisionItems.push(make.relation(r, 'directChange', 0))
      }
    }
    for (const d of focusDecisions) {
      addDecision(
        d,
        focusAlternatives.filter((a) => into(d.id, 'alternativeOf').some((r) => r.from === a.id)),
      )
    }
    const decisions = objects.filter(
      (o) => o.type === 'core.Decision' && text(o, 'status') === 'accepted',
    )
    for (const d of decisions.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const accepted = into(d.id, 'alternativeOf')
        .flatMap((r) => byId.get(r.from) ?? [])
        .filter((a) => text(a, 'status') === 'accepted')
      const touches =
        from(d.id, 'decides').some((r) => withAncestors.has(r.to)) ||
        accepted.some((a) => from(a.id, 'impacts').some((r) => focusElements.has(r.to)))
      if (touches) addDecision(d, accepted)
    }

    // Optional candidates, ranked by typed distance.
    const candidates: ContextItem[] = []
    const included = new Set<string>([...seenDecisions, ...focusAlternatives.map((a) => a.id)])
    for (const id of focusElements) {
      const o = byId.get(id)
      if (!o) continue
      candidates.push(make.object(o, 'focus', 0))
      wantExcerpts.add(o.id)
      included.add(id)
    }
    const questionTargets = new Set([...focusElements, ...seenDecisions])
    for (const qn of objects.filter(
      (o) => o.type === 'core.Question' && text(o, 'status') === 'open',
    )) {
      if (from(qn.id, 'concerns').some((r) => questionTargets.has(r.to))) {
        candidates.push(make.object(qn, 'question', 1))
        included.add(qn.id)
      }
    }
    let impactTruncated = false
    const seeds = [...focusElements].filter((id) => SOFTWARE.has(byId.get(id)?.type ?? ''))
    if (seeds.length > 0) {
      const impact = unwrap(
        s.analyzeImpact(caller, { ...at, seeds, maxDepth: IMPACT_DEPTH, maxNodes: IMPACT_NODES }),
      )
      impactTruncated = impact.truncated
      for (const e of impact.elements) {
        const o = byId.get(e.id)
        if (!o || included.has(e.id) || e.depth === 0) continue
        candidates.push(make.object(o, 'impacted', e.depth, e.path))
        included.add(e.id)
      }
    }
    for (const id of seeds) {
      for (const r of from(id, 'dependsOn')) {
        const o = byId.get(r.to)
        if (!o || included.has(o.id)) continue
        candidates.push(make.object(o, 'dependency', 1))
        included.add(o.id)
      }
    }
    candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        ROLE_ORDER.indexOf(a.role as (typeof ROLE_ORDER)[number]) -
          ROLE_ORDER.indexOf(b.role as (typeof ROLE_ORDER)[number]) ||
        rank(a.type) - rank(b.type) ||
        a.label.localeCompare(b.label) ||
        (a.id < b.id ? -1 : 1),
    )

    // Evidence: excerpts for focus and mandatory objects, locations for the rest.
    const allEvidence = new Set<string>()
    const plan = new Map<string, string[]>()
    for (const item of [...decisionItems, ...linkedConstraints, ...invariants, ...candidates]) {
      const record =
        item.kind === 'object' ? byId.get(item.id) : relations.find((r) => r.id === item.id)
      if (!record) continue
      const max = wantExcerpts.has(item.id) || item.distance === 0 ? 4 : 1
      const ids = evidenceIds(record.claim, max)
      plan.set(item.id, ids)
      for (const id of ids) allEvidence.add(id)
    }
    const views = new Map<string, EvidenceView>()
    const list = [...allEvidence]
    for (let i = 0; i < list.length; i += 200) {
      for (const v of unwrap(s.getEvidence(caller, { projectId, ids: list.slice(i, i + 200) }))
        .evidence) {
        views.set(v.id, v)
      }
    }
    const withEvidence = (item: ContextItem): ContextItem => {
      const excerpts = wantExcerpts.has(item.id) || item.role !== 'impacted'
      return {
        ...item,
        evidence: (plan.get(item.id) ?? []).flatMap((id) => {
          const v = views.get(id)
          if (!v) return []
          return [
            {
              id,
              location: locationOf(v),
              excerpt: excerpts && item.distance === 0 ? v.excerptText : null,
            },
          ]
        }),
      }
    }

    const snapshots = freshnessResult.snapshots
      .map((sn) => ({
        repo: sn.repo,
        commit: sn.commit,
        ...(sn.pending ? { pending: sn.pending } : {}),
      }))
      .sort((a, b) => a.repo.localeCompare(b.repo))
    const task = q.task
      ? { title: q.task.title, acceptanceCriteria: q.task.acceptanceCriteria }
      : null
    const mandatory = {
      invariants: invariants.map(withEvidence),
      constraints: linkedConstraints.map(withEvidence),
      decisions: decisionItems.map(withEvidence),
      acceptanceCriteria: task?.acceptanceCriteria ?? [],
      policy: task ? TASK_AGENT_POLICY : AGENT_POLICY,
    }
    const focus = [...new Set(q.focus)]
    const base = (items: ContextItem[], omitted: ContextItem[]): ContextPackageBody => ({
      projectId,
      revision,
      snapshots,
      focus,
      task,
      status: 'ready',
      blocked: null,
      mandatory,
      items,
      omissions: [
        ...(omitted.length > 0
          ? [
              {
                reason: 'size_limit' as const,
                count: omitted.length,
                ids: omitted.slice(0, 20).map((i) => i.id),
              },
            ]
          : []),
        ...(impactTruncated || truncatedReads.length > 0
          ? [{ reason: 'traversal_limit' as const, count: 0, ids: [] }]
          : []),
      ],
      retrieval: retrievalHints(projectId, revision, seeds, omitted, impactTruncated),
      size: { chars: 0, maxChars: q.maxChars, mandatoryChars: 0 },
    })
    const sizeOf = (b: ContextPackageBody) => canonicalJson(b).length

    const mandatoryOnly = base([], [])
    const mandatoryChars = sizeOf(mandatoryOnly)
    if (mandatoryChars > q.maxChars) {
      const byContainer = new Map<string, string[]>()
      for (const id of focusElements) {
        const key = parent.get(id) ?? id
        byContainer.set(key, [...(byContainer.get(key) ?? []), id])
      }
      return finalize({
        ...mandatoryOnly,
        status: 'blocked',
        blocked: {
          code: 'context_overflow',
          mandatoryChars,
          maxChars: q.maxChars,
          splits: [...byContainer.values()].map((ids) => ids.sort()).sort(),
        },
        omissions: [],
        retrieval: [],
        size: { chars: 0, maxChars: q.maxChars, mandatoryChars },
      })
    }

    // Add candidates nearest first while the whole package fits.
    // The fixed part is measured with every candidate omitted, its largest form, so the running
    // total over-estimates and the final package always fits.
    const items: ContextItem[] = []
    let used = sizeOf(base([], candidates)) + 32
    let k = 0
    for (; k < candidates.length; k++) {
      const item = withEvidence(candidates[k] as ContextItem)
      const cost = canonicalJson(item).length + 1
      if (used + cost > q.maxChars) break
      used += cost
      items.push(item)
    }
    const body = base(items, candidates.slice(k))
    return finalize({ ...body, size: { chars: 0, maxChars: q.maxChars, mandatoryChars } })
  }
}

/** Records the final size; the digits change the length, so it settles in a couple of passes. */
function finalize(body: ContextPackageBody): ContextPackageBody {
  let current = body
  for (let i = 0; i < 4; i++) {
    const chars = canonicalJson(current).length
    if (chars === current.size.chars) return current
    current = { ...current, size: { ...current.size, chars } }
  }
  return current
}

function rank(type: string): number {
  const i = TYPE_ORDER.indexOf(type)
  return i === -1 ? TYPE_ORDER.length : i
}

function locationOf(v: EvidenceView): string {
  const s = v.source
  switch (s.kind) {
    case 'sourceSpan': {
      const lines =
        s.span.startLine === s.span.endLine
          ? `${s.span.startLine}`
          : `${s.span.startLine}-${s.span.endLine}`
      return `${s.path}:${lines} @ ${s.commit.slice(0, 7)}`
    }
    case 'document':
      return s.locator ? `${s.uri} (${s.locator})` : s.uri
    case 'external':
      return s.uri
    case 'statement':
      return `statement by ${s.statedBy}`
  }
}

function retrievalHints(
  projectId: string,
  revision: number,
  seeds: string[],
  omitted: ContextItem[],
  impactTruncated: boolean,
): ContextPackageBody['retrieval'] {
  const hints: ContextPackageBody['retrieval'] = []
  if (omitted.length > 0) {
    hints.push({
      tool: 'query_objects',
      arguments: {
        projectId,
        revision,
        ids: omitted
          .filter((i) => i.kind === 'object')
          .slice(0, 100)
          .map((i) => i.id),
      },
      purpose: 'Read omitted elements, nearest first.',
    })
  }
  if (seeds.length > 0) {
    hints.push({
      tool: 'analyze_impact',
      arguments: {
        projectId,
        revision,
        seeds: seeds.slice(0, 50),
        maxDepth: impactTruncated ? 6 : IMPACT_DEPTH,
      },
      purpose: 'Trace what a change to the focus may affect, with typed paths.',
    })
    for (const id of seeds.slice(0, 5)) {
      hints.push({
        tool: 'query_relations',
        arguments: { projectId, revision, from: id },
        purpose: 'Everything this focus element relates to.',
      })
    }
  }
  hints.push(
    {
      tool: 'get_evidence',
      arguments: { projectId, ids: ['<evidence id from an item>'] },
      purpose: 'Read a pinned excerpt that is listed only by location.',
    },
    {
      tool: 'assess_freshness',
      arguments: { projectId, revision },
      purpose: 'Check which claims are stale before relying on them.',
    },
  )
  return hints
}
