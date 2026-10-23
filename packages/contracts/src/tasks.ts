import { z } from 'zod'
import {
  ContextPackageId,
  ObjectId,
  PrincipalId,
  ProjectId,
  ProposalId,
  RelationId,
} from './ids.ts'
import { TaskFinding, TaskLease, TaskStatus } from './ops.ts'

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-hex commit sha')

// ---------- tasks, leases and execution reports (ADR 0013) ----------

export const TestRun = z.object({
  command: z.string().min(1).max(500),
  passed: z.int().min(0),
  failed: z.int().min(0),
  note: z.string().max(1000).optional(),
})
export type TestRun = z.infer<typeof TestRun>

export const TaskListQuery = z.object({ projectId: ProjectId, status: TaskStatus.optional() })
export const TaskQuery = z.object({ taskId: ObjectId })

export const VerificationOutcome = z.enum(['pass', 'fail', 'inconclusive'])

export const TaskReportView = z.object({
  id: ObjectId,
  outcome: z.enum(['succeeded', 'failed', 'partial']),
  summary: z.string(),
  commit: z.string().nullable(),
  filesChanged: z.array(z.string()),
  tests: z.array(TestRun),
  revision: z.int().min(0),
  /** When the revision that recorded the report was committed. */
  reportedAt: z.iso.datetime(),
  verification: z
    .object({ id: ObjectId, outcome: VerificationOutcome, summary: z.string() })
    .nullable(),
  /**
   * The person who filed the report themselves, for work done outside an agent session
   * (ADR 0024); null for an agent's report under its lease. Optional for readers of earlier
   * results.
   */
  filedBy: PrincipalId.nullable().optional(),
})

export const TaskView = z.object({
  id: ObjectId,
  projectId: ProjectId,
  title: z.string(),
  description: z.string().nullable(),
  acceptanceCriteria: z.array(z.string()),
  status: TaskStatus,
  statusRationale: z.string().nullable(),
  lease: TaskLease.nullable(),
  /** True when the task is running and its lease has passed its expiry. */
  leaseExpired: z.boolean(),
  contextPackageId: ContextPackageId.nullable(),
  baseCommit: z.string().nullable(),
  implements: z.array(z.object({ id: ObjectId, type: z.string(), label: z.string() })),
  requires: z.array(
    z.object({ id: ObjectId, type: z.string(), label: z.string(), satisfied: z.boolean() }),
  ),
  reports: z.array(TaskReportView),
  /** Revision of the task's current version. */
  revision: z.int().min(0),
  /** When the revision that created the task was committed. */
  createdAt: z.iso.datetime(),
  /** When the task's current version was committed: its last status, lease or attribute change. */
  updatedAt: z.iso.datetime(),
  /**
   * What a claim found in the task repository while the task's outcome is unknown: commits that
   * carry its trailer, for a person to review (ADR 0013, amendment of 2026-10-20). Null otherwise.
   * Optional for readers of earlier results.
   */
  finding: TaskFinding.nullable().optional(),
  /**
   * Text a person pastes into a coding agent to start the task (ADR 0024). Deterministic from the
   * task; it never holds a token or other secret. Optional for readers of earlier results.
   */
  agentPrompt: z.string().optional(),
})
export type TaskView = z.infer<typeof TaskView>

export const TaskList = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  tasks: z.array(TaskView),
})
export type TaskList = z.infer<typeof TaskList>

export const ClaimTaskInput = z.object({
  taskId: ObjectId,
  leaseMinutes: z.int().min(5).max(240).default(60),
})

export const ClaimResult = z.object({
  task: TaskView,
  lease: TaskLease,
  /** Context for the work: the task, what it implements and its acceptance criteria. */
  contextPackageId: ContextPackageId.nullable(),
  instructions: z.array(z.string()),
})
export type ClaimResult = z.infer<typeof ClaimResult>

export const RenewLeaseInput = z.object({
  taskId: ObjectId,
  leaseId: TaskLease.shape.id,
  leaseMinutes: z.int().min(5).max(240).default(60),
})

export const ReleaseTaskInput = z.object({
  taskId: ObjectId,
  leaseId: TaskLease.shape.id,
  reason: z.string().min(1).max(2000),
})

