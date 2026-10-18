import type { TaskView } from '@kalyth/contracts'
import type { TaskReport } from '../model/tasks.ts'
import { AGENT, PACKAGE_ID } from './handoff.ts'
import { ALT_A, DECISION, id, PROJECT } from './navigator.ts'

/** Task fixtures (ADR 0013): tasks in every status, a lease, reports and their verification. */

export const TASK = id('obj', 701)
export const TASK_B = id('obj', 702)
export const TASK_C = id('obj', 703)
export const REPORT = id('obj', 711)
export const VERIFICATION = id('obj', 712)
export const COMMIT = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'
export const BASE_COMMIT = 'ffeeddccbbaa99887766554433221100ffeeddcc'
export const LEASE = {
  id: `lease_${'a1'.repeat(16)}`,
  holder: AGENT,
  expiresAt: '2026-10-17T10:30:00.000Z',
}

export function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK,
    projectId: PROJECT,
    title: 'Add tenant_id to Item',
    description: 'Scope every read by tenant.\nKeep the migration reversible.',
    acceptanceCriteria: ['Every query filters by tenant', 'Existing tests pass'],
    status: 'proposed',
    statusRationale: null,
    lease: null,
    leaseExpired: false,
    contextPackageId: null,
    baseCommit: null,
    implements: [{ id: DECISION, type: 'core.Decision', label: 'Tenancy model' }],
    requires: [],
    reports: [],
    revision: 9,
    createdAt: '2026-10-17T08:00:00.000Z',
    updatedAt: '2026-10-17T09:40:00.000Z',
    ...overrides,
  }
}

export function report(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    id: REPORT,
    outcome: 'succeeded',
    summary: 'Added tenant_id to Item and filtered the base query.',
    commit: COMMIT,
    filesChanged: ['app/models.py', 'app/crud.py'],
    tests: [{ command: 'pytest -q', passed: 41, failed: 0 }],
    revision: 12,
    reportedAt: '2026-10-17T09:30:00.000Z',
    verification: {
      id: VERIFICATION,
      outcome: 'pass',
      summary: 'Commit found with the task trailer; the files changed match the report.',
    },
    ...overrides,
  }
}

/** A running task held by the agent token's principal, with a full set of links. */
export function runningTask(overrides: Partial<TaskView> = {}): TaskView {
  return taskView({
    id: TASK_B,
    title: 'Filter the base query',
    status: 'running',
    statusRationale: 'Claimed by the agent.',
    lease: LEASE,
    implements: [{ id: ALT_A, type: 'core.Alternative', label: 'Tenant column' }],
    requires: [
      { id: TASK, type: 'core.Task', label: 'Add tenant_id to Item', satisfied: false },
      { id: DECISION, type: 'core.Decision', label: 'Tenancy model', satisfied: true },
    ],
    contextPackageId: PACKAGE_ID,
    baseCommit: BASE_COMMIT,
    revision: 11,
    ...overrides,
  })
}
