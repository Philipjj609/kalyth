import { randomBytes } from 'node:crypto'
import {
  AgentTokenListQuery,
  type AgentTokenSummary,
  AssessInput,
  type AssessmentResult,
  type AssessmentStatusResult,
  type AssessmentView,
  Caller,
  CommitProposalInput,
  type CommitSuccess,
  CreateProjectInput,
  canonicalJson,
  type DecisionSummary,
  DecisionsQuery,
  type DecisionsResult,
  type DependencySet,
  EvidenceQuery,
  type EvidenceQueryResult,
  type EvidenceRecord,
  type Explanation,
  ExportProjectInput,
  FreshnessQuery,
  type FreshnessResult,
  fail,
  GetAssessmentInput,
  GetKnowledgeInput,
  type Grant,
  HistoryQuery,
  type HistoryResult,
  HUMAN_ONLY_SCOPES,
  ImpactQuery,
  type ImpactResult,
  type Issue,
  IssueAgentTokenInput,
  type IssuedAgentToken,
  type JsonValue,
  type KernelError,
  KnowledgeSearchInput,
  type KnowledgeSearchResult,
  KnowledgeStatusQuery,
  type KnowledgeStatusResult,
  type KnowledgeView,
  LibraryUsesInput,
  type LibraryUsesResult,
  ListAssessmentsInput,
  type ListAssessmentsResult,
  type Maturity,
  ObjectQuery,
  type ObjectQueryResult,
  type ObjectVersion,
  type OperationInput,
  type OperationParsed,
  ok,
  type ParameterNature,
  type PinFreshness,
  PinnedKnowledgeInput,
  type PinnedKnowledgeResult,
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
  type ReadAs,
  RejectProposalInput,
  RelationQuery,
  type RelationQueryResult,
  type ResolvedOperation,
  type Result,
  RevokeAgentTokenInput,
  Scope,
  type Situation,
  SituationQuery,
  type Verdict,
} from '@kalyth/contracts'
import type { z } from 'zod'
import { buildProjectExport } from '../export.ts'
import { type ApplyOptions, applyOperations } from '../kernel/apply.ts'
import { EVALUATOR_VERSION, evaluate } from '../kernel/evaluate.ts'
import { decisionFacets } from '../kernel/facets.ts'
import { assessFreshness } from '../kernel/freshness.ts'
import { elementLabel, traceImpact } from '../kernel/impact.ts'
import {
  disputeOf,
  isKnowledgeType,
  knowledgeStatus,
  libraryInputIssues,
} from '../kernel/library.ts'
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

  // ---------- K4: read-only knowledge and assessments for agents (ADR 0031) ----------

  /** A library the caller may read, at a revision it has (default: head). */
  #library(caller: unknown, library: string, revision?: number) {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const lib = this.store.getProject(library)
    if (lib?.kind !== 'library') return fail('not_found', `library ${library} does not exist`)
    const denied = this.#authz.require(ctx.value.principal, lib.id, ['project.read'])
    if (denied) return { ok: false as const, error: denied }
    const at = revision ?? lib.headRevision
    if (at > lib.headRevision)
      return fail('invalid', `revision ${at} is ahead of head ${lib.headRevision}`)
    return ok({ lib, at, principal: ctx.value.principal })
  }

  /**
   * Searches knowledge by name, alias and text: in a library at its head, or, for a project, in
   * every library it uses at the revision it uses. Libraries the caller cannot read are listed as
   * not searched; nothing from them is returned.
   */
  searchKnowledge(caller: unknown, input: unknown): Result<KnowledgeSearchResult> {
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const parsed = parse(KnowledgeSearchInput, input)
    if (!parsed.ok) return parsed
    const q = parsed.value
    const project = this.store.getProject(q.projectId)
    if (!project) return fail('not_found', `project ${q.projectId} does not exist`)
    const denied = this.#authz.require(ctx.value.principal, project.id, ['project.read'])
    if (denied) return { ok: false, error: denied }
    const targets =
      project.kind === 'library'
        ? [{ library: project.id, revision: project.headRevision }]
        : this.store
            .view(project.id, project.headRevision)
            .listObjects({ types: ['core.LibraryUse'] })
            .map((u) => ({
              library: String(u.attributes.library),
              revision: Number(u.attributes.revision),
            }))
    const needle = q.text.trim().toLowerCase()
    const libraries: KnowledgeSearchResult['libraries'] = []
    const hits: KnowledgeSearchResult['hits'] = []
    for (const target of targets) {
      const lib = this.store.getProject(target.library)
      if (!lib) {
        libraries.push({ ...target, searched: false, reason: 'not present in this store' })
        continue
      }
      if (this.#authz.require(ctx.value.principal, lib.id, ['project.read'])) {
        libraries.push({ ...target, searched: false, reason: 'not readable by this caller' })
        continue
      }
      libraries.push({ ...target, searched: true })
      const view = this.store.view(lib.id, target.revision)
      for (const o of view.listObjects({ ...(q.types ? { types: q.types } : {}) })) {
        if (!isKnowledgeType(o.type)) continue
        const a = o.attributes as Record<string, unknown>
        const name = String(a.name ?? a.statement ?? o.id)
        const aliases = Array.isArray(a.aliases) ? (a.aliases as string[]) : []
        const text = Object.values(a)
          .filter((v) => typeof v === 'string')
          .join(' ')
        const matchedOn = name.toLowerCase().includes(needle)
          ? 'name'
          : aliases.some((x) => x.toLowerCase().includes(needle))
            ? 'alias'
            : text.toLowerCase().includes(needle)
              ? 'text'
              : undefined
        if (!matchedOn) continue
        hits.push({
          library: lib.id,
          libraryName: lib.name,
          revision: target.revision,
          id: o.id,
          type: o.type,
          name,
          maturity: (a.maturity as Maturity) ?? 'proposed',
          disputed: disputeOf(view, o).status === 'disputed',
          matchedOn,
        })
      }
    }
    const rank = { name: 0, alias: 1, text: 2 }
    hits.sort((x, y) => rank[x.matchedOn] - rank[y.matchedOn] || (x.name < y.name ? -1 : 1))
    return ok({
      projectId: project.id,
      libraries,
      hits: hits.slice(0, q.limit),
      truncated: hits.length > q.limit,
    })
  }

  /**
   * One knowledge item at a library revision: its canonical content and hash, maturity, dispute,
   * support groups with review and verification, its sources' provenance, and its relations,
   * bounded. A method is read the same way (get_method).
   */
  getKnowledge(caller: unknown, input: unknown): Result<KnowledgeView> {
    const parsed = parse(GetKnowledgeInput, input)
    if (!parsed.ok) return parsed
    const q = parsed.value
    const access = this.#library(caller, q.library, q.revision)
    if (!access.ok) return access
    const { lib, at } = access.value
    const view = this.store.view(lib.id, at)
    const target = q.id.startsWith('obj_') ? 'object' : 'relation'
    const record = target === 'object' ? view.getObject(q.id) : view.getRelation(q.id)
    if (record?.lifecycle !== 'active')
      return fail('not_found', `${q.id} is not an active ${target} of ${lib.id} at revision ${at}`)
    const version = versionAt(this.store, { library: lib.id, target, id: q.id, revision: at })
    if (!version.ok) return fail('invalid', version.detail)
    const evidenceIds = [...new Set(record.claim.supports.flatMap((g) => g.allOf))].slice(0, 50)
    const sources = evidenceIds.flatMap((id) => {
      const e = view.getEvidence(id)
      if (!e) return []
      const s = e.source
      return [
        {
          evidence: id,
          kind: s.kind,
          ...(s.kind === 'document' || s.kind === 'external' ? { uri: s.uri } : {}),
          ...(s.kind === 'document' && s.locator ? { locator: s.locator } : {}),
          ...((s.kind === 'document' || s.kind === 'external') && s.meta ? { meta: s.meta } : {}),
          ...(s.kind === 'statement' ? { statedBy: s.statedBy } : {}),
        },
      ]
    })
    const nameOf = (id: string) => {
      const o = view.getObject(id)
      return {
        id,
        type: o?.type ?? 'unknown',
        name: String(o?.attributes.name ?? o?.attributes.statement ?? o?.attributes.text ?? id),
      }
    }
    const all =
      target === 'object'
        ? [
            ...view
              .listRelations({ from: q.id })
              .map((r) => ({ r, direction: 'out' as const, other: r.to })),
            ...view
              .listRelations({ to: q.id })
              .map((r) => ({ r, direction: 'in' as const, other: r.from })),
          ]
        : []
    const LIMIT = 100
    const relations = all.slice(0, LIMIT).map(({ r, direction, other }) => ({
      id: r.id,
      type: r.type,
      direction,
      other: nameOf(other),
      properties: r.properties,
    }))
    const status = target === 'object' ? knowledgeStatus(view, record as ObjectVersion) : undefined
    const maturity = status?.maturity
    return ok({
      library: lib.id,
      libraryName: lib.name,
      revision: at,
      headRevision: lib.headRevision,
      id: q.id,
      target,
      type: record.type,
      versionSha256: version.sha256,
      content: JSON.parse(version.text),
      ...(status
        ? { maturity: status.maturity, dispute: status.dispute, support: status.groups }
        : {}),
      sources,
      relations,
      relationsOmitted: Math.max(0, all.length - LIMIT),
      readAs: {
        recommendation: false,
        current: at === lib.headRevision,
        supported: status ? status.supported : true,
        resolved: true,
        note: [
          maturity
            ? `maturity ${maturity}${maturity === 'established' ? ' (reviewed, not proven)' : ''}`
            : 'a relation: as mature as its own reviews',
          status?.dispute.status === 'disputed' ? 'disputed' : undefined,
          at === lib.headRevision ? undefined : `library head is revision ${lib.headRevision}`,
        ]
          .filter(Boolean)
          .join('; '),
      },
    })
  }

  /** A method (ADR 0029 §4): read as knowledge, refused for any other type. */
  getMethod(caller: unknown, input: unknown): Result<KnowledgeView> {
    const r = this.getKnowledge(caller, input)
    if (r.ok && r.value.type !== 'knowledge.Method')
      return fail('invalid', `${r.value.id} is a ${r.value.type}, not a method`)
    return r
  }

  /** The libraries a project uses, and how far each has moved on since (ADR 0027 §4). */
  listLibraryUses(caller: unknown, input: unknown): Result<LibraryUsesResult> {
    const r = this.#readable(caller, LibraryUsesInput, input)
    if (!r.ok) return r
    const { project, revision } = r.value
    const uses = this.store
      .view(project.id, revision)
      .listObjects({ types: ['core.LibraryUse'] })
      .map((u) => {
        const library = String(u.attributes.library)
        const lib = this.store.getProject(library)
        const used = Number(u.attributes.revision)
        return {
          id: u.id,
          library,
          label: String(u.attributes.label),
          role: String(u.attributes.role),
          revision: used,
          present: Boolean(lib),
          ...(lib
            ? {
                libraryName: lib.name,
                headRevision: lib.headRevision,
                behind: lib.headRevision - used,
              }
            : {}),
        }
      })
    return ok({ projectId: project.id, revision, uses })
  }

  /** assess, with how to read the result (K4): always computed now, never a recommendation. */
  assessApplicability(
    caller: unknown,
    input: unknown,
  ): Result<AssessmentResult & { readAs: ReadAs }> {
    const r = this.assess(caller, input)
    if (!r.ok) return r
    return ok({ ...r.value, readAs: readAsOf(r.value.explanation, true) })
  }

  /** Every assessment of a project, with its freshness and how to read it (ADR 0029 §3). */
  listAssessments(caller: unknown, input: unknown): Result<ListAssessmentsResult> {
    const r = this.#readable(caller, ListAssessmentsInput, input)
    if (!r.ok) return r
    const { project, revision } = r.value
    const status = this.getAssessmentStatus(caller, { projectId: project.id, revision })
    if (!status.ok) return status
    const fresh = new Map(status.value.assessments.map((a) => [a.id, a]))
    const view = this.store.view(project.id, revision)
    const assessments = view
      .listObjects({ types: ['core.Assessment'] })
      .map((a) => summaryOf(a, fresh.get(a.id)))
    return ok({ projectId: project.id, revision, assessments })
  }

  /** One assessment, with its full explanation, inputs and freshness. */
  getAssessment(caller: unknown, input: unknown): Result<AssessmentView> {
    const r = this.#readable(caller, GetAssessmentInput, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const a = this.store.view(project.id, revision).getObject(q.id)
    if (a?.type !== 'core.Assessment') return fail('not_found', `${q.id} is not an assessment`)
    const status = this.getAssessmentStatus(caller, { projectId: project.id, revision })
    if (!status.ok) return status
    const fresh = status.value.assessments.find((x) => x.id === a.id)
    return ok({
      ...summaryOf(a, fresh),
      explanation: a.attributes.explanation as unknown as Explanation,
      inputs: a.attributes.inputs,
    })
  }

  /** Evaluates one pinned item for a scenario, element and nature, read-only (ADR 0028 §4 to §6). */
  assess(caller: unknown, input: unknown): Result<AssessmentResult> {
    const r = this.#readable(caller, AssessInput, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const e = evaluate(this.store, project.id, revision, q)
    if (!e.ok) return fail('invalid', e.message, { issues: [{ code: e.code, message: e.message }] })
    return ok({ verdict: e.verdict, explanation: e.explanation, inputs: e.inputs })
  }

  /**
   * Files a proposal of a new Assessment (ADR 0029 §1). It supersedes the current assessments of
   * the same item, scenario, element and nature, and asks one open Question for each missing
   * value (ADR 0028 §3a). A person commits it; nothing is assessed automatically.
   */
  proposeAssessment(caller: unknown, input: unknown): Result<ProposeChangeOutput> {
    const r = this.#readable(caller, AssessInput, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const e = evaluate(this.store, project.id, revision, q)
    if (!e.ok) return fail('invalid', e.message, { issues: [{ code: e.code, message: e.message }] })
    const view = this.store.view(project.id, revision)
    const same = (a: ObjectVersion) =>
      a.attributes.item === q.item &&
      a.attributes.scenario === q.scenario &&
      a.attributes.element === q.element &&
      a.attributes.nature === q.nature
    const earlier = view
      .listObjects({ types: ['core.Assessment'] })
      .filter(
        (a) => same(a) && view.listRelations({ types: ['supersedes'], to: a.id }).length === 0,
      )
    const open = view.listObjects({ types: ['core.Question'], attributeEquals: { status: 'open' } })
    const ops: OperationInput[] = [
      {
        op: 'createObject',
        ref: '$assessment',
        type: 'core.Assessment',
        stance: 'toBe',
        attributes: {
          item: q.item,
          scenario: q.scenario,
          ...(q.element ? { element: q.element } : {}),
          nature: q.nature,
          verdict: e.verdict,
          explanation: e.explanation as unknown as JsonValue,
          inputs: e.inputs as unknown as JsonValue,
          producedBy: { kind: 'evaluator', evaluatorVersion: e.inputs.evaluatorVersion },
        },
        claim: {
          basis: 'inferred',
          confidence: {
            level: 'high',
            rationale:
              'A deterministic evaluation of declared conditions; it says nothing beyond them.',
          },
          supports: [{ allOf: [q.item] }],
          derivedFrom: e.inputs.parameters.map((p) => p.id),
        },
      },
      ...earlier.map(
        (a): OperationInput => ({
          op: 'createRelation',
          type: 'supersedes',
          from: '$assessment',
          to: a.id,
          stance: 'toBe',
          claim: { basis: 'stated' },
        }),
      ),
    ]
    e.explanation.missing.forEach((m, i) => {
      const where = m.element ?? 'the whole system'
      const unit = m.dimension ? ` (${m.dimension})` : ''
      const text =
        'What is the ' +
        m.nature +
        ' value of "' +
        m.conceptName +
        '" for ' +
        where +
        ' in scenario ' +
        m.scenario +
        unit +
        '?'
      if (open.some((x) => x.attributes.text === text)) return
      ops.push(
        {
          op: 'createObject',
          ref: `$missing${i}`,
          type: 'core.Question',
          stance: 'toBe',
          attributes: { text, inquiryRole: 'decision-sensitive' },
          claim: { basis: 'stated' },
        },
        {
          op: 'createRelation',
          type: 'concerns',
          from: `$missing${i}`,
          to: m.scenario,
          stance: 'toBe',
          claim: { basis: 'stated' },
        },
      )
    })
    // An item that declares nothing that must hold is not established as applicable (A3): ask
    // which conditions the library should declare, once.
    if (e.explanation.specification === 'underspecified') {
      const text = `Which conditions must hold for "${e.explanation.item.name}"? Its library declares none, so whether it applies is not established.`
      if (!open.some((x) => x.attributes.text === text))
        ops.push(
          {
            op: 'createObject',
            ref: '$underspecified',
            type: 'core.Question',
            stance: 'toBe',
            attributes: { text, inquiryRole: 'decision-sensitive' },
            claim: { basis: 'stated' },
          },
          {
            op: 'createRelation',
            type: 'concerns',
            from: '$underspecified',
            to: q.scenario,
            stance: 'toBe',
            claim: { basis: 'stated' },
          },
        )
    }
    return this.proposeChange(caller, {
      projectId: project.id,
      baseRevision: revision,
      ops,
      rationale: `Assess ${e.explanation.item.name} (${q.nature}): ${e.verdict}`,
    })
  }

  /**
   * Freshness of every assessment, computed on read (ADR 0029 §3). It is stale when a newer
   * assessment supersedes it, when the evaluator changed, when an item it read no longer has the
   * same hash at the library revision the project uses, or when evaluating again now reads
   * different parameters, scenarios or elements. Nothing is recomputed in place.
   */
  getAssessmentStatus(caller: unknown, input: unknown): Result<AssessmentStatusResult> {
    const r = this.#readable(caller, ProjectRef, input)
    if (!r.ok) return r
    const { project, revision } = r.value
    const view = this.store.view(project.id, revision)
    const assessments = view.listObjects({ types: ['core.Assessment'] }).map((a) => {
      const reasons: string[] = []
      const inputs = a.attributes.inputs as unknown as DependencySet
      for (const s of view.listRelations({ types: ['supersedes'], to: a.id }))
        reasons.push(`superseded by ${s.from}`)
      if (inputs.evaluatorVersion !== EVALUATOR_VERSION) reasons.push('evaluator changed')
      for (const k of inputs.knowledge) {
        const [use] = view.listObjects({
          types: ['core.LibraryUse'],
          attributeEquals: { library: k.library },
        })
        if (!use) {
          reasons.push(`no LibraryUse of ${k.library}`)
          continue
        }
        const at = Number(use.attributes.revision)
        const now = versionAt(this.store, { ...k, revision: at })
        if (!now.ok) reasons.push(`knowledge ${k.id}: ${now.reason} at revision ${at}`)
        else if (now.sha256 !== k.versionSha256)
          reasons.push(`knowledge ${k.id} changed at library revision ${at}`)
      }
      const again = evaluate(this.store, project.id, revision, assessed(a.attributes))
      if (!again.ok) reasons.push(`cannot evaluate again: ${again.message}`)
      else {
        const before = new Map(
          [
            ...inputs.parameters,
            ...inputs.scenarios,
            ...inputs.elements,
            ...(inputs.correspondences ?? []),
            ...(inputs.decisions ?? []),
          ].map((x) => [x.id, x.revision]),
        )
        for (const x of [
          ...again.inputs.parameters,
          ...again.inputs.scenarios,
          ...again.inputs.elements,
          ...(again.inputs.correspondences ?? []),
          ...(again.inputs.decisions ?? []),
        ]) {
          const was = before.get(x.id)
          if (was === undefined) reasons.push(`${x.id} is now read`)
          else if (was !== x.revision) reasons.push(`${x.id} changed`)
          before.delete(x.id)
        }
        for (const id of before.keys()) reasons.push(`${id} is no longer read or no longer active`)
      }
      return {
        id: a.id,
        verdict: a.attributes.verdict as AssessmentResult['verdict'],
        status: reasons.length > 0 ? ('stale' as const) : ('current' as const),
        reasons: [...new Set(reasons)],
        ...(again.ok ? { verdictNow: again.verdict } : {}),
      }
    })
    return ok({ projectId: project.id, revision, assessments })
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
        const scopes: Scope[] = [
          ...AGENT_TOKEN_SCOPES,
          ...(req.pinnedKnowledge ? (['knowledge.pinned.read'] as const) : []),
        ]
        this.grant(principal.id, scopes, project.id, who.value.id, expiresAt)
        const summary: AgentTokenSummary = {
          id: this.#ids('agentToken'),
          projectId: project.id,
          principalId: principal.id,
          label: req.label,
          scopes,
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
        .map((t) => ({ ...t, scopes: this.#tokenScopes(t.principalId, t.projectId) })),
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
    return ok({ ...after, scopes: this.#tokenScopes(after.principalId, after.projectId) })
  }

  /** The scopes an agent token's principal was granted on its project. */
  #tokenScopes(principalId: string, projectId: string): Scope[] {
    const held = new Set(
      this.store
        .grantsFor(principalId)
        .filter((g) => g.projectId === projectId)
        .flatMap((g) => g.scopes),
    )
    return Scope.options.filter((s) => held.has(s))
  }

  /**
   * The knowledge snapshots a project pins, from its own embedded copies (ADR 0032). It needs
   * project.read and knowledge.pinned.read on the project, and reads no library: a copy that is
   * missing is reported as not embedded, never fetched from the library.
   */
  getPinnedKnowledge(caller: unknown, input: unknown): Result<PinnedKnowledgeResult> {
    const r = this.#readable(caller, PinnedKnowledgeInput, input)
    if (!r.ok) return r
    const { project, revision, input: q } = r.value
    const ctx = this.#context(caller)
    if (!ctx.ok) return ctx
    const denied = this.#authz.require(ctx.value.principal, project.id, ['knowledge.pinned.read'])
    if (denied) return { ok: false, error: denied }
    const embedded = (sha: string) => {
      const copy = this.store.getContent(project.id, contentIdOf(sha))
      if (typeof copy?.body !== 'string') return { state: 'notEmbedded' as const }
      if (sha256Hex(copy.body) !== sha) return { state: 'hashMismatch' as const }
      return { state: 'embedded' as const, content: JSON.parse(copy.body) as unknown }
    }
    const pins = [...this.store.evidenceMapAt(project.id, revision).values()]
      .filter((e) => e.source.kind === 'knowledge' && (!q.evidence || e.id === q.evidence))
      .map((e) => {
        const pin = e.source as PinSource
        const sha = pin.versionSha256 ?? ''
        const copy = embedded(sha)
        const cited =
          copy.state === 'embedded'
            ? (
                (
                  copy.content as {
                    claim?: {
                      supports?: { allOf?: { evidence: string; evidenceSha256: string }[] }[]
                    }
                  }
                ).claim?.supports ?? []
              ).flatMap((g) => g.allOf ?? [])
            : []
        const cites = [...new Map(cited.map((c) => [c.evidence, c])).values()].map((c) => {
          const source = embedded(c.evidenceSha256)
          return { ...c, ...(source.state === 'embedded' ? { source: source.content } : {}) }
        })
        return {
          evidence: e.id,
          library: pin.library,
          target: pin.target,
          id: pin.id,
          revision: pin.revision,
          versionSha256: sha,
          state: copy.state,
          ...(copy.state === 'embedded' ? { content: copy.content } : {}),
          cites,
        }
      })
      .sort((a, b) => (a.evidence < b.evidence ? -1 : 1))
    return ok({ projectId: project.id, revision, pins })
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
        ...this.#assessmentIssues(project.id, req.baseRevision, resolved.ops),
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
      own.issues.push(
        ...this.#assessmentIssues(project.id, head, proposal.ops).map((i) => ({
          ...i,
          code: 'assessment.stale_at_head',
        })),
      )
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
      pinContent: (sha) => {
        const copy = this.store.getContent(project.id, contentIdOf(sha))
        return typeof copy?.body === 'string' && sha256Hex(copy.body) === sha
          ? JSON.parse(copy.body)
          : undefined
      },
    }
  }

  /**
   * An assessment states what the evaluator computes, so each one is computed again from the
   * committed state when proposed, and at the head when committed (ADR 0028 I4, R1). One that
   * differs is refused: a verdict is never typed in.
   */
  #assessmentIssues(
    projectId: string,
    revision: number,
    ops: readonly ResolvedOperation[],
  ): Issue[] {
    const issues: Issue[] = []
    ops.forEach((op, index) => {
      if (op.op !== 'createObject' || op.type !== 'core.Assessment') return
      const a = op.attributes as Record<string, unknown>
      const computed = evaluate(this.store, projectId, revision, assessed(a))
      const claimed = canonicalJson({
        verdict: a.verdict,
        explanation: a.explanation,
        inputs: a.inputs,
      })
      if (!computed.ok)
        issues.push({ code: 'assessment.not_reproducible', message: computed.message, op: index })
      else if (
        canonicalJson({
          verdict: computed.verdict,
          explanation: computed.explanation,
          inputs: computed.inputs,
        }) !== claimed
      )
        issues.push({
          code: 'assessment.not_reproducible',
          message:
            'the evaluator gives a different verdict, explanation or inputs at this revision',
          op: index,
        })
    })
    return issues
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

/** How an agent should read an explanation (K4): flags first, prose second. */
function readAsOf(e: Explanation, current: boolean): ReadAs {
  const unresolved = e.steps.some(
    (s) => s.reason === 'no-correspondence' || s.reason === 'incompatible',
  )
  const parts = [
    `${e.verdict} for ${e.nature} values: declared conditions only, not a recommendation`,
    e.specification === 'underspecified' ? 'the item declares nothing that must hold' : undefined,
    e.missing.length > 0 ? `${e.missing.length} value(s) missing` : undefined,
    e.conflict?.state === 'unsettled' ? 'libraries disagree, unsettled' : undefined,
    e.conflict?.state === 'settled'
      ? 'libraries disagree; a decision chose which to follow'
      : undefined,
    e.knowledge.disputed ? 'the knowledge is disputed' : undefined,
    `knowledge maturity ${e.knowledge.maturity}`,
    `scenario ${e.scenario.status}`,
  ]
  return {
    recommendation: false,
    current,
    supported: e.specification === 'sufficient',
    resolved: !unresolved,
    note: parts.filter(Boolean).join('; '),
  }
}

function summaryOf(
  a: ObjectVersion,
  fresh: AssessmentStatusResult['assessments'][number] | undefined,
) {
  const e = a.attributes.explanation as unknown as Explanation
  const freshness = fresh ?? {
    id: a.id,
    verdict: a.attributes.verdict as Verdict,
    status: 'stale' as const,
    reasons: ['freshness unknown'],
  }
  return {
    id: a.id,
    item: { library: e.item.library, id: e.item.id, name: e.item.name },
    scenario: String(a.attributes.scenario),
    ...(typeof a.attributes.element === 'string' ? { element: a.attributes.element } : {}),
    nature: (a.attributes.nature as ParameterNature) ?? 'expected',
    verdict: a.attributes.verdict as Verdict,
    specification: e.specification ?? 'sufficient',
    conflict: e.conflict?.state ?? 'none',
    freshness,
    readAs: readAsOf(e, freshness.status === 'current'),
  }
}

/** What an assessment's attributes say was assessed. */
function assessed(a: Record<string, unknown>) {
  return {
    item: String(a.item),
    scenario: String(a.scenario),
    element: typeof a.element === 'string' ? a.element : undefined,
    nature: (typeof a.nature === 'string' ? a.nature : 'expected') as ParameterNature,
  }
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
