import type {
  Caller,
  ClaimInput,
  EvidenceRecord,
  Issue,
  KernelError,
  ObjectVersion,
  OperationInput,
  RelationVersion,
} from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import { type AnalysisResult, analyzeRepository } from './analyze.ts'
import type { GitRepository } from './git.ts'
import { type PlanStats, planIngest } from './plan.ts'

export interface IngestReport {
  repo: string
  commit: string
  baseRevision: number
  revision: number
  proposalId: string | null
  stats: PlanStats
  analysis: Pick<AnalysisResult, 'coverage' | 'limitations' | 'stats'>
}

export class IngestError extends Error {
  readonly detail: KernelError | Issue[]
  constructor(message: string, detail: KernelError | Issue[]) {
    super(message)
    this.detail = detail
  }
}

const OBJECT_TYPES = [
  'core.SourceSnapshot',
  'software.System',
  'software.Container',
  'software.Module',
  'software.Endpoint',
  'software.DataEntity',
  'software.Library',
]
const RELATION_TYPES = ['contains', 'dependsOn', 'exposes', 'reads', 'writes', 'references']
const PAGE = 1000

/**
 * Analyses a commit and submits the result as one proposal through the shared services, then
 * commits it with the caller's own authority (the analyzer principal holds ingest.observed, so only
 * observed facts can land). Nothing bypasses validation or authorisation.
 */
