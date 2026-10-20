import type { Caller, KernelError, Principal, ResolvedOperation, Scope } from '@kalyth/contracts'
import type { SqliteStore } from '../store/sqlite-store.ts'
import type { Clock } from '../util.ts'

/**
 * Deterministic authorisation, enforced in the service layer independently of any model output
 * (ADR 0006). Model or agent text cannot raise its own authority.
 */
export class Authorizer {
  readonly #store: SqliteStore
  readonly #clock: Clock

  constructor(store: SqliteStore, clock: Clock) {
    this.#store = store
    this.#clock = clock
  }

  scopes(principalId: string, projectId: string | null): Set<Scope> {
    const now = this.#clock()
    const scopes = new Set<Scope>()
    for (const grant of this.#store.grantsFor(principalId)) {
      if (grant.expiresAt !== null && grant.expiresAt <= now) continue
      if (grant.projectId !== null && grant.projectId !== projectId) continue
      for (const scope of grant.scopes) scopes.add(scope)
    }
    return scopes
  }

  require(
    principal: Principal,
    projectId: string | null,
    needed: readonly Scope[],
  ): KernelError | undefined {
    const held = this.scopes(principal.id, projectId)
    const missing = needed.filter((s) => !held.has(s))
    if (missing.length === 0) return undefined
    return {
      code: 'unauthorized',
      message: `missing scope ${missing.join(', ')}`,
      issues: [],
      requiredScopes: missing,
    }
  }

  /**
   * Commit policy, version 1 (decision D4):
   * - any decision status change needs a human principal, acting directly (origin "human"),
   *   holding decision.decide;
   * - a task becoming completed or cancelled needs a person acting directly (ADR 0013);
   * - recording a task's git finding needs the task coordinator (a tool with task.coordinate);
   * - otherwise proposal.commit allows any operation;
   * - ingest.observed allows only evidence plus records whose claim basis is "observed";
   * - task.coordinate allows only task lifecycle records (ADR 0013).
   */
  authorizeCommit(
    principal: Principal,
    caller: Caller,
    projectId: string,
    ops: readonly ResolvedOperation[],
  ): KernelError | undefined {
    const held = this.scopes(principal.id, projectId)
    if (ops.some((op) => op.op === 'setDecisionStatus')) {
      const direct = principal.kind === 'human' && caller.origin === 'human'
      if (!direct || !held.has('decision.decide')) {
        return {
          code: 'unauthorized',
          message: 'decision status changes require a person acting directly with decision.decide',
          issues: [],
          requiredScopes: ['decision.decide'],
        }
      }
    }
    const finishesTask = ops.some(
      (op) => op.op === 'setTaskStatus' && (op.status === 'completed' || op.status === 'cancelled'),
    )
    if (finishesTask && !(principal.kind === 'human' && caller.origin === 'human')) {
      return {
        code: 'unauthorized',
        message: 'completing or cancelling a task requires a person acting directly',
        issues: [],
        requiredScopes: ['proposal.commit'],
      }
    }
    // A finding says what git showed; only the coordinator, which searched git, records one.
    const recordsFinding = ops.some((op) => op.op === 'setTaskStatus' && op.finding !== undefined)
    if (recordsFinding && !(principal.kind === 'tool' && held.has('task.coordinate'))) {
      return {
        code: 'unauthorized',
        message: 'only the task coordinator records what git found for a task',
        issues: [],
        requiredScopes: ['task.coordinate'],
      }
    }
    if (held.has('proposal.commit')) return undefined
    if (held.has('ingest.observed') && ops.every(isObservedIngest)) return undefined
    if (held.has('task.coordinate') && ops.every(isTaskLifecycle)) return undefined
    return {
      code: 'unauthorized',
      message: 'committing this proposal requires proposal.commit',
      issues: [],
      requiredScopes: ['proposal.commit'],
    }
  }
}

function isObservedIngest(op: ResolvedOperation): boolean {
  switch (op.op) {
    case 'recordEvidence':
      return true
    case 'createObject':
    case 'createRelation':
      return op.claim.basis === 'observed'
    case 'updateObject':
    case 'updateRelation':
      return op.claim?.basis === 'observed'
    default:
      return false
  }
}

/** What the task coordinator may commit (ADR 0013): never completion, cancellation or the model. */
const COORDINATOR_STATUSES = new Set(['running', 'review', 'failed', 'unknown_outcome', 'ready'])

function isTaskLifecycle(op: ResolvedOperation): boolean {
  switch (op.op) {
    case 'setTaskStatus':
      return COORDINATOR_STATUSES.has(op.status)
    case 'recordEvidence':
      return true
    case 'createObject':
      return op.type === 'core.ExecutionReport' || op.type === 'core.Verification'
    case 'createRelation':
      return op.type === 'reports' || op.type === 'verifies'
    default:
      return false
  }
}
