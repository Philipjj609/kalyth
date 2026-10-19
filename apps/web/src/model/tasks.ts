import type {
  DecisionSummary,
  JsonValue,
  OperationInput,
  TaskStatus,
  TaskView,
} from '@kalyth/contracts'
import {
  type CriterionAction,
  criteriaReducer,
  filledCriteria,
  isCriterionAction,
} from './criteria.ts'
import { humanize } from './format.ts'
import type { StatusMeta, Tone } from './semantics.ts'

/**
 * Pure display and request logic for tasks (ADR 0013): the board's columns, what a person may do
 * from each status, the operations each action proposes, and the task form. Task text, report
 * summaries and file names are written by people and agents; the UI renders them as text only.
 */

export type TaskReport = TaskView['reports'][number]
export type ReportOutcome = TaskReport['outcome']
export type VerificationOutcome = NonNullable<TaskReport['verification']>['outcome']

// ---------- statuses and transitions ----------

/**
 * The kernel's transition table, mirrored from TASK_TRANSITIONS in @kalyth/contracts. The contracts
 * module builds zod schemas when it loads, so importing the value would put zod in the browser
 * bundle; a test keeps this copy equal to the contract.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  proposed: ['ready', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  running: ['running', 'review', 'failed', 'unknown_outcome', 'ready', 'blocked'],
  unknown_outcome: ['review', 'ready', 'failed', 'cancelled'],
  review: ['completed', 'ready', 'failed'],
  blocked: ['ready', 'cancelled'],
  failed: ['ready', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** Board columns, left to right: the work flows through the first four. */
export const BOARD_ORDER: readonly TaskStatus[] = [
  'proposed',
  'ready',
  'running',
  'review',
  'blocked',
  'unknown_outcome',
  'failed',
  'completed',
  'cancelled',
]

/** Always shown at full width; the other columns shrink to a rail while empty and space is short. */
const MAIN_COLUMNS: ReadonlySet<TaskStatus> = new Set(['proposed', 'ready', 'running', 'review'])

export const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  proposed: {
    label: 'Proposed',
    tone: 'neutral',
    description: 'Planned, but not open to agents yet. A person marks it ready.',
  },
  ready: {
    label: 'Ready',
    tone: 'accent',
    description: 'Agents can claim it once everything it requires is completed or accepted.',
  },
  running: {
    label: 'Running',
    tone: 'stated',
    description: 'An agent holds a lease on it and is working on it.',
  },
  review: {
    label: 'Review',
    tone: 'warning',
    description:
      'Kalyth’s git verifier found the reported commit in the task repository. A person confirms the work.',
  },
  blocked: {
    label: 'Blocked',
    tone: 'caution',
    description: 'A person stopped it. No agent can claim it until it is unblocked.',
  },
  unknown_outcome: {
    label: 'Unknown outcome',
    tone: 'caution',
    description:
      'The lease ran out before a report. The last holder can still report; the next claim checks git for its commit first.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    description: 'The attempt failed. It can be marked ready for another attempt, or cancelled.',
  },
  completed: {
    label: 'Completed',
    tone: 'success',
    description: 'A person confirmed the work. Final.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    description: 'A person cancelled it. Final.',
  },
}

export function taskStatusMeta(status: string): StatusMeta {
  return (
    TASK_STATUS_META[status as TaskStatus] ?? {
      label: humanize(status || 'unknown'),
      tone: 'neutral',
      description: 'A task status this version of the UI does not know.',
    }
  )
}

/** What a running task whose lease has run out means, until the next claim settles it. */
export const LEASE_EXPIRED_NOTE =
  'The lease has expired. The next claim checks git for a commit with this task’s trailer first.'

/**
 * The task's status as a person reads it: a running task whose lease has expired is no longer
 * being worked on, although it stays running until the next claim (the server says so at read
 * time, without writing anything).
 */
export function taskStatusLine(task: Pick<TaskView, 'status' | 'leaseExpired'>): {
  label: string
  description: string
} {
  if (task.status === 'running' && task.leaseExpired) {
    return { label: 'Running, lease expired', description: LEASE_EXPIRED_NOTE }
  }
  const meta = taskStatusMeta(task.status)
  return { label: meta.label, description: meta.description }
}

