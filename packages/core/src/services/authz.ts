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
   * - otherwise proposal.commit allows any operation;
   * - ingest.observed allows only evidence plus records whose claim basis is "observed".
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
    if (held.has('proposal.commit')) return undefined
    if (held.has('ingest.observed') && ops.every(isObservedIngest)) return undefined
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
      return op.claim?.basis === 'observed'
    default:
      return false
  }
}
