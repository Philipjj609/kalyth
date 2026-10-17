import { describe, expect, it } from 'vitest'
import { acceptAlternativeOps, OTHER_ALTERNATIVE_REJECTED } from '../model/navigator.ts'
import { ALT_A, ALT_B, DECISION, id, PROJECT } from '../test/navigator.ts'
import { ApiError, createApi, type FetchLike } from './client.ts'
import { acceptAlternative } from './decide.ts'
import type { Situation } from './situation.ts'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function scripted(answers: Response[]) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const next = answers.shift()
    if (!next) throw new Error(`unexpected request ${url}`)
    return next
  }
  return { calls, api: createApi(() => 't', fetchImpl) }
}

const ALT_C = id('obj', 205)
const PROPOSAL = id('prp', 77)
const input = {
  decisionId: DECISION,
  chosenId: ALT_A,
  alternativeIds: [ALT_B, ALT_A, ALT_C],
  rationale: 'Cheapest to run for the first customers.',
  baseRevision: 12,
}
const committed = {
  status: 'committed',
  projectId: PROJECT,
  revision: 13,
  changeSetId: id('chg', 1),
  eventId: id('evt', 1),
  rebasedFrom: null,
}

describe('accepting an alternative', () => {
  it('accepts the decision and the chosen alternative, and rejects the others', () => {
    expect(acceptAlternativeOps(input)).toEqual([
      { op: 'setDecisionStatus', id: DECISION, status: 'accepted', rationale: input.rationale },
      { op: 'setDecisionStatus', id: ALT_A, status: 'accepted', rationale: input.rationale },
      {
        op: 'setDecisionStatus',
        id: ALT_B,
        status: 'rejected',
        rationale: 'Another alternative was accepted.',
      },
      {
        op: 'setDecisionStatus',
        id: ALT_C,
        status: 'rejected',
        rationale: OTHER_ALTERNATIVE_REJECTED,
      },
    ])
  })

  it('proposes against the head, then commits that proposal', async () => {
    const { calls, api } = scripted([
      json(201, { proposalId: PROPOSAL, status: 'pending', issues: [] }),
      json(200, committed),
    ])
    await expect(acceptAlternative(api, PROJECT, input)).resolves.toEqual({
      proposalId: PROPOSAL,
      committed,
    })
    expect(calls).toEqual([
      {
        url: `/api/v1/projects/${PROJECT}/proposals`,
        method: 'POST',
        body: {
          baseRevision: 12,
          rationale: input.rationale,
          ops: acceptAlternativeOps(input),
        },
      },
      { url: `/api/v1/proposals/${PROPOSAL}/commit`, method: 'POST', body: undefined },
    ])
  })

  it('keeps a refused commit (stale) as an outcome, with the pending proposal', async () => {
    const stale = {
      code: 'stale',
      message: 'state this proposal relies on changed since revision 12',
      issues: [{ code: 'stale.changed', message: DECISION }],
      changedRefs: [DECISION],
      currentRevision: 14,
    }
    const { api } = scripted([
      json(201, { proposalId: PROPOSAL, status: 'pending', issues: [] }),
      json(409, { error: stale }),
    ])
    const outcome = await acceptAlternative(api, PROJECT, input)
    expect(outcome.proposalId).toBe(PROPOSAL)
    expect('refused' in outcome && outcome.refused.status).toBe(409)
    expect('refused' in outcome && outcome.refused.body).toEqual(stale)
  })

  it('reports an invalid proposal (422 with the proposal body) with its issues, and never commits', async () => {
    const issues = [
      { code: 'decision.status', message: 'only open decisions can be accepted', op: 0 },
    ]
    const { calls, api } = scripted([
      json(422, { proposalId: PROPOSAL, status: 'invalid', issues }),
    ])
    const error = await acceptAlternative(api, PROJECT, input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).body).toMatchObject({ code: 'invalid', issues })
    expect(calls).toHaveLength(1)
  })

  it('still throws the error envelope when a 422 carries one', async () => {
    const { api } = scripted([
      json(422, { error: { code: 'invalid', message: 'baseRevision: expected int', issues: [] } }),
    ])
    const error = (await acceptAlternative(api, PROJECT, input).catch(
      (e: unknown) => e,
    )) as ApiError
    expect(error.status).toBe(422)
    expect(error.body.message).toBe('baseRevision: expected int')
  })
})

describe('situation', () => {
  const situation: Situation = {
    projectId: PROJECT,
    revision: 13,
    openDecisions: [],
    openQuestions: [],
    pendingProposals: [],
    freshness: { current: 10 },
    staleClaims: [],
  }

  it('reads the situation, and maps a missing route to null', async () => {
    const { calls, api } = scripted([json(200, situation)])
    await expect(api.situation(PROJECT)).resolves.toEqual(situation)
    expect(calls[0]).toMatchObject({ url: `/api/v1/projects/${PROJECT}/situation`, method: 'GET' })
    const missing = scripted([
      json(404, { error: { code: 'not_found', message: 'x', issues: [] } }),
    ])
    await expect(missing.api.situation(PROJECT)).resolves.toBeNull()
  })
})
