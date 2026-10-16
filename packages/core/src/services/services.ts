import {
  Caller,
  CommitProposalInput,
  type CommitSuccess,
  CreateProjectInput,
  EvidenceQuery,
  type EvidenceQueryResult,
  FreshnessQuery,
  type FreshnessResult,
  fail,
  type Grant,
  HistoryQuery,
  type HistoryResult,
  HUMAN_ONLY_SCOPES,
  ImpactQuery,
  type ImpactResult,
  type Issue,
  type KernelError,
  ObjectQuery,
  type ObjectQueryResult,
  ok,
  type Principal,
  type PrincipalKind,
  type ProjectOverview,
  ProjectRef,
  type ProjectSummary,
  type Proposal,
  ProposalListQuery,
  ProposeChangeInput,
  type ProposeChangeOutput,
  RejectProposalInput,
  RelationQuery,
  type RelationQueryResult,
  type Result,
  type Scope,
  type Situation,
  SituationQuery,
} from '@kalyth/contracts'
import type { z } from 'zod'
import { applyOperations } from '../kernel/apply.ts'
import { assessFreshness } from '../kernel/freshness.ts'
import { traceImpact } from '../kernel/impact.ts'
import { predicateFingerprint } from '../kernel/predicates.ts'
import { readSetOf, resolveOperations, writeSetOf } from '../kernel/resolve.ts'
import { findSecretRule } from '../kernel/secrets.ts'
import { defaultRegistry, type TypeRegistry } from '../registry/registry.ts'
import type { SqliteStore } from '../store/sqlite-store.ts'
import {
  type Clock,
  defaultIdGenerator,
  type FaultInjector,
  hashCanonical,
  type IdGenerator,
  sha256Hex,
  systemClock,
} from '../util.ts'
import { Authorizer } from './authz.ts'

export interface KalythServicesOptions {
  store: SqliteStore
  registry?: TypeRegistry
  clock?: Clock
  ids?: IdGenerator
  /** Test hook: throw at a named point inside the commit transaction. */
  faults?: FaultInjector
}

interface Context {
  caller: Caller
  principal: Principal
}

/**
 * The application services. HTTP and MCP adapters call these and nothing else, so validation,
 * authorisation and revision checks are identical on every interface (ADR 0002).
 */
export class KalythServices {
  readonly store: SqliteStore
  readonly registry: TypeRegistry
  readonly #clock: Clock
  readonly #ids: IdGenerator
  readonly #faults: FaultInjector
  readonly #authz: Authorizer

  constructor(options: KalythServicesOptions) {
    this.store = options.store
    this.registry = options.registry ?? defaultRegistry
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? defaultIdGenerator
    this.#faults = options.faults ?? (() => {})
    this.#authz = new Authorizer(this.store, this.#clock)
  }

  // ---------- principals ----------

  /** Administrative bootstrap; not exposed on any network interface in version 1. */
  createPrincipal(kind: PrincipalKind, displayName: string): Principal {
    const principal: Principal = {
      id: this.#ids('principal'),
      kind,
      displayName,
      createdAt: this.#clock(),
    }
    this.store.insertPrincipal(principal)
    return principal
  }

  /** Administrative bootstrap. Human-only scopes can never be granted to other principals. */
  grant(
    principalId: string,
    scopes: readonly Scope[],
    projectId: string | null = null,
    grantedBy: string | null = null,
  ): Grant {
    const principal = this.store.getPrincipal(principalId)
    if (!principal) throw new Error(`unknown principal ${principalId}`)
    const humanOnly = scopes.filter((s) => HUMAN_ONLY_SCOPES.includes(s))
    if (principal.kind !== 'human' && humanOnly.length > 0) {
      throw new Error(`${humanOnly.join(', ')} can only be granted to a human principal`)
    }
    const grant: Grant = {
      id: this.#ids('grant'),
      principalId,
      projectId,
      scopes: [...scopes],
      expiresAt: null,
      grantedBy,
      createdAt: this.#clock(),
    }
    this.store.insertGrant(grant)
    return grant
  }

  // ---------- projects ----------