export async function ingestRepository(options: {
  services: KalythServices
  caller: Caller
  projectId: string
  git: GitRepository
  repo: string
  ref: string
  /** The analysis of `ref`, when the caller has it already. */
  analysis?: AnalysisResult
  /** Operations per proposal; the contract's maximum unless a test asks for fewer. */
  maxOps?: number
}): Promise<IngestReport> {
  const { services, caller, projectId } = options
  const analysis =
    options.analysis ??
    (await analyzeRepository({
      git: options.git,
      repo: options.repo,
      ref: options.ref,
    }))
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: KernelError }): T => {
    if (!r.ok) throw new IngestError(r.error.message, r.error)
    return r.value
  }

  const head = unwrap(services.getProjectOverview(caller, { projectId })).project.headRevision
  // The whole current state, page by page: planning against a partial model would add again
  // what it did not see.
  const objects: ObjectVersion[] = []
  for (const type of OBJECT_TYPES) {
    for (let after: string | undefined; ; ) {
      const page = unwrap(
        services.queryObjects(caller, {
          projectId,
          revision: head,
          types: [type],
          limit: PAGE,
          ...(after ? { after } : {}),
        }),
      ).objects
      objects.push(...page)
      if (page.length < PAGE) break
      after = page[page.length - 1]?.id
    }
  }
  const relations: RelationVersion[] = []
  for (const type of RELATION_TYPES) {
    for (let after: string | undefined; ; ) {
      const page = unwrap(
        services.queryRelations(caller, {
          projectId,
          revision: head,
          types: [type],
          limit: PAGE,
          ...(after ? { after } : {}),
        }),
      ).relations
      relations.push(...page)
      if (page.length < PAGE) break
      after = page[page.length - 1]?.id
    }
  }
  const evidenceIds = [
    ...new Set([...objects, ...relations].flatMap((r) => r.claim.supports.flatMap((g) => g.allOf))),
  ]
  const evidence = new Map<string, EvidenceRecord>()
  for (let i = 0; i < evidenceIds.length; i += 200) {
    for (const e of unwrap(
      services.getEvidence(caller, { projectId, ids: evidenceIds.slice(i, i + 200) }),
    ).evidence)
      evidence.set(e.id, e)
  }

  const { ops, stats } = planIngest(analysis, { objects, relations, evidence })
  const report = (revision: number, proposalId: string | null): IngestReport => ({
    repo: analysis.repo,
    commit: analysis.commit,
    baseRevision: head,
    revision,
    proposalId,
    stats,
    analysis: {
      coverage: analysis.coverage,
      limitations: analysis.limitations,
      stats: analysis.stats,
    },
  })
  if (ops.length === 0) return report(head, null)

  // A proposal holds at most MAX_OPS operations, so a large repository is committed in parts.
  // The plan lists evidence, then elements, then relations, then the snapshot, so an operation
  // only ever names local refs defined before it: refs a committed part defined are replaced with
  // the ids it created. The snapshot comes last, so the model reports the new commit only once
  // every observation has landed; an interrupted ingest leaves valid observations, and running
  // it again completes it.
  const size = Math.min(MAX_OPS, Math.max(1, options.maxOps ?? MAX_OPS))
  // Committed in parts, the model mixes two commits until the last part lands. The first part
  // says so on the current snapshot, so freshness, packages and the workbench can tell; the
  // last part's snapshot update clears it. (A first ingest has no snapshot yet: its records stay
  // unchecked until the last part creates one.)
  const current = objects.find(
    (o) =>
      o.type === 'core.SourceSnapshot' &&
      o.lifecycle === 'active' &&
      (o.attributes as { repo?: string }).repo === analysis.repo,
  )
  if (current && ops.length > size) {
    const parts = Math.ceil((ops.length + 1) / size)
    // The plan's own update of the snapshot comes last and states the new commit: it also says
    // the ingest is complete.
    const final = ops.findLast((op) => op.op === 'updateObject' && op.id === current.id)
    if (final?.op === 'updateObject') final.set = { ...final.set, pending: null }
    ops.unshift({
      op: 'updateObject',
      id: current.id,
      set: { pending: { commit: analysis.commit, parts } },
      claim: {
        basis: 'observed',
        ...(current.claim.observation ? { observation: current.claim.observation } : {}),
        supports: current.claim.supports.map((g) => ({ allOf: [...g.allOf] })),
      },
    })
  }
  const parts = Math.ceil(ops.length / size)
  const resolved = new Map<string, string>()
  let revision = head
  let firstProposal: string | null = null
  for (let n = 0; n < parts; n++) {
    const part = ops.slice(n * size, (n + 1) * size).map((op) => resolveRefs(op, resolved))
    const proposed = unwrap(
      services.proposeChange(caller, {
        projectId,
        baseRevision: revision,
        rationale:
          parts === 1
            ? `Analyzer observation of ${analysis.repo} at ${analysis.commit}`
            : `Analyzer observation of ${analysis.repo} at ${analysis.commit} (part ${n + 1} of ${parts})`,
        idempotencyKey: `ingest:${analysis.repo}@${analysis.commit}:base-${head}${parts === 1 ? '' : `:part-${n + 1}`}`,
        ops: part,
      }),
    )
    if (proposed.status !== 'pending') {
      throw new IngestError(`analyzer proposal is ${proposed.status}`, proposed.issues)
    }
    const committed = unwrap(services.commitProposal(caller, { proposalId: proposed.proposalId }))
    for (const [ref, id] of Object.entries(committed.refs)) resolved.set(ref, id)
    revision = committed.revision
    firstProposal ??= proposed.proposalId
  }
  return report(revision, firstProposal)
}

/** The most operations one proposal may hold (the ProposeChange contract). */
const MAX_OPS = 5000

/**
 * An operation with the local refs that earlier parts defined replaced by their ids: the ends of a
 * relation and the evidence its claim cites. Attributes are left as they are.
 */
function resolveRefs(op: OperationInput, resolved: ReadonlyMap<string, string>): OperationInput {
  if (resolved.size === 0) return op
  const id = (ref: string) => resolved.get(ref) ?? ref
  const claim = (c: ClaimInput): ClaimInput =>
    c.supports ? { ...c, supports: c.supports.map((g) => ({ ...g, allOf: g.allOf.map(id) })) } : c
  switch (op.op) {
    case 'createRelation':
      return { ...op, from: id(op.from), to: id(op.to), claim: claim(op.claim) }
    case 'createObject':
    case 'updateObject':
    case 'updateRelation':
      return op.claim ? { ...op, claim: claim(op.claim) } : op
    default:
      return op
  }
}
