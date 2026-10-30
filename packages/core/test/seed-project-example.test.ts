import { readFileSync } from 'node:fs'
import type { OperationInput } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, stateSha256 } from '../src/index.ts'
import { setup, tool, unwrap } from './helpers.ts'

/**
 * K2 end to end: a game project uses the real-time networking seed library, pins the knowledge it
 * relies on, and keeps it when the library moves on or is absent. The seed stays proposed: using
 * knowledge never promotes it.
 */
const seed = JSON.parse(
  readFileSync(
    new URL('../../../deploy/knowledge/real-time-networking.json', import.meta.url),
    'utf8',
  ),
) as { name: string; description: string; rationale: string; ops: OperationInput[] }

describe('a project using the real-time networking seed library (K2 example)', () => {
  it('pins, tracks and exports the knowledge it relies on', () => {
    const ctx = setup()
    const { services, owner, agent } = ctx
    const head = (id: string) => ctx.store.getProject(id)?.headRevision ?? 0
    const commit = (projectId: string, ops: OperationInput[], rationale: string, by = owner) => {
      const p = unwrap(
        services.proposeChange(by, { projectId, baseRevision: head(projectId), ops, rationale }),
      )
      if (p.status !== 'pending') throw new Error(JSON.stringify(p.issues))
      return unwrap(services.commitProposal(owner, { proposalId: p.proposalId }))
    }

    // 1. The library: the seed, proposed by a research agent and committed by the curator.
    const lib = unwrap(
      services.createProject(owner, {
        name: seed.name,
        description: seed.description,
        kind: 'library',
      }),
    )
    const seeded = commit(lib.id, seed.ops, seed.rationale, agent)
    const lockstep = seeded.refs.$lockstep as string
    const deterministic = seeded.refs.$isDeterministic as string
    const appliesWhen = unwrap(
      services.queryRelations(owner, { projectId: lib.id, types: ['appliesWhen'], from: lockstep }),
    ).relations[0]?.id as string
    expect(appliesWhen).toBeDefined()

    // 2. The project: an RTS that uses the library at revision 1 and pins what its design relies
    //    on, the lockstep pattern and the condition it needs, by an agent's proposal.
    const game = unwrap(services.createProject(owner, { name: 'Skirmish RTS' }))
    const pin = (ref: string, target: 'object' | 'relation', id: string): OperationInput => ({
      op: 'recordEvidence',
      ref,
      evidence: {
        source: { kind: 'knowledge', library: lib.id, target, id, revision: 1 },
        collectedBy: tool,
      },
    })
    const used = commit(
      game.id,
      [
        {
          op: 'createObject',
          ref: '$use',
          type: 'core.LibraryUse',
          stance: 'toBe',
          attributes: {
            library: lib.id,
            label: 'kalyth/real-time-networking',
            revision: 1,
            role: 'primary',
          },
          claim: { basis: 'stated' },
        },
        pin('$pattern', 'object', lockstep),
        pin('$needs', 'relation', appliesWhen),
        {
          op: 'createObject',
          ref: '$decision',
          type: 'core.Decision',
          stance: 'toBe',
          attributes: {
            title: 'Multiplayer synchronisation',
            question: 'How do clients stay in sync in 8-player matches?',
          },
          claim: { basis: 'imported', supports: [{ allOf: ['$pattern', '$needs'] }] },
        },
      ],
      'Use the networking library for the multiplayer decision',
      agent,
    )
    const status = () => unwrap(services.getPinStatus(owner, { projectId: game.id })).pins
    expect(status().map((p) => p.freshness)).toEqual(['current', 'current'])

    // The pinned content says what the library said, maturity included: proposed, not established.
    const pinned = status().find((p) => p.id === lockstep)
    const content = (
      (pinned?.resolution ?? {}) as { content: { maturity: string; attributes: { name: string } } }
    ).content
    expect(content).toMatchObject({
      maturity: 'proposed',
      attributes: { name: 'Deterministic lockstep' },
    })
    const library = unwrap(services.getKnowledgeStatus(owner, { projectId: lib.id })).items
    expect(library.every((i) => i.maturity === 'proposed')).toBe(true)

    // 3. The curator reviews the lockstep pattern's support in the library (revision 2). Reviewing
    //    does not establish it: its sources are still unverified.
    const [group] =
      unwrap(services.queryObjects(owner, { projectId: lib.id, ids: [lockstep] })).objects[0]?.claim
        .supports ?? []
    commit(
      lib.id,
      [
        {
          op: 'reviewSupport',
          target: lockstep,
          group: { allOf: group?.allOf ?? [] },
          verdict: 'supports',
          note: 'The Age of Empires section describes this structure.',
        },
      ],
      'Review lockstep support',
    )
    expect(
      unwrap(services.getKnowledgeStatus(owner, { projectId: lib.id, ids: [lockstep] })).items[0]
        ?.maturity,
    ).toBe('proposed')

    // The project sees that the pattern changed since its pin, before it decides to move.
    const preview = unwrap(
      services.getPinStatus(owner, { projectId: game.id, preview: { [lib.id]: 2 } }),
    ).pins
    expect(preview.find((p) => p.id === lockstep)?.freshness).toBe('changed')
    expect(preview.find((p) => p.id === appliesWhen)?.freshness).toBe('unchanged')

    // 4. Moving the LibraryUse is a proposal; the old pins keep their content.
    commit(
      game.id,
      [{ op: 'updateObject', id: used.refs.$use as string, set: { revision: 2 } }],
      'Use revision 2',
    )
    expect(status().find((p) => p.id === lockstep)).toMatchObject({
      freshness: 'changed',
      resolution: { state: 'resolved', from: 'embedded' },
    })

    // 5. The project travels without the library: every pin resolves from its own export.
    const bundle = unwrap(services.exportProject(owner, { projectId: game.id }))
    const elsewhere = setup()
    unwrap(importProjectExport(elsewhere.store, JSON.parse(JSON.stringify(bundle))))
    expect(elsewhere.store.getProject(lib.id)).toBeUndefined()
    expect(stateSha256(elsewhere.store, game.id)).toBe(stateSha256(ctx.store, game.id))
    const away = unwrap(
      elsewhere.services.getPinStatus(elsewhere.owner, { projectId: game.id }),
    ).pins
    expect(away.map((p) => p.resolution.state)).toEqual(['resolved', 'resolved'])
    expect(away.find((p) => p.id === lockstep)?.freshness).toBe('libraryNotPresent')
  })
})