export const REPORT_OUTCOME_META: Record<ReportOutcome, StatusMeta> = {
  succeeded: {
    label: 'Succeeded',
    tone: 'success',
    description: 'The agent says it did the work. Stated by the agent, not verified.',
  },
  partial: {
    label: 'Partial',
    tone: 'warning',
    description: 'The agent says it did part of the work. Stated by the agent, not verified.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    description: 'The agent says the attempt failed.',
  },
}

export const VERIFICATION_META: Record<VerificationOutcome, StatusMeta> = {
  pass: {
    label: 'Pass',
    tone: 'success',
    description:
      'The git verifier found the commit on a branch, with the task trailer and the reported files since the task base.',
  },
  fail: {
    label: 'Fail',
    tone: 'danger',
    description: 'At least one check against the task repository failed.',
  },
  inconclusive: {
    label: 'Inconclusive',
    tone: 'caution',
    description:
      'The verifier could not decide, for example without a task repository or a commit.',
  },
}

const metaOr = <K extends string>(table: Record<K, StatusMeta>, key: string): StatusMeta =>
  table[key as K] ?? { label: humanize(key), tone: 'neutral' as Tone, description: '' }

export const reportOutcomeMeta = (outcome: string) => metaOr(REPORT_OUTCOME_META, outcome)
export const verificationMeta = (outcome: string) => metaOr(VERIFICATION_META, outcome)

// ---------- the board ----------

export interface BoardColumn {
  status: TaskStatus
  tasks: TaskView[]
  /** Empty and not one of the main columns: shown as a narrow rail when space is short. */
  collapsible: boolean
}

/** Most recently changed first; ties by title, then id, so the order is stable between polls. */
const byRecent = (a: TaskView, b: TaskView) =>
  b.revision - a.revision || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)

/** One column per status, in board order. A task with a status the UI does not know is left out. */
export function boardColumns(tasks: readonly TaskView[]): BoardColumn[] {
  const byStatus = new Map<TaskStatus, TaskView[]>()
  for (const task of tasks) {
    byStatus.set(task.status, [...(byStatus.get(task.status) ?? []), task])
  }
  return BOARD_ORDER.map((status) => {
    const list = (byStatus.get(status) ?? []).sort(byRecent)
    return { status, tasks: list, collapsible: list.length === 0 && !MAIN_COLUMNS.has(status) }
  })
}

/** The newest report first: reports are ordered by the revision that recorded them. */
export function reportsNewestFirst(task: Pick<TaskView, 'reports'>): TaskReport[] {
  return task.reports
    .map((report, index) => ({ report, index }))
    .sort((a, b) => b.report.revision - a.report.revision || b.index - a.index)
    .map((r) => r.report)
}

export const latestReport = (task: Pick<TaskView, 'reports'>): TaskReport | undefined =>
  reportsNewestFirst(task)[0]

/** What the task still waits for: requirements that are not completed or accepted. */
export const unmetRequirements = (task: Pick<TaskView, 'requires'>) =>
  task.requires.filter((r) => !r.satisfied)

/** The trailer an agent puts in its commit message so the git verifier can find the work. */
export const taskTrailer = (taskId: string): string => `Kalyth-Task: ${taskId}`

// ---------- what a person may do ----------

/**
 * Statuses a person never sets from the UI, although the kernel would accept the transition:
 * `running` carries an agent's lease and only the coordinator grants one; `review` means Kalyth's
 * git verifier found the reported work, so a person moving a task there would skip that check;
 * `unknown_outcome` is how the coordinator marks a lease that ran out.
 */
export const NOT_FOR_PEOPLE: ReadonlySet<TaskStatus> = new Set([
  'running',
  'review',
  'unknown_outcome',
])

export type ActionVariant = 'primary' | 'secondary' | 'danger'

export interface TaskAction {
  to: TaskStatus
  label: string
  variant: ActionVariant
  /** What the action means, shown beside the rationale it asks for. */
  note: string
  /** Completed and cancelled are final. */
  final: boolean
}

const ENDS_LEASE = 'The agent’s lease ends, so it can no longer renew it or report under it.'

