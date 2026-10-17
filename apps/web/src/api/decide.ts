import type { CommitSuccess } from '@kalyth/contracts'
import { acceptAlternativeOps } from '../model/navigator.ts'
import { type Api, ApiError, isApiError } from './client.ts'

export interface AcceptAlternativeInput {
  decisionId: string
  chosenId: string
  /** Every alternative of the decision, the chosen one included. */
  alternativeIds: readonly string[]
  rationale: string
  /** The project head the person is deciding on. */
  baseRevision: number
}

/**
 * The proposal was stored; it either committed, or the commit was refused (stale, conflicting)
 * and the proposal stays pending for review in the Proposals view.
 */
export type AcceptAlternativeOutcome =
  | { proposalId: string; committed: CommitSuccess }
  | { proposalId: string; refused: ApiError }

/**
 * A person accepts an alternative: propose the setDecisionStatus operations against the head,
 * then commit that proposal. The HTTP API acts for the owner with human origin, so the commit is
 * allowed; a stale or conflicting head refuses it like any other commit.
 */
export async function acceptAlternative(
  api: Pick<Api, 'propose' | 'commit'>,
  projectId: string,
  input: AcceptAlternativeInput,
): Promise<AcceptAlternativeOutcome> {
  const proposed = await api.propose(projectId, {
    baseRevision: input.baseRevision,
    rationale: input.rationale,
    ops: acceptAlternativeOps(input),
  })
  if (proposed.status !== 'pending') {
    throw new ApiError(422, {
      code: proposed.status === 'invalid' ? 'invalid' : proposed.status,
      message: `The decision was not proposed: the proposal is ${proposed.status}.`,
      issues: proposed.issues,
    })
  }
  try {
    return { proposalId: proposed.proposalId, committed: await api.commit(proposed.proposalId) }
  } catch (e) {
    if (isApiError(e)) return { proposalId: proposed.proposalId, refused: e }
    throw e
  }
}
