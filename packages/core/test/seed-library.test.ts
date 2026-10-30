import { readFileSync } from 'node:fs'
import type { OperationInput } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, SqliteStore, stateSha256 } from '../src/index.ts'
import { setup, unwrap } from './helpers.ts'

interface Seed {
  name: string
  description: string
  rationale: string
  ops: OperationInput[]
}

const seed: Seed = JSON.parse(
  readFileSync(
    new URL('../../../deploy/knowledge/real-time-networking.json', import.meta.url),
    'utf8',
  ),
)

/** The seed as it is meant to arrive: proposed by an agent, committed by the curator. */
function load() {
  const ctx = setup()
  const lib = unwrap(
    ctx.services.createProject(ctx.owner, {
      name: seed.name,
      description: seed.description,
      kind: 'library',
    }),
  )
  const proposed = unwrap(
    ctx.services.proposeChange(ctx.agent, {
      projectId: lib.id,
      baseRevision: 0,
      ops: seed.ops,
      rationale: seed.rationale,
    }),
  )
  return { ctx, lib, proposed }
}

describe('seed library: real-time networking (K1)', () => {
  it('is a valid agent proposal that a curator can commit', () => {
    const { ctx, lib, proposed } = load()
    expect(proposed.issues).toEqual([])
    expect(proposed.status).toBe('pending')
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId }))
    const overview = unwrap(ctx.services.getProjectOverview(ctx.owner, { projectId: lib.id }))
    expect(overview.evidenceCount).toBe(16)
    expect(overview.objectCounts).toEqual({
      'knowledge.Concept': 10,
      'knowledge.Principle': 1,
      'knowledge.Pattern': 7,
      'knowledge.Condition': 2,
      'core.Question': 2,
    })
    expect(Object.values(overview.relationCounts).reduce((a, b) => a + b, 0)).toBe(24)
  })

  it('claims nothing it has not earned: proposed, unreviewed, unverified, paraphrased, licence unknown', () => {
    const { ctx, lib, proposed } = load()
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId }))
    const { items } = unwrap(ctx.services.getKnowledgeStatus(ctx.owner, { projectId: lib.id }))
    expect(items).toHaveLength(20)
    for (const item of items) {
      expect(item.maturity).toBe('proposed')
      expect(item.dispute.status).toBe('none')
      expect(item.supported).toBe(true)
      expect(item.establishedGaps.length).toBeGreaterThan(0)
      for (const group of item.groups) {
        expect(group.review).toBe('unreviewed')
        for (const source of group.sources) {
          expect(source).toMatchObject({
            kind: 'external',
            quote: 'none',
            quoteMatch: 'notApplicable',
            locatorVerification: 'unverified',
          })
        }
      }
    }
    const { relations } = unwrap(ctx.services.queryRelations(ctx.owner, { projectId: lib.id }))
    const ids = [
      ...new Set([
        ...items.flatMap((i) => i.groups.flatMap((g) => g.allOf)),
        ...relations.flatMap((r) => r.claim.supports.flatMap((g) => g.allOf)),
      ]),
    ]
    expect(ids).toHaveLength(16)
    const evidence = unwrap(
      ctx.services.getEvidence(ctx.owner, { projectId: lib.id, ids }),
    ).evidence
    for (const e of evidence) {
      expect(e.source.kind).toBe('external')
      if (e.source.kind !== 'external') continue
      expect(e.source.uri).toMatch(/^https:\/\//)
      expect(e.source.meta).toMatchObject({ licence: 'unknown', quotePolicy: 'none' })
      expect(e.source.meta?.locator).toMatch(/^section "/)
      expect(e.excerpt).toBeNull()
    }
  })

  it('round-trips through export and import', () => {
    const { ctx, lib, proposed } = load()
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId }))
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: lib.id }))
    const target = new SqliteStore(':memory:')
    unwrap(importProjectExport(target, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(target, lib.id)).toBe(stateSha256(ctx.store, lib.id))
  })
})