function describeAction(from: TaskStatus, to: TaskStatus): Omit<TaskAction, 'to' | 'final'> {
  switch (to) {
    case 'ready':
      if (from === 'review') {
        return {
          label: 'Send back',
          variant: 'secondary',
          note: 'The work is not accepted yet. The task is open for agents to claim again.',
        }
      }
      if (from === 'blocked') {
        return {
          label: 'Unblock',
          variant: 'primary',
          note: 'Agents can claim it again, once everything it requires is completed or accepted.',
        }
      }
      return {
        label: 'Mark ready',
        variant: 'primary',
        note:
          from === 'running'
            ? `Takes the task back for another attempt. ${ENDS_LEASE}`
            : from === 'unknown_outcome'
              ? 'Opens it for another attempt and ends the last holder’s lease. Check the task repository for a commit with this task’s trailer first: if the work landed, a report settles it.'
              : from === 'failed'
                ? 'Opens it for another attempt.'
                : 'Agents can then claim it, once everything it requires is completed or accepted.',
      }
    case 'completed':
      return {
        label: 'Complete',
        variant: 'primary',
        note: 'The repository shows the work; you confirm it. Completing is final.',
      }
    case 'blocked':
      return {
        label: 'Block',
        variant: 'secondary',
        note:
          from === 'running'
            ? `Stops the work until a person unblocks it. ${ENDS_LEASE}`
            : 'No agent can claim it until a person unblocks it.',
      }
    case 'cancelled':
      return {
        label: 'Cancel task',
        variant: 'danger',
        note: 'Cancelling is final: a cancelled task cannot be reopened.',
      }
    case 'failed':
      return {
        label: 'Fail',
        variant: 'danger',
        note:
          from === 'running'
            ? `Records that this attempt failed. ${ENDS_LEASE} It can then be marked ready again, or cancelled.`
            : 'Records that the attempt failed. It can then be marked ready again, or cancelled.',
      }
    default:
      return { label: humanize(to), variant: 'secondary', note: '' }
  }
}

const VARIANT_ORDER: Record<ActionVariant, number> = { primary: 0, secondary: 1, danger: 2 }

/**
 * What a person may do from a status: the kernel's transitions, without those only the
 * coordinator sets. Primary actions first, destructive ones last.
 */
export function taskActions(status: TaskStatus): TaskAction[] {
  return (TASK_TRANSITIONS[status] ?? [])
    .filter((to) => !NOT_FOR_PEOPLE.has(to))
    .map((to) => ({
      to,
      final: to === 'completed' || to === 'cancelled',
      ...describeAction(status, to),
    }))
    .sort((a, b) => VARIANT_ORDER[a.variant] - VARIANT_ORDER[b.variant])
}

/** The one operation a status change proposes. The kernel clears the lease where it must. */
export function statusChangeOps(
  taskId: string,
  status: TaskStatus,
  rationale: string,
): OperationInput[] {
  return [{ op: 'setTaskStatus', id: taskId, status, rationale }]
}

// ---------- the task form ----------

export const TASK_TITLE_MAX = 300
export const TASK_DESCRIPTION_MAX = 8_000
const SHA = /^[0-9a-f]{40}$/
/** The proposal-local reference that names the new task in its own relations. */
export const TASK_REF = '$task'

export interface TaskDraft {
  /** The accepted decision the task comes from. */
  decisionId: string | null
  /** What the task implements: that decision, or one of its accepted alternatives. */
  implementsId: string | null
  title: string
  /** The title last filled in from a decision; the next choice replaces it unless it was edited. */
  prefilledTitle: string
  description: string
  criteria: string[]
  /** A context package id, or '' for none. */
  contextPackageId: string
  baseCommit: string
  /** Tasks that must be completed first. */
  requires: string[]
}

export const EMPTY_TASK_DRAFT: TaskDraft = {
  decisionId: null,
  implementsId: null,
  title: '',
  prefilledTitle: '',
  description: '',
  criteria: [],
  contextPackageId: '',
  baseCommit: '',
  requires: [],
}

export type TaskDraftAction =
  | { type: 'chooseDecision'; decision: Pick<DecisionSummary, 'id' | 'title'> }
  | { type: 'implements'; id: string }
  | { type: 'title'; title: string }
  | { type: 'description'; description: string }
  | CriterionAction
  | { type: 'contextPackage'; id: string }
  | { type: 'baseCommit'; value: string }
  | { type: 'toggleRequires'; id: string }
  | { type: 'reset'; draft?: TaskDraft }

