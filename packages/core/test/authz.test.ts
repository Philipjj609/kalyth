import { describe, expect, it } from 'vitest'
import { ensurePrincipal } from '../src/index.ts'
import { commitAsOwner, errorOf, evidenceOp, observed, setup, stated, unwrap } from './helpers.ts'

describe('authorisation', () => {
  it('lets an agent propose but not commit; the proposal stays pending', () => {
    const ctx = setup()
    const proposed = unwrap(
      ctx.services.proposeChange(ctx.agent, {
        projectId: ctx.project.id,
        baseRevision: 0,
        rationale: 'agent idea',
        ops: [
          {
            op: 'createObject',
            type: 'core.Assertion',
            stance: 'asIs',
            attributes: { statement: 'x' },
            claim: stated,
          },
        ],
      }),
    )
    const error = errorOf(
      ctx.services.commitProposal(ctx.agent, { proposalId: proposed.proposalId }),
    )
    expect(error).toMatchObject({ code: 'unauthorized', requiredScopes: ['proposal.commit'] })
    const stored = ctx.store.getProposal(proposed.proposalId)
    expect(stored).toMatchObject({
      status: 'pending',
      proposedBy: ctx.agentPrincipal.id,
      origin: 'agent',
    })
    expect(
      unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId })).revision,
    ).toBe(1)
  })

  it('refuses unknown principals and missing scopes', () => {
    const ctx = setup()
    expect(
      errorOf(ctx.services.listProjects({ principalId: `pcp_${'0'.repeat(32)}`, origin: 'human' }))
        .code,
    ).toBe('unauthenticated')
    expect(errorOf(ctx.services.createProject(ctx.agent, { name: 'nope' }))).toMatchObject({
      code: 'unauthorized',
      requiredScopes: ['project.create'],
    })
    expect(
      errorOf(
        ctx.services.rejectProposal(ctx.agent, {
          proposalId: `prp_${'0'.repeat(32)}`,
          reason: 'x',
        }),
      ).code,
    ).toBe('not_found')
  })

  describe('decision acceptance is human-only and needs direct human origin (D4, instruction provenance)', () => {
    function withDecision() {
      const ctx = setup()
      commitAsOwner(ctx, [
        {
          op: 'createObject',
          ref: '$d',
          type: 'core.Decision',
          stance: 'toBe',
          attributes: { title: 'T', question: 'Q' },
          claim: stated,
        },
        {
          op: 'createObject',
          ref: '$a',
          type: 'core.Alternative',
          stance: 'toBe',
          attributes: { title: 'A', summary: 'S' },
          claim: stated,
        },
        {
          op: 'createRelation',
          type: 'alternativeOf',
          from: '$a',
          to: '$d',
          stance: 'toBe',
          claim: stated,
        },
      ])
      const alt = unwrap(
        ctx.services.queryObjects(ctx.owner, {
          projectId: ctx.project.id,
          types: ['core.Alternative'],
        }),
      ).objects[0]?.id as string
      const accept = unwrap(
        ctx.services.proposeChange(ctx.agent, {
          projectId: ctx.project.id,
          baseRevision: 1,
          rationale: 'model recommends',
          ops: [
            { op: 'setDecisionStatus', id: alt, status: 'accepted', rationale: 'model says so' },
          ],
        }),
      )
      return { ctx, accept, alt }
    }

    it('an agent holding proposal.commit still cannot accept a decision', () => {
      const { ctx, accept } = withDecision()
      ctx.services.grant(ctx.agentPrincipal.id, ['proposal.commit'], ctx.project.id)
      expect(
        errorOf(ctx.services.commitProposal(ctx.agent, { proposalId: accept.proposalId })),
      ).toMatchObject({
        code: 'unauthorized',
        requiredScopes: ['decision.decide'],
      })
    })

    it('a human acting on relayed or model text cannot accept a decision', () => {
      const { ctx, accept } = withDecision()
      for (const origin of ['model', 'relayed', 'agent'] as const) {
        expect(
          errorOf(
            ctx.services.commitProposal(
              { ...ctx.owner, origin },
              { proposalId: accept.proposalId },
            ),
          ).code,
        ).toBe('unauthorized')
      }
    })

    it('a human acting directly can accept, and the change set records who proposed it', () => {
      const { ctx, accept, alt } = withDecision()
      expect(
        unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: accept.proposalId })).revision,
      ).toBe(2)
      const version = unwrap(
        ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id, ids: [alt] }),
      ).objects[0]
      expect(version?.attributes).toMatchObject({
        status: 'accepted',
        statusRationale: 'model says so',
      })
      expect(
        unwrap(ctx.services.getHistory(ctx.owner, { projectId: ctx.project.id })).changeSets[0],
      ).toMatchObject({
        proposedBy: ctx.agentPrincipal.id,
        committedBy: ctx.ownerPrincipal.id,
        origin: 'human',
      })
    })

    it('human-only scopes cannot be granted to non-human principals', () => {
      const { ctx } = withDecision()
      expect(() => ctx.services.grant(ctx.agentPrincipal.id, ['decision.decide'])).toThrow(
        /human principal/,
      )
    })
  })

  it('ingest.observed commits observed facts only', () => {
    const ctx = setup()
    const analyzer = ensurePrincipal(ctx.services, 'analyzer', 'tool', 'Repository analyzer', [
      'project.read',
      'proposal.create',
      'ingest.observed',
    ])
    const caller = { principalId: analyzer.id, origin: 'tool' as const }
    const propose = (ops: unknown[]) =>
      unwrap(
        ctx.services.proposeChange(caller, {
          projectId: ctx.project.id,
          baseRevision: 0,
          rationale: 'scan',
          ops,
        }),
      ).proposalId
    const observedOnly = propose([
      evidenceOp('$e'),
      {
        op: 'createObject',
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: 'a.py' },
        claim: observed('$e'),
      },
    ])
    expect(unwrap(ctx.services.commitProposal(caller, { proposalId: observedOnly })).revision).toBe(
      1,
    )
    const inferred = propose([
      {
        op: 'createObject',
        type: 'software.Component',
        stance: 'toBe',
        attributes: { name: 'Auth' },
        claim: { basis: 'inferred', confidence: { level: 'low', rationale: 'guess' } },
      },
    ])
    expect(errorOf(ctx.services.commitProposal(caller, { proposalId: inferred }))).toMatchObject({
      code: 'unauthorized',
      requiredScopes: ['proposal.commit'],
    })
  })
})
