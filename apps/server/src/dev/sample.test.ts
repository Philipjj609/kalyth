import { ensureLocalOwner, KalythServices, SqliteStore } from '@kalyth/core'
import { describe, expect, it } from 'vitest'
import { seedSampleProject } from './sample.ts'

// Keeps the dev seed valid while the kernel evolves: it must go through the services cleanly.
describe('dev sample seed', () => {
  it('creates the sample project with history and proposals in every review state', () => {
    const services = new KalythServices({ store: new SqliteStore(':memory:') })
    const { project, created } = seedSampleProject(services)
    expect(created).toBe(true)
    expect(project.headRevision).toBe(5)

    const caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
    const overview = services.getProjectOverview(caller, { projectId: project.id })
    if (!overview.ok) throw new Error(overview.error.message)
    expect(overview.value.pendingProposals).toBe(1)
    expect(overview.value.objectCounts['software.Module']).toBe(22)
    expect(overview.value.objectCounts['software.Container']).toBe(3)
    expect(overview.value.relationCounts.dependsOn).toBeGreaterThan(30)

    const proposals = services.listProposals(caller, { projectId: project.id })
    if (!proposals.ok) throw new Error(proposals.error.message)
    const statuses = proposals.value.proposals.map((p) => p.status).sort()
    expect(statuses).toEqual([
      'committed',
      'committed',
      'committed',
      'committed',
      'committed',
      'invalid',
      'pending',
      'rejected',
      'stale',
    ])

    const history = services.getHistory(caller, { projectId: project.id })
    if (!history.ok) throw new Error(history.error.message)
    expect(history.value.changeSets.map((c) => c.origin)).toEqual([
      'human',
      'human',
      'human',
      'human',
      'human',
    ])
    expect(history.value.changeSets[0]?.rebasedFrom).toBe(3)

    // config.py cites two alternative groups; one excerpt is redacted by the secret screen.
    const modules = services.queryObjects(caller, {
      projectId: project.id,
      types: ['software.Module'],
    })
    if (!modules.ok) throw new Error(modules.error.message)
    const config = modules.value.objects.find(
      (o) => o.attributes.path === 'backend/app/core/config.py',
    )
    expect(config?.claim.supports).toHaveLength(2)
    const evidence = services.getEvidence(caller, {
      projectId: project.id,
      ids: config?.claim.supports.flatMap((g) => g.allOf) ?? [],
    })
    if (!evidence.ok) throw new Error(evidence.error.message)
    expect(evidence.value.evidence.filter((e) => e.excerptRedacted)).toHaveLength(1)

    expect(seedSampleProject(services).created).toBe(false)
  })
})
