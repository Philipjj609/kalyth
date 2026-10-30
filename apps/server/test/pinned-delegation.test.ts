import { afterEach, describe, expect, it } from 'vitest'
import { buildKnowledgeExample } from '../src/dev/knowledge-example.ts'
import { harness } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
afterEach(async () => h?.close())

/** The example, and an agent token for its project, with or without the pinned-knowledge delegation. */
async function withToken(pinnedKnowledge: boolean) {
  h = await harness()
  const owner = { principalId: h.owner.id, origin: 'human' as const }
  const x = buildKnowledgeExample(h.services, owner, { principalId: h.agent.id, origin: 'agent' })
  const issued = h.services.issueAgentToken(owner, {
    projectId: x.project.id,
    label: 'explorer',
    pinnedKnowledge,
  })
  if (!issued.ok) throw new Error(issued.error.message)
  const found = h.services.authenticateAgentToken(issued.value.token)
  if (!found) throw new Error('token does not authenticate')
  const caller = { principalId: found.principalId, origin: 'agent' as const }
  return { x, owner, issued: issued.value, caller }
}

describe('pinned-snapshot read delegation (ADR 0032)', () => {
  it('is off by default: a project token reads the project, not its pinned snapshots or library', async () => {
    const { x, caller, issued } = await withToken(false)
    expect(issued.summary.scopes).not.toContain('knowledge.pinned.read')
    const pinned = h.services.getPinnedKnowledge(caller, { projectId: x.project.id })
    expect(!pinned.ok && pinned.error).toMatchObject({
      code: 'unauthorized',
      requiredScopes: ['knowledge.pinned.read'],
    })
    expect(h.services.listLibraryUses(caller, { projectId: x.project.id }).ok).toBe(true)
  })

  it('when delegated, shows exactly the versions the project pins, from its own copies', async () => {
    const { x, caller, issued } = await withToken(true)
    expect(issued.summary.scopes).toContain('knowledge.pinned.read')
    const r = h.services.getPinnedKnowledge(caller, { projectId: x.project.id })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.pins).toHaveLength(6)
    const lockstep = r.value.pins.find((p) => p.evidence === x.P.$lockstep)
    expect(lockstep).toMatchObject({
      state: 'embedded',
      revision: 1,
      content: { type: 'knowledge.Pattern', maturity: 'proposed' },
    })
    expect(lockstep?.cites[0]?.source).toMatchObject({
      kind: 'external',
      meta: { licence: 'unknown' },
    })
  })

  it('does not open the library, later revisions, other projects or curation', async () => {
    const { x, caller } = await withToken(true)
    // The library itself stays closed: no search, no item reads, no assessment of its conditions.
    const search = h.services.searchKnowledge(caller, { projectId: x.project.id, text: 'lockstep' })
    expect(search.ok && search.value.hits).toEqual([])
    expect(h.services.getKnowledge(caller, { library: x.library.id, id: x.L.$lockstep }).ok).toBe(
      false,
    )
    expect(h.services.getKnowledge(caller, { library: x.library.id, id: x.L.$authServer }).ok).toBe(
      false,
    )
    // A later library revision is not visible through the snapshots.
    const owner = { principalId: h.owner.id, origin: 'human' as const }
    const p = h.services.proposeChange(owner, {
      projectId: x.library.id,
      baseRevision: h.services.store.getProject(x.library.id)?.headRevision ?? 0,
      ops: [{ op: 'updateObject', id: x.L.$lockstep, set: { aliases: ['lockstep v2'] } }],
      rationale: 'later revision',
    })
    if (!p.ok) throw new Error(p.error.message)
    h.services.commitProposal(owner, { proposalId: p.value.proposalId })
    const after = h.services.getPinnedKnowledge(caller, {
      projectId: x.project.id,
      evidence: x.P.$lockstep,
    })
    expect(after.ok && JSON.stringify(after.value.pins[0]?.content)).not.toMatch(/lockstep v2/)
    // Another project, and the library as a project, are refused.
    expect(h.services.getPinnedKnowledge(caller, { projectId: x.library.id }).ok).toBe(false)
    const other = h.services.createProject(owner, { name: 'Other' })
    if (!other.ok) throw new Error('no project')
    expect(h.services.getPinnedKnowledge(caller, { projectId: other.value.id }).ok).toBe(false)
    // Curation stays a person's: the delegation adds no write.
    const curate = h.services.proposeChange(caller, {
      projectId: x.library.id,
      baseRevision: 0,
      ops: [{ op: 'setMaturity', id: x.L.$lockstep, maturity: 'deprecated', reason: 'r' }],
      rationale: 'r',
    })
    expect(curate.ok).toBe(false)
  })

  it('never falls back to the library when a copy is missing', async () => {
    const { x, caller } = await withToken(true)
    const one = h.services.getPinnedKnowledge(caller, {
      projectId: x.project.id,
      evidence: x.P.$lockstep,
    })
    const sha = one.ok ? (one.value.pins[0]?.versionSha256 as string) : ''
    h.services.store.db
      .prepare('DELETE FROM content WHERE project_id = ? AND id = ?')
      .run(x.project.id, `cnt_${sha.slice(0, 32)}`)
    const r = h.services.getPinnedKnowledge(caller, {
      projectId: x.project.id,
      evidence: x.P.$lockstep,
    })
    expect(r.ok && r.value.pins[0]).toMatchObject({ state: 'notEmbedded' })
    expect(r.ok && r.value.pins[0]?.content).toBeUndefined()
  })

  it('ends with the token: revoked or expired, it no longer authenticates', async () => {
    const { owner, issued } = await withToken(true)
    expect(h.services.revokeAgentToken(owner, { tokenId: issued.summary.id }).ok).toBe(true)
    expect(h.services.authenticateAgentToken(issued.token)).toBeUndefined()
    // The grant behind it carries the token's expiry too.
    const grants = h.services.store.grantsFor(issued.summary.principalId)
    expect(grants.every((g) => g.expiresAt === issued.summary.expiresAt)).toBe(true)
  })
})