export const SubmitReportInput = z.object({
  taskId: ObjectId,
  leaseId: TaskLease.shape.id,
  idempotencyKey: z.string().min(8).max(200),
  outcome: z.enum(['succeeded', 'failed', 'partial']),
  summary: z.string().min(1).max(4000),
  commit: sha.optional(),
  filesChanged: z.array(z.string().min(1).max(1000)).max(500).default([]),
  tests: z.array(TestRun).max(20).default([]),
})
export type SubmitReportInput = z.input<typeof SubmitReportInput>

export const VerificationCheck = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })
export type VerificationCheck = z.infer<typeof VerificationCheck>

export const ReportResult = z.object({
  task: TaskView,
  reportId: ObjectId,
  verification: z.object({
    id: ObjectId.nullable(),
    outcome: VerificationOutcome,
    checks: z.array(VerificationCheck),
  }),
  /** True when the idempotency key was already used: nothing new was recorded. */
  duplicate: z.boolean(),
})
export type ReportResult = z.infer<typeof ReportResult>

/**
 * A report a person files themselves, typically for work done outside an agent session
 * (ADR 0024). It names a commit and the files changed and is verified against git like an agent's
 * report. A person records a failed attempt with a status change instead.
 */
export const FileReportInput = z.object({
  taskId: ObjectId,
  idempotencyKey: z.string().min(8).max(200),
  outcome: z.enum(['succeeded', 'partial']).default('succeeded'),
  summary: z.string().trim().min(1).max(4000),
  commit: sha,
  filesChanged: z.array(z.string().min(1).max(1000)).min(1).max(500),
  tests: z.array(TestRun).max(20).default([]),
})
export type FileReportInput = z.input<typeof FileReportInput>

export const ReconcileTaskInput = z.object({ taskId: ObjectId })

/**
 * What the source shows changed for one element between a task's base commit and its verified
 * commit, both read by the same analyzer (ADR 0024, amendment of 2026-10-20). Observed in the
 * source within the analyzer's coverage; it says nothing about how the code behaves when run.
 */
export const ObservedElementChange = z.object({
  /** The analyzer's stable key for the element, such as `entity:Item`. */
  key: z.string(),
  type: z.string(),
  label: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
  /** The source the element's evidence cites changed, not only other parts of its file. */
  sourceChanged: z.boolean(),
  /** What changed, in words: fields, parameters and relations added or removed. */
  details: z.array(z.string()).max(50),
  /**
   * Which commits changed the files the element's evidence cites, when the compared range also
   * holds commits without this task's trailer: `task`, `other` (only commits that are not the
   * task's), `both`, or `unclear` (no commit in the range changed its files; a relation moved
   * because of a change elsewhere). Absent when every commit in the range is the task's.
   */
  origin: z.enum(['task', 'other', 'both', 'unclear']).optional(),
})
export type ObservedElementChange = z.infer<typeof ObservedElementChange>

/** A direct change of the decision, and what the task's verified commit did to its target. */
export const ReconciledChange = z.object({
  relationId: RelationId,
  alternativeId: ObjectId,
  target: ObjectId,
  label: z.string(),
  type: z.string(),
  /** True for a proposed (to-be) element: it has no source yet, so it is matched instead. */
  proposed: z.boolean(),
  change: z.string(),
  /** A file the target's evidence cites is among the verified files changed. */
  touched: z.boolean(),
  /** Those files. */
  files: z.array(z.string()),
  /**
   * What the source shows for the target between the base and the verified commit: `changed` when
   * its own source or structure changed (or, for a proposed element, an element of its type and
   * name appeared), `other` when it changed only through commits that are not this task's,
   * `nearby` when only another part of a file it cites changed, `unchanged` otherwise. Null when
   * the two commits could not be compared.
   */
  observed: z.enum(['changed', 'other', 'nearby', 'unchanged']).nullable().default(null),
  /** What changed for the target, in words. */
  details: z.array(z.string()).default([]),
})
export type ReconciledChange = z.infer<typeof ReconciledChange>

