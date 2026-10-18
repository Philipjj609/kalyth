import type { CommitSuccess } from '@kalyth/contracts'
import { acceptAlternativeOps } from '../model/navigator.ts'
import { type Api, ApiError, isApiError, type ProposeBody } from './client.ts'

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
 * The proposal was stored; it either committed, or the commit was refused (stale, conflicting,
 * unauthorized) and the proposal stays pending for review in the Proposals view.
 */
export type ProposeCommitOutcome =
  | { proposalId: string; committed: CommitSuccess }
  | { proposalId: string; refused: ApiError }

export type AcceptAlternativeOutcome = ProposeCommitOutcome

/**
 * A person's change, applied at once: propose it against the head they saw, then commit that
 * proposal. The HTTP API acts for the owner with human origin, so a commit that needs a person
 * is allowed; a stale or conflicting head refuses it like any other commit. A proposal that is
 * not pending (invalid) is thrown with its issues and never committed.
 */
export async function proposeAndCommit(
  api: Pick<Api, 'propose' | 'commit'>,
  projectId: string,
  body: ProposeBody,
  subject = 'The change',
): Promise<ProposeCommitOutcome> {
  const proposed = await api.propose(projectId, body)
  if (proposed.status !== 'pending') {
    throw new ApiError(422, {
      code: proposed.status === 'invalid' ? 'invalid' : proposed.status,
      message: `${subject} was not proposed: the proposal is ${proposed.status}.`,
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

/**
 * A person accepts an alternative: propose the setDecisionStatus operations against the head,
 * then commit that proposal.
 */
export function acceptAlternative(
  api: Pick<Api, 'propose' | 'commit'>,
  projectId: string,
  input: AcceptAlternativeInput,
): Promise<AcceptAlternativeOutcome> {
  return proposeAndCommit(
    api,
    projectId,
    {
      baseRevision: input.baseRevision,
      rationale: input.rationale,
      ops: acceptAlternativeOps(input),
    },
    'The decision',
  )
}