export function taskDraftReducer(draft: TaskDraft, action: TaskDraftAction): TaskDraft {
  if (isCriterionAction(action)) {
    return { ...draft, criteria: criteriaReducer(draft.criteria, action) }
  }
  switch (action.type) {
    case 'chooseDecision': {
      const untouched = draft.title.trim() === '' || draft.title === draft.prefilledTitle
      const title = action.decision.title.slice(0, TASK_TITLE_MAX)
      return {
        ...draft,
        decisionId: action.decision.id,
        implementsId: action.decision.id,
        ...(untouched ? { title, prefilledTitle: title } : {}),
      }
    }
    case 'implements':
      return { ...draft, implementsId: action.id }
    case 'title':
      return { ...draft, title: action.title }
    case 'description':
      return { ...draft, description: action.description }
    case 'contextPackage':
      return { ...draft, contextPackageId: action.id }
    case 'baseCommit':
      return { ...draft, baseCommit: action.value }
    case 'toggleRequires':
      return {
        ...draft,
        requires: draft.requires.includes(action.id)
          ? draft.requires.filter((id) => id !== action.id)
          : [...draft.requires, action.id],
      }
    case 'reset':
      return action.draft ?? EMPTY_TASK_DRAFT
  }
}

/** A draft that starts from an accepted decision, as when the form is opened from one. */
export const draftFromDecision = (decision: Pick<DecisionSummary, 'id' | 'title'>): TaskDraft =>
  taskDraftReducer(EMPTY_TASK_DRAFT, { type: 'chooseDecision', decision })

const normalizedSha = (value: string) => value.trim().toLowerCase()

/** Why the draft cannot be proposed yet, as sentences; empty when it can. */
export function taskDraftProblems(draft: TaskDraft): string[] {
  const problems: string[] = []
  if (!draft.implementsId) problems.push('Choose the accepted decision this task implements.')
  const title = draft.title.trim()
  if (!title) problems.push('Give the task a title.')
  if (title.length > TASK_TITLE_MAX) {
    problems.push(`Keep the title to ${TASK_TITLE_MAX} characters.`)
  }
  if (draft.description.trim().length > TASK_DESCRIPTION_MAX) {
    problems.push(
      `Keep the description to ${TASK_DESCRIPTION_MAX.toLocaleString('en')} characters.`,
    )
  }
  const sha = normalizedSha(draft.baseCommit)
  if (sha && !SHA.test(sha)) {
    problems.push('Give the base commit as a full 40-character sha, or leave it empty.')
  }
  return problems
}

/**
 * The operations that create a task: the stated core.Task (it starts as proposed), the
 * `implements` relation to the decision or alternative, and a `requires` relation to each task
 * that must come first. The new task is named by a local reference until the proposal is stored.
 */
export function createTaskOps(draft: TaskDraft): OperationInput[] {
  if (!draft.implementsId) throw new Error('a task must implement a decision or alternative')
  const attributes: Record<string, JsonValue> = {
    title: draft.title.trim(),
    acceptanceCriteria: filledCriteria(draft.criteria),
  }
  const description = draft.description.trim()
  if (description) attributes.description = description
  if (draft.contextPackageId) attributes.contextPackageId = draft.contextPackageId
  const sha = normalizedSha(draft.baseCommit)
  if (sha) attributes.baseCommit = sha
  const relation = (type: 'implements' | 'requires', to: string): OperationInput => ({
    op: 'createRelation',
    type,
    from: TASK_REF,
    to,
    stance: 'toBe',
    claim: { basis: 'stated' },
  })
  return [
    {
      op: 'createObject',
      ref: TASK_REF,
      type: 'core.Task',
      stance: 'toBe',
      attributes,
      claim: { basis: 'stated' },
    },
    relation('implements', draft.implementsId),
    ...[...new Set(draft.requires)].map((id) => relation('requires', id)),
  ]
}

/** The rationale a task's creation is proposed with. */
export const createTaskRationale = (draft: Pick<TaskDraft, 'title'>): string =>
  `Plan the task “${draft.title.trim()}”`

/** Tasks a new task may require: any that is not cancelled, since a cancelled one never completes. */
export const requirableTasks = (tasks: readonly TaskView[]): TaskView[] =>
  tasks.filter((t) => t.status !== 'cancelled').sort(byRecent)