  createProject(caller: unknown, input: unknown): Result<ProjectSummary> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const denied = this.#authz.require(ctx.value.principal, null, ['project.create'])
    if (denied) return { ok: false, error: denied }
    const parsed = parse(CreateProjectInput, input)
    if (!parsed.ok) return parsed
    const id = this.#ids('project')
    const now = this.#clock()
    this.store.writeTransaction(() => {
      this.store.insertProject({
        id,
        name: parsed.value.name,
        description: parsed.value.description,
        createdAt: now,
        createdBy: ctx.value.principal.id,
      })
      this.store.insertEvent({
        id: this.#ids('event'),
        projectId: id,
        revision: 0,
        type: 'project.created',
        schemaVersion: 1,
        actor: ctx.value.principal.id,
        origin: ctx.value.caller.origin,
        occurredAt: now,
        payload: { name: parsed.value.name, description: parsed.value.description },
      })
    })
    return ok(this.store.getProject(id) as ProjectSummary)
  }

  listProjects(caller: unknown): Result<{ projects: ProjectSummary[] }> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const projects = this.store
      .listProjects()
      .filter((p) => this.#authz.scopes(ctx.value.principal.id, p.id).has('project.read'))
    return ok({ projects })
  }

  getProjectOverview(caller: unknown, input: unknown): Result<ProjectOverview> {
    const r = this.#readable(caller, ProjectRef, input)
    if (!r.ok) return r
    const { project, revision } = r.value
    const counts = this.store.countsAt(project.id, revision)
    return ok({
      project,
      revision,
      objectCounts: counts.objects,
      relationCounts: counts.relations,
      evidenceCount: counts.evidence,
      pendingProposals: this.store.countPending(project.id),
    })
  }

  queryObjects(caller: unknown, input: unknown): Result<ObjectQueryResult> {
    const r = this.#readable(caller, ObjectQuery, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const objects = this.store.objectsAt(project.id, revision, {
      types: q.types,
      ids: q.ids,
      includeRetired: q.includeRetired,
      limit: q.limit,
    })
    return ok({ projectId: project.id, revision, objects })
  }

  queryRelations(caller: unknown, input: unknown): Result<RelationQueryResult> {
    const r = this.#readable(caller, RelationQuery, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const relations = this.store.relationsAt(project.id, revision, {
      types: q.types,
      ids: q.ids,
      from: q.from,
      to: q.to,
      includeRetired: q.includeRetired,
      limit: q.limit,
    })
    return ok({ projectId: project.id, revision, relations })
  }

  getEvidence(caller: unknown, input: unknown): Result<EvidenceQueryResult> {
    const r = this.#readable(caller, EvidenceQuery, input)
    if (!r.ok) return r
    return ok({ evidence: this.store.evidenceViews(r.value.project.id, r.value.input.ids) })
  }

  getHistory(caller: unknown, input: unknown): Result<HistoryResult> {
    const r = this.#readable(caller, HistoryQuery, input)
    if (!r.ok) return r
    const { project, input: q } = r.value
    return ok({
      projectId: project.id,
      headRevision: project.headRevision,
      changeSets: this.store.history(project.id, q.limit),
    })
  }

  /** Freshness of every active claim at a revision; a read model, nothing is written (ADR 0009). */
  assessFreshness(caller: unknown, input: unknown): Result<FreshnessResult> {
    const r = this.#readable(caller, FreshnessQuery, input)
    if (!r.ok) return r
    const { project, revision } = r.value
    const objects = this.store.objectsAt(project.id, revision, {})
    const relations = this.store.relationsAt(project.id, revision, {})
    const { snapshots, claims } = assessFreshness(
      objects,
      relations,
      this.store.evidenceMapAt(project.id, revision),
    )
    const summary: Record<string, number> = {}
    for (const c of claims) summary[c.status] = (summary[c.status] ?? 0) + 1
    return ok({
      projectId: project.id,
      revision,
      snapshots: snapshots.map(({ files: _files, ...s }) => s),
      claims,
      summary,
    })
  }

  /**
   * Elements a change to the seeds may affect, with typed paths (ADR 0010). Deterministic and
   * read-only: it follows each relation type's declared impact rule, never a model's guess.
   */
  analyzeImpact(caller: unknown, input: unknown): Result<ImpactResult> {
    const r = this.#readable(caller, ImpactQuery, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const seeds = [...new Set(q.seeds)]
    const objects = this.store.objectsAt(project.id, revision, {})
    const active = new Set(objects.map((o) => o.id))
    const missing = seeds.filter((id) => !active.has(id))
    if (missing.length > 0) {
      return fail('not_found', `no active element ${missing.join(', ')} at revision ${revision}`)
    }
    const trace = traceImpact(
      objects,
      this.store.relationsAt(project.id, revision, {}),
      this.registry,
      seeds,
      { maxDepth: q.maxDepth, maxNodes: q.maxNodes },
    )
    return ok({ projectId: project.id, revision, seeds, ...trace })
  }

  /** What needs attention at a revision: a deterministic read model (ADR 0010). */
  getSituation(caller: unknown, input: unknown): Result<Situation> {
    const r = this.#readable(caller, SituationQuery, input)
    if (!r.ok) return r
    const { project, revision } = r.value
    const objects = this.store.objectsAt(project.id, revision, {})
    const relations = this.store.relationsAt(project.id, revision, {})
    const byId = new Map(objects.map((o) => [o.id, o]))
    const attr = (o: { attributes: unknown }, key: string) => {
      const value = (o.attributes as Record<string, unknown>)[key]
      return typeof value === 'string' ? value : ''
    }
    const openDecisions = objects
      .filter((o) => o.type === 'core.Decision' && attr(o, 'status') === 'open')
      .map((d) => ({
        id: d.id,
        title: attr(d, 'title'),
        alternatives: relations
          .filter((rel) => rel.type === 'alternativeOf' && rel.to === d.id)
          .flatMap((rel) => {
            const alt = byId.get(rel.from)
            return alt
              ? [{ id: alt.id, title: attr(alt, 'title'), status: attr(alt, 'status') }]
              : []
          }),
      }))
    const openQuestions = objects
      .filter((o) => o.type === 'core.Question' && attr(o, 'status') === 'open')
      .map((q) => ({
        id: q.id,
        text: attr(q, 'text'),
        inquiryRole: attr(q, 'inquiryRole'),
        concerns: relations
          .filter((rel) => rel.type === 'concerns' && rel.from === q.id)
          .map((rel) => rel.to),
      }))
    const pendingProposals = this.store.listProposals(project.id, 'pending', 100).map((p) => ({
      id: p.id,
      proposedBy: p.proposedBy,
      origin: p.origin,
      createdAt: p.createdAt,
      operations: p.ops.length,
      rationale: p.rationale,
    }))
    const { claims } = assessFreshness(
      objects,
      relations,
      this.store.evidenceMapAt(project.id, revision),
    )
    const freshness: Record<string, number> = {}
    for (const c of claims) freshness[c.status] = (freshness[c.status] ?? 0) + 1
    const staleClaims = claims
      .filter((c) => c.status === 'stale' || c.status === 'derived-stale')
      .slice(0, 100)
    return ok({
      projectId: project.id,
      revision,
      openDecisions,
      openQuestions,
      pendingProposals,
      freshness,
      staleClaims,
    })
  }

  describeTypes(caller: unknown): Result<ReturnType<TypeRegistry['describe']>> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    return ok(this.registry.describe())
  }

  // ---------- proposals ----------

  proposeChange(caller: unknown, input: unknown): Result<ProposeChangeOutput> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const parsed = parse(ProposeChangeInput, input)
    if (!parsed.ok) return parsed
    const req = parsed.value
    const project = this.store.getProject(req.projectId)
    if (!project) return fail('not_found', `project ${req.projectId} does not exist`)
    const denied = this.#authz.require(ctx.value.principal, project.id, ['proposal.create'])
    if (denied) return { ok: false, error: denied }
    if (req.baseRevision > project.headRevision) {
      return fail(
        'invalid',
        `base revision ${req.baseRevision} is ahead of head ${project.headRevision}`,
        {
          currentRevision: project.headRevision,
        },
      )
    }

    const requestHash = hashCanonical({
      baseRevision: req.baseRevision,
      ops: req.ops,
      rationale: req.rationale,
    })
    if (req.idempotencyKey) {
      const existing = this.store.findProposalByKey(project.id, req.idempotencyKey)
      if (existing) {
        if (existing.opsHash !== requestHash) {
          return fail('invalid', 'idempotency key was already used for a different proposal', {
            issues: [{ code: 'idempotency.key_reused', message: req.idempotencyKey }],
          })
        }
        const p = existing.proposal
        return ok({ proposalId: p.id, status: p.status, issues: p.issues })
      }
    }

    return this.store.writeTransaction(() => {
      const now = this.#clock()
      const resolved = resolveOperations(
        req.ops,
        this.#ids,
        { putExcerpt: (text) => this.#putExcerpt(project.id, text, now) },
        now,
      )
      const base = this.store.view(project.id, req.baseRevision)
      const applied = applyOperations(base, resolved.ops, this.registry, req.baseRevision + 1)
      const issues: Issue[] = [...resolved.issues, ...applied.issues]
      const proposal: Proposal = {
        id: this.#ids('proposal'),
        projectId: project.id,
        baseRevision: req.baseRevision,
        proposedBy: ctx.value.principal.id,
        origin: ctx.value.caller.origin,
        ops: resolved.ops,
        rationale: req.rationale,
        readSet: readSetOf(resolved.ops, req.readSet, (id) =>
          Boolean(base.getObject(id) ?? base.getRelation(id) ?? base.getEvidence(id)),
        ),
        writeSet: writeSetOf(resolved.ops),
        predicates: req.predicates.map((p) => ({
          ...p,
          resultHash: predicateFingerprint(base, p.query),
        })),
        idempotencyKey: req.idempotencyKey ?? null,
        status: issues.length > 0 ? 'invalid' : 'pending',
        issues,
        result: null,
        createdAt: now,
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
      }
      this.store.insertProposal(proposal, requestHash)
      return ok({ proposalId: proposal.id, status: proposal.status, issues })
    })
  }

  getProposal(caller: unknown, input: unknown): Result<Proposal> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const parsed = parse(CommitProposalInput, input)
    if (!parsed.ok) return parsed
    const proposal = this.store.getProposal(parsed.value.proposalId)
    if (!proposal) return fail('not_found', `proposal ${parsed.value.proposalId} does not exist`)
    const denied = this.#authz.require(ctx.value.principal, proposal.projectId, ['project.read'])
    if (denied) return { ok: false, error: denied }
    return ok(proposal)
  }

  listProposals(caller: unknown, input: unknown): Result<{ proposals: Proposal[] }> {
    const r = this.#readable(caller, ProposalListQuery, input)
    if (!r.ok) return r
    const { project, input: q } = r.value
    return ok({ proposals: this.store.listProposals(project.id, q.status, q.limit) })
  }

  /**
   * Commits a pending proposal (ADR 0004). Runs in one write transaction:
   * authorise; if the head moved, fail as stale when anything in the read set, the write set or a
   * predicate result changed, otherwise rebase; re-validate every operation against the head (R1);
   * write versions, change set and event; advance the head. Any failure leaves nothing behind.
   */
  commitProposal(caller: unknown, input: unknown): Result<CommitSuccess> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const parsed = parse(CommitProposalInput, input)
    if (!parsed.ok) return parsed
    const { principal, caller: who } = ctx.value

    return this.store.writeTransaction((): Result<CommitSuccess> => {
      const proposal = this.store.getProposal(parsed.value.proposalId)
      if (!proposal) return fail('not_found', `proposal ${parsed.value.proposalId} does not exist`)
      if (proposal.status === 'committed' && proposal.result) return ok(proposal.result)
      if (proposal.status !== 'pending') {
        return fail('invalid', `proposal is ${proposal.status}, not pending`, {
          issues: [{ code: 'proposal.not_pending', message: proposal.status }],
        })
      }
      const denied = this.#authz.authorizeCommit(principal, who, proposal.projectId, proposal.ops)
      if (denied) return { ok: false, error: denied }

      const project = this.store.getProject(proposal.projectId)
      if (!project) return fail('not_found', `project ${proposal.projectId} does not exist`)
      const head = project.headRevision
      const now = this.#clock()
      const decide = (
        status: Proposal['status'],
        extra: { issues?: Issue[]; result?: unknown } = {},
      ) =>
        this.store.decideProposal(proposal.id, {
          status,
          ...extra,
          decidedAt: now,
          decidedBy: principal.id,
        })

      if (head !== proposal.baseRevision) {
        const changed = this.store.changedIdsSince(project.id, proposal.baseRevision, head)
        const overlap = [...new Set([...proposal.readSet, ...proposal.writeSet])].filter((id) =>
          changed.has(id),
        )
        const headView = this.store.view(project.id, head)
        const predicateChanges = proposal.predicates
          .filter((p) => predicateFingerprint(headView, p.query) !== p.resultHash)
          .map((p) => `predicate:${p.id}`)
        const changedRefs = [...overlap.sort(), ...predicateChanges]
        if (changedRefs.length > 0) {
          const issues = changedRefs.map((ref) => ({ code: 'stale.changed', message: ref }))
          decide('stale', { issues })
          return fail(
            'stale',
            `state this proposal relies on changed since revision ${proposal.baseRevision}`,
            {
              currentRevision: head,
              changedRefs,
              issues,
            },
          )
        }
      }

      const revision = head + 1
      const applied = applyOperations(
        this.store.view(project.id, head),
        proposal.ops,
        this.registry,
        revision,
      )
      if (applied.issues.length > 0) {
        decide('conflicting', { issues: applied.issues })
        return fail('conflicting', 'the proposal violates an invariant at the current head', {
          currentRevision: head,
          issues: applied.issues,
        })
      }

      this.store.applyWrites(project.id, revision, applied.writes)
      this.#faults('afterVersionWrites')
      const changeSetId = this.#ids('changeSet')
      const eventId = this.#ids('event')
      this.store.insertChangeSet({
        id: changeSetId,
        projectId: project.id,
        revision,
        proposalId: proposal.id,
        proposedBy: proposal.proposedBy,
        committedBy: principal.id,
        origin: who.origin,
        proposalBaseRevision: proposal.baseRevision,
        appliedOnRevision: head,
        committedAt: now,
        writeCount: applied.writes.length,
      })
      this.store.insertEvent({
        id: eventId,
        projectId: project.id,
        revision,
        type: 'changeSet.committed',
        schemaVersion: 1,
        actor: principal.id,
        origin: who.origin,
        occurredAt: now,
        payload: {
          changeSetId,
          proposalId: proposal.id,
          proposedBy: proposal.proposedBy,
          proposalOrigin: proposal.origin,
          proposalBaseRevision: proposal.baseRevision,
          appliedOnRevision: head,
          writes: applied.writes,
        },
      })
      this.#faults('afterEventInsert')
      this.#faults('beforeHeadUpdate')
      this.store.setHead(project.id, head, revision)
      const result: CommitSuccess = {
        status: 'committed',
        projectId: project.id,
        revision,
        changeSetId,
        eventId,
        rebasedFrom: head === proposal.baseRevision ? null : proposal.baseRevision,
      }
      decide('committed', { result })
      return ok(result)
    })
  }

  rejectProposal(caller: unknown, input: unknown): Result<Proposal> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const parsed = parse(RejectProposalInput, input)
    if (!parsed.ok) return parsed
    return this.store.writeTransaction((): Result<Proposal> => {
      const proposal = this.store.getProposal(parsed.value.proposalId)
      if (!proposal) return fail('not_found', `proposal ${parsed.value.proposalId} does not exist`)
      const denied = this.#authz.require(ctx.value.principal, proposal.projectId, [
        'proposal.reject',
      ])
      if (denied) return { ok: false, error: denied }
      if (proposal.status !== 'pending')
        return fail('invalid', `proposal is ${proposal.status}, not pending`)
      this.store.decideProposal(proposal.id, {
        status: 'rejected',
        decidedAt: this.#clock(),
        decidedBy: ctx.value.principal.id,
        note: parsed.value.reason,
      })
      return ok(this.store.getProposal(proposal.id) as Proposal)
    })
  }

  // ---------- helpers ----------

  #context(caller: unknown): Result<Context> {
    const parsed = Caller.safeParse(caller)
    if (!parsed.success) return fail('unauthenticated', 'no valid caller')
    const principal = this.store.getPrincipal(parsed.data.principalId)
    if (!principal) return fail('unauthenticated', 'unknown principal')
    return ok({ caller: parsed.data, principal })
  }

  #readable<S extends z.ZodType<{ projectId: string; revision?: number | undefined }>>(
    caller: unknown,
    schema: S,
    input: unknown,
  ): Result<{ project: ProjectSummary; revision: number; input: z.output<S> }> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const parsed = parse(schema, input)
    if (!parsed.ok) return parsed
    const project = this.store.getProject(parsed.value.projectId)
    if (!project) return fail('not_found', `project ${parsed.value.projectId} does not exist`)
    const denied = this.#authz.require(ctx.value.principal, project.id, ['project.read'])
    if (denied) return { ok: false, error: denied }
    const revision = parsed.value.revision ?? project.headRevision
    if (revision > project.headRevision) {
      return fail('invalid', `revision ${revision} is ahead of head ${project.headRevision}`, {
        currentRevision: project.headRevision,
      })
    }
    return ok({ project, revision, input: parsed.value })
  }

  #putExcerpt(projectId: string, text: string, now: string) {
    const sha256 = sha256Hex(text)
    const rule = findSecretRule(text)
    return this.store.putContent(projectId, {
      id: `cnt_${sha256.slice(0, 32)}`,
      sha256,
      mediaType: 'text/plain',
      body: rule ? null : text,
      redactionReason: rule ? `secret-pattern:${rule}` : null,
      createdAt: now,
    })
  }
}

function parse<S extends z.ZodType>(schema: S, input: unknown): Result<z.output<S>> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return ok(parsed.data)
  const issues: Issue[] = parsed.error.issues.map((i) => ({
    code: `schema.${i.code}`,
    message: i.message,
    path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
  }))
  return fail('invalid', 'input does not match the contract', { issues })
}

export type { KernelError }