/** A proposed element of the decision, and the observed element that now matches it, if any. */
export const ReconciledElement = z.object({
  id: ObjectId,
  type: z.string(),
  label: z.string(),
  match: z
    .object({
      id: ObjectId,
      label: z.string(),
      /** A file the observed element's evidence cites is among the verified files changed. */
      inCommit: z.boolean(),
    })
    .nullable(),
  /**
   * How many observed elements share the type and name when more than one does: then none is
   * matched, since choosing one would be a guess.
   */
  ambiguous: z.int().min(2).optional(),
  /** The `realizes` link from the match: committed already, or a proposal for a person. */
  link: z
    .object({
      state: z.enum(['committed', 'pending', 'rejected']),
      relationId: RelationId.nullable(),
      proposalId: ProposalId.nullable(),
      /** True when this reconciliation proposed it. */
      created: z.boolean(),
    })
    .nullable(),
})
export type ReconciledElement = z.infer<typeof ReconciledElement>

export const ReconciledDecision = z.object({
  id: ObjectId,
  title: z.string(),
  status: z.string(),
  /** The alternatives whose direct changes count: the accepted ones, or all while none is. */
  alternatives: z.array(z.object({ id: ObjectId, title: z.string(), status: z.string() })),
  changes: z.array(ReconciledChange),
  /** How many of `changes` the commit touched. */
  touched: z.int().min(0),
  /** How many of `changes` the source shows as changed. */
  changed: z.int().min(0).default(0),
  proposed: z.array(ReconciledElement),
})
export type ReconciledDecision = z.infer<typeof ReconciledDecision>

/**
 * The model reconciled with a task's verified commit (ADR 0024): the analysis of that commit, and
 * for each decision the task implements, what the commit touched and which proposed elements now
 * have an observed match. Links are proposed, never committed, here.
 */
export const ReconcileResult = z.object({
  taskId: ObjectId,
  projectId: ProjectId,
  report: z.object({ id: ObjectId, commit: sha, filesChanged: z.array(z.string()) }),
  analysis: z.object({
    repo: z.string(),
    commit: sha,
    /**
     * `analysed`: the analyzer read the commit and its observations were committed (or nothing
     * had changed). `skipped`: the model already reflects a later commit that contains this one.
     */
    status: z.enum(['analysed', 'skipped']),
    detail: z.string(),
    proposalId: ProposalId.nullable(),
    created: z.int().min(0),
    refreshed: z.int().min(0),
    unchanged: z.int().min(0),
  }),
  /** The revision the summary was computed at: the head after the analysis. */
  revision: z.int().min(0),
  decisions: z.array(ReconciledDecision),
  /**
   * The base and the verified commit compared by one analyzer, so the difference is the commit's
   * and not a newer analyzer's. Null when the base could not be read.
   */
  observed: z
    .object({
      base: sha,
      commit: sha,
      analyzer: z.string(),
      /** Elements whose source or structure changed, of any kind except modules. */
      elementsChanged: z.int().min(0),
      /** Modules (files) whose source changed. */
      modulesChanged: z.int().min(0),
      /** Changed elements that no direct change of the decisions names. */
      unplanned: z.array(ObservedElementChange).max(100),
      /** The commits compared: the task's (with its trailer) and others between base and commit. */
      commits: z
        .object({
          task: z.int().min(0),
          other: z.array(sha).max(20),
          otherCount: z.int().min(0),
          /** Set when the commit does not descend from the base: compared from their merge base. */
          mergeBase: sha.nullable(),
        })
        .optional(),
      /** Elements changed only by commits that are not this task's: not counted as its work. */
      byOthers: z.array(ObservedElementChange).max(100).default([]),
      /** Why there is no comparison, or what limits it. */
      note: z.string().nullable(),
    })
    .nullable()
    .default(null),
})
export type ReconcileResult = z.infer<typeof ReconcileResult>

export const TaskRepositoryInput = z.object({
  projectId: ProjectId,
  path: z.string().min(1).max(1000),
})
export const TaskRepositoryQuery = z.object({ projectId: ProjectId })
export const TaskRepositoryView = z.object({
  projectId: ProjectId,
  path: z.string().nullable(),
  setBy: PrincipalId.nullable(),
  setAt: z.iso.datetime().nullable(),
})
export type TaskRepositoryView = z.infer<typeof TaskRepositoryView>
