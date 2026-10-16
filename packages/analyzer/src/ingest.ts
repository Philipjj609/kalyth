import type {
  Caller,
  EvidenceRecord,
  Issue,
  KernelError,
  ObjectVersion,
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
const RELATION_TYPES = ['contains', 'dependsOn', 'exposes']

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
}): Promise<IngestReport> {
  const { services, caller, projectId } = options
  const analysis = await analyzeRepository({
    git: options.git,
    repo: options.repo,
    ref: options.ref,
  })
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: KernelError }): T => {
    if (!r.ok) throw new IngestError(r.error.message, r.error)
    return r.value
  }

  const head = unwrap(services.getProjectOverview(caller, { projectId })).project.headRevision
  const objects: ObjectVersion[] = []
  for (const type of OBJECT_TYPES)
    objects.push(
      ...unwrap(
        services.queryObjects(caller, { projectId, revision: head, types: [type], limit: 1000 }),
      ).objects,
    )
  const relations: RelationVersion[] = []
  for (const type of RELATION_TYPES)
    relations.push(
      ...unwrap(
        services.queryRelations(caller, { projectId, revision: head, types: [type], limit: 1000 }),
      ).relations,
    )
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

  const proposed = unwrap(
    services.proposeChange(caller, {
      projectId,
      baseRevision: head,
      rationale: `Analyzer observation of ${analysis.repo} at ${analysis.commit}`,
      idempotencyKey: `ingest:${analysis.repo}@${analysis.commit}:base-${head}`,
      ops,
    }),
  )
  if (proposed.status !== 'pending') {
    throw new IngestError(`analyzer proposal is ${proposed.status}`, proposed.issues)
  }
  const committed = unwrap(services.commitProposal(caller, { proposalId: proposed.proposalId }))
  return report(committed.revision, proposed.proposalId)
}
