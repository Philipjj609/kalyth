import { z } from 'zod'
import { ContextPackageId, ObjectId, PrincipalId, ProjectId } from './ids.ts'
import { TaskLease, TaskStatus } from './ops.ts'

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
