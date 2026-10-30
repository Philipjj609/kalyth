import type { ResolvedOperation, TaskStatus } from '@kalyth/contracts'
import {
  createTaskOps,
  createTaskRationale,
  statusChangeOps,
  TASK_REF,
  type TaskDraft,
} from '../model/tasks.ts'
import type { Api } from './client.ts'
import { type ProposeCommitOutcome, proposeAndCommit } from './decide.ts'

/**
 * A person changes tasks through ordinary proposals (ADR 0013): propose against the head they
 * saw, then commit. Claiming, renewing, releasing and reporting belong to agents over MCP; the UI
 * never does those.
 */

export interface ChangeTaskStatusInput {
  taskId: string
  status: TaskStatus
  rationale: string
  /** The revision of the task list the person acted on. */
  baseRevision: number
}

export function changeTaskStatus(
  api: Pick<Api, 'propose' | 'commit'>,
  projectId: string,
  input: ChangeTaskStatusInput,
): Promise<ProposeCommitOutcome> {
  return proposeAndCommit(
    api,
    projectId,
    {
      baseRevision: input.baseRevision,
      rationale: input.rationale,
      ops: statusChangeOps(input.taskId, input.status, input.rationale),
    },
    'The status change',
  )
}

export interface CreateTaskInput {
  draft: TaskDraft
  baseRevision: number
}

/** A committed creation also carries the new task's id, unless neither source could give it. */
export type CreateTaskOutcome =
  | (Extract<ProposeCommitOutcome, { committed: unknown }> & { taskId: string | null })
  | Extract<ProposeCommitOutcome, { refused: unknown }>

/** The id the stored proposal gave the new task. */
export function createdTaskId(ops: readonly ResolvedOperation[]): string | null {
  const created = ops.find((op) => op.op === 'createObject' && op.type === 'core.Task')
  return created?.op === 'createObject' ? created.id : null
}

/**
 * Proposes and commits a new task. The commit names the id its local reference resolved to; a
 * server that does not yet answer with refs is covered by reading the stored proposal back. If
 * that read fails the task still exists; the outcome then has no id.
 */
export async function createTask(
  api: Pick<Api, 'propose' | 'commit' | 'proposal'>,
  projectId: string,
  input: CreateTaskInput,
): Promise<CreateTaskOutcome> {
  const outcome = await proposeAndCommit(
    api,
    projectId,
    {
      baseRevision: input.baseRevision,
      rationale: createTaskRationale(input.draft),
      ops: createTaskOps(input.draft),
    },
    'The task',
  )
  if ('refused' in outcome) return outcome
  const fromCommit = outcome.committed.refs?.[TASK_REF]
  if (fromCommit) return { ...outcome, taskId: fromCommit }
  let taskId: string | null = null
  try {
    taskId = createdTaskId((await api.proposal(outcome.proposalId)).ops)
  } catch {
    // The task was committed; only the link to open it is missing.
  }
  return { ...outcome, taskId }
}
