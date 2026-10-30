import { randomBytes } from 'node:crypto'
import {
  AgentTokenListQuery,
  type AgentTokenSummary,
  Caller,
  CommitProposalInput,
  type CommitSuccess,
  CreateProjectInput,
  type DecisionSummary,
  DecisionsQuery,
  type DecisionsResult,
  EvidenceQuery,
  type EvidenceQueryResult,
  type EvidenceRecord,
  ExportProjectInput,
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
  IssueAgentTokenInput,
  type IssuedAgentToken,
  type KernelError,
  KnowledgeStatusQuery,
  type KnowledgeStatusResult,
  ObjectQuery,
  type ObjectQueryResult,
  type OperationParsed,
  ok,
  type PinFreshness,
  PinStatusQuery,
  type PinStatusResult,
  type Principal,
  type PrincipalKind,
  type PrincipalNames,
  type ProjectExport,
  type ProjectOverview,
  ProjectRef,
  type ProjectSummary,
  type Proposal,
  type ProposalCuration,
  ProposalListQuery,
  ProposeChangeInput,
  type ProposeChangeOutput,
  RejectProposalInput,
  RelationQuery,
  type RelationQueryResult,
  type Result,
  RevokeAgentTokenInput,
  type Scope,
  type Situation,
  SituationQuery,
} from '@kalyth/contracts'
import type { z } from 'zod'
import { buildProjectExport } from '../export.ts'
import { type ApplyOptions, applyOperations } from '../kernel/apply.ts'
import { decisionFacets } from '../kernel/facets.ts'
import { assessFreshness } from '../kernel/freshness.ts'
import { elementLabel, traceImpact } from '../kernel/impact.ts'
import { isKnowledgeType, knowledgeStatus, libraryInputIssues } from '../kernel/library.ts'
import {
  contentIdOf,
  EVIDENCE_MEDIA_TYPE,
  evidenceText,
  KNOWLEDGE_MEDIA_TYPE,
  type PinSource,
  resolvePin,
  versionAt,
} from '../kernel/pins.ts'
import { predicateFingerprint } from '../kernel/predicates.ts'
import { localRefsOf, readSetOf, resolveOperations, writeSetOf } from '../kernel/resolve.ts'
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
import { Authorizer, curatorRequired } from './authz.ts'

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
    expiresAt: string | null = null,
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
      expiresAt,
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
        kind: parsed.value.kind,
      })
      this.store.insertEvent({
        id: this.#ids('event'),
        projectId: id,
        revision: 0,
        type: 'project.created',
        schemaVersion: 2,
        actor: ctx.value.principal.id,
        origin: ctx.value.caller.origin,
        occurredAt: now,
        payload: {
          name: parsed.value.name,
          description: parsed.value.description,
          kind: parsed.value.kind,
        },
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
      after: q.after,
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
      after: q.after,
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

  /**
   * The whole project as one bundle (ADR 0014), for a person acting directly: an export copies
   * everything at once, so no agent or relayed instruction can trigger it.
   */
  exportProject(caller: unknown, input: unknown): Result<ProjectExport> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    if (ctx.value.principal.kind !== 'human' || ctx.value.caller.origin !== 'human') {
      return fail('unauthorized', 'a person, acting directly, exports a project')
    }
    const parsed = parse(ExportProjectInput, input)
    if (!parsed.ok) return parsed
    const project = this.store.getProject(parsed.value.projectId)
    if (!project) return fail('not_found', `project ${parsed.value.projectId} does not exist`)
    const denied = this.#authz.require(ctx.value.principal, project.id, ['project.read'])
    if (denied) return { ok: false, error: denied }
    // One transaction, so the events, the content and the state hash describe the same moment.
    const bundle = this.store.writeTransaction(() =>
      buildProjectExport(this.store, project.id, ctx.value.principal.id, this.#clock()),
    )
    return bundle ? ok(bundle) : fail('not_found', `project ${project.id} does not exist`)
  }

  /**
   * Maturity, dispute and support of a library's knowledge items at a revision (ADR 0026): a read
   * model, computed on read, so nothing it reports is ever stored.
   */
  /**
   * Every pin of a project, how it resolves, and how it compares with the library revision the
   * project uses, or with a previewed one (ADR 0027 §4, §5a): what moving a LibraryUse would
   * change, before it is proposed. Computed on read; nothing is written.
   */
  getPinStatus(caller: unknown, input: unknown): Result<PinStatusResult> {
    const r = this.#readable(caller, PinStatusQuery, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const view = this.store.view(project.id, revision)
    const pins = [...this.store.evidenceMapAt(project.id, revision).values()]
      .filter((e) => e.source.kind === 'knowledge')
      .map((e) => {
        const pin = e.source as PinSource
        const uses = view.listObjects({
          types: ['core.LibraryUse'],
          attributeEquals: { library: pin.library },
        })
        const used = uses[0] ? Number(uses[0].attributes.revision) : null
        const comparedWith = q.preview?.[pin.library] ?? used
        return {
          evidence: e.id,
          library: pin.library,
          target: pin.target,
          id: pin.id,
          revision: pin.revision,
          versionSha256: pin.versionSha256 ?? '',
          resolution: resolvePin(this.store, project.id, pin),
          comparedWith,
          freshness: pinFreshness(this.store, pin, comparedWith),
        }
      })
      .sort((a, b) => (a.evidence < b.evidence ? -1 : 1))
    return ok({ projectId: project.id, revision, pins })
  }

  getKnowledgeStatus(caller: unknown, input: unknown): Result<KnowledgeStatusResult> {
    const r = this.#readable(caller, KnowledgeStatusQuery, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    if (project.kind !== 'library') return fail('invalid', `project ${project.id} is not a library`)
    const view = this.store.view(project.id, revision)
    const items = this.store
      .objectsAt(project.id, revision, { ...(q.ids ? { ids: q.ids } : {}) })
      .filter((o) => isKnowledgeType(o.type))
      .map((o) => knowledgeStatus(view, o))
    return ok({ projectId: project.id, revision, items })
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
          .sort((a, b) => (a.from < b.from ? -1 : 1))
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

  /** Decisions with their alternatives and each alternative's direct changes (ADR 0011). */
  listDecisions(caller: unknown, input: unknown): Result<DecisionsResult> {
    const r = this.#readable(caller, DecisionsQuery, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    // Facets need the tasks, reports and verifications, and freshness needs everything (ADR 0023).
    const objects = this.store.objectsAt(project.id, revision, {})
    const relations = this.store.relationsAt(project.id, revision, {})
    const byId = new Map(objects.map((o) => [o.id, o]))
    const labelOf = (id: string) => {
      const o = byId.get(id)
      return o ? elementLabel(o) : id
    }
    const hasDecisions = objects.some((o) => o.type === 'core.Decision')
    const evidence: Map<string, EvidenceRecord> = hasDecisions
      ? this.store.evidenceMapAt(project.id, revision)
      : new Map()
    const freshness = new Map(
      hasDecisions
        ? assessFreshness(objects, relations, evidence).claims.map((c) => [c.id, c] as const)
        : [],
    )
    // The source files an element's or a relation's evidence cites, for what verified reports
    // touched (ADR 0024).
    const relationById = new Map(relations.map((r) => [r.id, r]))
    const pathsOf = (id: string): string[] => {
      const o = byId.get(id) ?? relationById.get(id)
      if (!o) return []
      return [
        ...new Set(
          o.claim.supports.flatMap((g) =>
            g.allOf.flatMap((e) => {
              const source = evidence.get(e)?.source
              return source?.kind === 'sourceSpan' ? [source.path] : []
            }),
          ),
        ),
      ]
    }
    const text = (o: { attributes: unknown }, key: string) => {
      const v = (o.attributes as Record<string, unknown>)[key]
      return typeof v === 'string' ? v : ''
    }
    const decisions: DecisionSummary[] = objects
      .filter((o) => o.type === 'core.Decision')
      .filter((d) => q.status === undefined || text(d, 'status') === q.status)
      .map((d) => ({
        id: d.id,
        title: text(d, 'title'),
        question: text(d, 'question'),
        status: text(d, 'status'),
        statusRationale: text(d, 'statusRationale') || null,
        basis: d.claim.basis,
        alternatives: relations
          .filter((rel) => rel.type === 'alternativeOf' && rel.to === d.id)
          .sort((a, b) => (a.from < b.from ? -1 : 1))
          .flatMap((rel) => {
            const alt = byId.get(rel.from)
            if (!alt) return []
            return [
              {
                id: alt.id,
                title: text(alt, 'title'),
                summary: text(alt, 'summary'),
                status: text(alt, 'status'),
                directChanges: relations
                  .filter((i) => i.type === 'impacts' && i.from === alt.id)
                  .map((i) => ({
                    relationId: i.id,
                    target: i.to,
                    label: labelOf(i.to),
                    change: typeof i.properties.change === 'string' ? i.properties.change : '',
                  })),
              },
            ]
          }),
        decides: relations
          .filter((rel) => rel.type === 'decides' && rel.from === d.id)
          .map((rel) => ({ id: rel.to, label: labelOf(rel.to) })),
        facets: decisionFacets(d.id, byId, relations, freshness, labelOf, pathsOf),
      }))
    return ok({ projectId: project.id, revision, decisions })
  }

  describeTypes(caller: unknown): Result<ReturnType<TypeRegistry['describe']>> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    return ok(this.registry.describe())
  }

  /**
   * The names of the principals in this store, so screens can say who proposed, decided or
   * requested something. Names and kinds only: never grants or tokens.
   */
  listPrincipalNames(caller: unknown): Result<PrincipalNames> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    return ok({
      principals: this.store.listPrincipals().map((p) => ({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        you: p.id === ctx.value.principal.id,
      })),
    })
  }

  // ---------- agent tokens (ADR 0011) ----------

  /**
   * Issues a bearer token for a new agent principal that may read and propose in one project.
   * Only a person acting directly, with grant.manage, can issue one. The secret is returned once.
   */
  issueAgentToken(caller: unknown, input: unknown): Result<IssuedAgentToken> {
    const who = this.#person(caller)
    if (!who.ok) return who
    const parsed = parse(IssueAgentTokenInput, input)
    if (!parsed.ok) return parsed
    const req = parsed.value
    const project = this.store.getProject(req.projectId)
    if (!project) return fail('not_found', `project ${req.projectId} does not exist`)
    const denied = this.#authz.require(who.value, project.id, ['grant.manage'])
    if (denied) return { ok: false, error: denied }
    const now = this.#clock()
    const expiresAt = new Date(Date.parse(now) + req.expiresInDays * 86_400_000).toISOString()
    const token = `kalyth_at_${randomBytes(32).toString('base64url')}`
    return ok(
      this.store.writeTransaction(() => {
        const principal = this.createPrincipal('agent', `Agent token: ${req.label}`)
        this.grant(principal.id, AGENT_TOKEN_SCOPES, project.id, who.value.id, expiresAt)
        const summary: AgentTokenSummary = {
          id: this.#ids('agentToken'),
          projectId: project.id,
          principalId: principal.id,
          label: req.label,
          scopes: [...AGENT_TOKEN_SCOPES],
          createdBy: who.value.id,
          createdAt: now,
          expiresAt,
          revokedAt: null,
        }
        this.store.insertAgentToken(summary, sha256Hex(token))
        return { token, summary }
      }),
    )
  }

  listAgentTokens(caller: unknown, input: unknown): Result<{ tokens: AgentTokenSummary[] }> {
    const who = this.#person(caller)
    if (!who.ok) return who
    const parsed = parse(AgentTokenListQuery, input)
    if (!parsed.ok) return parsed
    const denied = this.#authz.require(who.value, parsed.value.projectId, ['grant.manage'])
    if (denied) return { ok: false, error: denied }
    return ok({
      tokens: this.store
        .agentTokens(parsed.value.projectId)
        .map((t) => ({ ...t, scopes: [...AGENT_TOKEN_SCOPES] })),
    })
  }

  revokeAgentToken(caller: unknown, input: unknown): Result<AgentTokenSummary> {
    const who = this.#person(caller)
    if (!who.ok) return who
    const parsed = parse(RevokeAgentTokenInput, input)
    if (!parsed.ok) return parsed
    const token = this.store.agentToken(parsed.value.tokenId)
    if (!token) return fail('not_found', `agent token ${parsed.value.tokenId} does not exist`)
    const denied = this.#authz.require(who.value, token.projectId, ['grant.manage'])
    if (denied) return { ok: false, error: denied }
    this.store.revokeAgentToken(token.id, this.#clock())
    const after = this.store.agentToken(token.id) ?? token
    return ok({ ...after, scopes: [...AGENT_TOKEN_SCOPES] })
  }

  /**
   * Resolves a presented bearer token to its agent principal, or undefined when it is malformed,
   * unknown, revoked or expired. Requests made with it act with origin "agent".
   */
  authenticateAgentToken(token: string): { principalId: string; projectId: string } | undefined {
    if (!/^kalyth_at_[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const found = this.store.agentTokenByHash(sha256Hex(token))
    if (!found || found.revokedAt !== null || found.expiresAt <= this.#clock()) return undefined
    return { principalId: found.principalId, projectId: found.projectId }
  }

  /** A human principal acting directly (origin "human"). */
  #person(caller: unknown): Result<Principal> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    if (ctx.value.principal.kind !== 'human' || ctx.value.caller.origin !== 'human') {
      return fail('unauthorized', 'agent tokens are managed by a person acting directly', {
        requiredScopes: ['grant.manage'],
      })
    }
    return ok(ctx.value.principal)
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
    const denied =
      this.#authz.require(ctx.value.principal, project.id, ['proposal.create']) ??
      this.#authz.authorizeProposal(ctx.value.principal, ctx.value.caller, project, req.ops)
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
      ...(req.contextPackageId ? { contextPackageId: req.contextPackageId } : {}),
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

    // Pinning reads a library, so the proposer must be able to read it (ADR 0030 §3).
    for (const op of req.ops) {
      if (op.op !== 'recordEvidence' || op.evidence.source.kind !== 'knowledge') continue
      const unreadable = this.#authz.require(ctx.value.principal, op.evidence.source.library, [
        'project.read',
      ])
      if (unreadable) return { ok: false, error: unreadable }
    }

    return this.store.writeTransaction(() => {
      const now = this.#clock()
      const pinned = this.#pin(project.id, req.ops, now)
      const resolved = resolveOperations(
        pinned.ops,
        this.#ids,
        { putExcerpt: (text) => this.#putExcerpt(project.id, text, now) },
        now,
        {
          actor: ctx.value.principal.id,
          referenceAttributes: (type) => this.registry.objectType(type)?.references ?? [],
        },
      )
      const base = this.store.view(project.id, req.baseRevision)
      const applied = applyOperations(
        base,
        resolved.ops,
        this.registry,
        req.baseRevision + 1,
        this.#applyOptions(project),
      )
      // A verifySource without targets records the claims it found (ADR 0030 A1).
      for (const { op, targets } of applied.expansions) {
        const found = resolved.ops[op]
        if (found?.op === 'verifySource') resolved.ops[op] = { ...found, targets }
      }
      const issues: Issue[] = [
        ...pinned.issues,
        ...resolved.issues,
        ...(project.kind === 'library' ? libraryInputIssues(req.ops) : []),
        ...applied.issues,
      ]
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
        contextPackageId: req.contextPackageId ?? null,
        status: issues.length > 0 ? 'invalid' : 'pending',
        issues,
        result: null,
        createdAt: now,
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        ...(hasCuration(applied.curation) ? { curation: applied.curation } : {}),
      }
      this.store.insertProposal(proposal, requestHash)
      return ok({
        proposalId: proposal.id,
        status: proposal.status,
        issues,
        ...(proposal.curation ? { curation: proposal.curation } : {}),
      })
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
      const project = this.store.getProject(proposal.projectId)
      if (!project) return fail('not_found', `project ${proposal.projectId} does not exist`)
      const denied = this.#authz.authorizeCommit(principal, who, project, proposal.ops, proposal)
      if (denied) return { ok: false, error: denied }
      // Curation given with the commit is the committer's own (ADR 0030 A7, A2).
      const given = parsed.value.curation
      if (given && !this.#authz.curates(principal, who, project.id))
        return {
          ok: false,
          error: curatorRequired(
            'curation given at commit comes from a person acting directly with knowledge.curate',
          ),
        }
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
      const headView = this.store.view(project.id, head)
      const options = this.#applyOptions(project)
      const own = applyOperations(headView, proposal.ops, this.registry, revision, options)
      if (own.issues.length > 0) {
        decide('conflicting', { issues: own.issues })
        return fail('conflicting', 'the proposal violates an invariant at the current head', {
          currentRevision: head,
          issues: own.issues,
        })
      }
      // ADR 0030 A7: a change to established knowledge is committed by a curator.
      if (own.curation.required.length > 0 && !this.#authz.curates(principal, who, project.id))
        return {
          ok: false,
          error: curatorRequired(
            `this proposal changes established knowledge (${own.curation.required.join(', ')}); a person acting directly with knowledge.curate commits it`,
          ),
        }
      const curation = given
        ? resolveOperations(given, this.#ids, noExcerpts, now, { actor: principal.id })
        : undefined
      if (curation && curation.issues.length > 0)
        return fail('invalid', 'the curation given does not resolve; name records by id', {
          issues: curation.issues,
        })
      const curationOps = curation?.ops ?? []
      const applied = curation
        ? applyOperations(
            headView,
            [...proposal.ops, ...curationOps],
            this.registry,
            revision,
            options,
          )
        : own
      for (const { op, targets } of applied.expansions) {
        const found = curationOps[op - proposal.ops.length]
        if (found?.op === 'verifySource')
          curationOps[op - proposal.ops.length] = { ...found, targets }
      }
      // Problems the curation brings, or curation still missing, leave the proposal pending.
      if (applied.issues.length > 0)
        return fail('invalid', 'the curation given at commit is not valid at the current head', {
          currentRevision: head,
          issues: applied.issues,
        })
      if (applied.curation.gaps.length > 0)
        return fail(
          'invalid',
          'established knowledge would miss what ADR 0026 I3 needs: give curation with the commit, or reject the proposal',
          {
            currentRevision: head,
            issues: applied.curation.gaps.map((g) => ({
              code: 'curation.required',
              message: `${g.id}: ${g.gaps.join('; ')}`,
            })),
          },
        )

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
        schemaVersion: 2,
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
        refs: localRefsOf(proposal.ops),
        ...(curationOps.length > 0 ? { curation: curationOps } : {}),
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

  #applyOptions(project: ProjectSummary): ApplyOptions {
    return {
      kind: project.kind,
      projectId: project.id,
      libraries: (id) => {
        const found = this.store.getProject(id)
        return found ? { kind: found.kind, headRevision: found.headRevision } : undefined
      },
      pinVerified: (sha) => {
        const copy = this.store.getContent(project.id, contentIdOf(sha))
        return typeof copy?.body === 'string' && sha256Hex(copy.body) === sha
      },
    }
  }

  /**
   * Resolves every pin a proposal records (ADR 0027 §1, ADR 0030 §3): the library's item at the
   * pinned revision, in canonical form v1, hashed and embedded in the project's content, with the
   * evidence records it cites, in the proposal's transaction. Clients name the item and revision;
   * a hash they send must match.
   */
  #pin(projectId: string, ops: readonly OperationParsed[], now: string) {
    const issues: Issue[] = []
    const embed = (text: string, mediaType: string) => {
      const sha256 = sha256Hex(text)
      this.store.putContent(projectId, {
        id: contentIdOf(sha256),
        sha256,
        mediaType,
        body: text,
        redactionReason: null,
        createdAt: now,
      })
    }
    const pinned = ops.map((op, index): OperationParsed => {
      if (op.op !== 'recordEvidence' || op.evidence.source.kind !== 'knowledge') return op
      const pin = op.evidence.source
      const add = (code: string, message: string) =>
        issues.push({ code, message, op: index, path: ['evidence', 'source'] })
      if (pin.library === projectId) {
        add('pin.self', 'a project pins libraries, not itself')
        return op
      }
      const version = versionAt(this.store, pin)
      if (!version.ok) {
        add(`pin.${version.reason}`, version.detail)
        return op
      }
      if (pin.versionSha256 && pin.versionSha256 !== version.sha256) {
        add('pin.hash_differs', `${pin.id} at revision ${pin.revision} hashes to ${version.sha256}`)
        return op
      }
      const view = this.store.view(pin.library, pin.revision)
      for (const { evidence } of version.cites) {
        const record = view.getEvidence(evidence)
        if (record) embed(evidenceText(record.source), EVIDENCE_MEDIA_TYPE)
      }
      embed(version.text, KNOWLEDGE_MEDIA_TYPE)
      return {
        ...op,
        evidence: {
          ...op.evidence,
          source: { ...pin, versionHash: 'v1', versionSha256: version.sha256 },
        },
      }
    })
    return { ops: pinned, issues }
  }

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

function pinFreshness(store: SqliteStore, pin: PinSource, against: number | null): PinFreshness {
  if (against === null) return 'noLibraryUse'
  if (against === pin.revision) return 'current'
  const now = versionAt(store, { ...pin, revision: against })
  if (now.ok) return now.sha256 === pin.versionSha256 ? 'unchanged' : 'changed'
  return now.reason === 'unknown-target' ? 'removed' : 'libraryNotPresent'
}

/** Curation given at commit records no evidence, so it stores no excerpts. */
const noExcerpts = {
  putExcerpt(): never {
    throw new Error('curation given at commit records no evidence')
  },
}

const hasCuration = (c: ProposalCuration) => c.required.length > 0 || c.gaps.length > 0

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

/**
 * Agents connected with a token read, propose and work on tasks; people commit and decide
 * (ADRs 0011 and 0013).
 */
const AGENT_TOKEN_SCOPES: readonly Scope[] = ['project.read', 'proposal.create', 'task.work']

export type { KernelError }
