import type { ProjectExport } from '@kalyth/contracts'
import { canonicalJson } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, SqliteStore, stateSha256 } from '../src/index.ts'
import {
  commitAsOwner,
  errorOf,
  evidenceOp,
  observed,
  seedSystem,
  setup,
  stated,
  unwrap,
} from './helpers.ts'

/** A project with history: evidence, an update, a retirement and a redacted excerpt. */
function exported() {
  const ctx = setup()
  const { moduleId } = seedSystem(ctx)
  commitAsOwner(ctx, [{ op: 'updateObject', id: moduleId, set: { language: 'python3' } }])
  // Built at runtime so secret scanners do not flag this fixture (AWS's documented example key).
  const leaked = `AWS_KEY = "${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}"`
  commitAsOwner(ctx, [
    evidenceOp('$e', 'settings.py', leaked),
    {
      op: 'createObject',
      type: 'software.Module',
      stance: 'asIs',
      attributes: { path: 'settings.py', language: 'python' },
      claim: observed('$e'),
    },
    {
      op: 'createObject',
      type: 'core.Requirement',
      stance: 'toBe',
      attributes: { title: 'Tenant isolation', statement: 'Every item has one tenant.' },
      claim: stated,
    },
  ])
  const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
  return { ctx, bundle }
}

const clone = (b: ProjectExport): ProjectExport => JSON.parse(JSON.stringify(b))

describe('project export and import (ADR 0014)', () => {
  it('exports events, content and principals, and an import rebuilds the same state', () => {
    const { ctx, bundle } = exported()
    expect(bundle).toMatchObject({
      format: 'kalyth.project-export',
      formatVersion: 2,
      exportedBy: ctx.ownerPrincipal.id,
      project: { id: ctx.project.id, headRevision: 3 },
      stateSha256: stateSha256(ctx.store, ctx.project.id),
    })
    expect(bundle.events.map((e) => e.type)).toEqual([
      'project.created',
      'changeSet.committed',
      'changeSet.committed',
      'changeSet.committed',
    ])
    expect(bundle.principals.map((p) => p.id)).toEqual([ctx.ownerPrincipal.id])
    // The secret never left the store, and the redaction travels with the export.
    expect(JSON.stringify(bundle)).not.toContain('AKIA')
    expect(bundle.content.filter((c) => c.body === null)).toEqual([
      expect.objectContaining({ redactionReason: expect.stringMatching(/^secret-pattern:/) }),
    ])

    const target = new SqliteStore(':memory:')
    const summary = unwrap(importProjectExport(target, clone(bundle)))
    expect(summary).toMatchObject({
      projectId: ctx.project.id,
      headRevision: 3,
      events: 4,
      content: bundle.content.length,
      principalsAdded: 1,
    })
    expect(canonicalJson(target.dumpRevisionedState(ctx.project.id))).toBe(
      canonicalJson(ctx.store.dumpRevisionedState(ctx.project.id)),
    )
    // Events and content come across too, so the imported project exports the same bundle.
    expect(target.listEvents(ctx.project.id).map((e) => e.id)).toEqual(
      bundle.events.map((e) => e.id),
    )
    expect(target.listContent(ctx.project.id)).toEqual(bundle.content)
    expect(JSON.stringify(target.listEvents(ctx.project.id).map(({ seq: _s, ...e }) => e))).toBe(
      JSON.stringify(bundle.events.map(({ seq: _s, ...e }) => e)),
    )
    expect(JSON.stringify(target.dumpRevisionedState(ctx.project.id))).toBe(
      JSON.stringify(ctx.store.dumpRevisionedState(ctx.project.id)),
    )
  })

  it('imports a bundle whose JSON was reformatted with sorted keys', () => {
    const { ctx, bundle } = exported()
    const target = new SqliteStore(':memory:')
    unwrap(importProjectExport(target, JSON.parse(canonicalJson(bundle))))
    expect(stateSha256(target, ctx.project.id)).toBe(bundle.stateSha256)
  })

  it('refuses an export with a missing, altered or foreign part, and changes nothing', () => {
    const { bundle } = exported()
    const target = new SqliteStore(':memory:')
    const codes = (b: ProjectExport) =>
      errorOf(importProjectExport(target, b)).issues.map((i) => i.code)

    const missingContent = clone(bundle)
    missingContent.content = missingContent.content.filter((c) => c.body === null)
    expect(codes(missingContent)).toContain('export.content_missing')

    const alteredBody = clone(bundle)
    const withBody = alteredBody.content.find((c) => c.body !== null)
    if (withBody) withBody.body = `${withBody.body} # changed`
    expect(codes(alteredBody)).toContain('export.content_hash')

    const gap = clone(bundle)
    gap.events = gap.events.filter((_, i) => i !== 2)
    expect(codes(gap)).toEqual(expect.arrayContaining(['export.revision_gap']))

    // A write changed inside an event: the bundle is consistent, but not with its state hash.
    const altered = clone(bundle)
    const event = altered.events[3]
    if (event?.type === 'changeSet.committed') {
      const write = event.payload.writes.find((w) => w.kind === 'object')
      if (write?.kind === 'object') write.version.attributes.title = 'Forged title'
    }
    expect(codes(altered)).toEqual(['export.state_mismatch'])

    // A field the contract does not read is refused rather than stored.
    const extra = clone(bundle)
    Object.assign(extra.events[1] as object, { note: 'smuggled' })
    expect(codes(extra)).toEqual(['export.unexpected_fields'])

    expect(errorOf(importProjectExport(target, { format: 'other' })).code).toBe('invalid')
    expect(target.listProjects()).toEqual([])
    expect(target.listEvents()).toEqual([])
  })

  it('refuses to import over an existing project', () => {
    const { ctx, bundle } = exported()
    expect(errorOf(importProjectExport(ctx.store, clone(bundle))).code).toBe('conflicting')
  })

  it('lets only a person acting directly export', () => {
    const { ctx } = exported()
    const projectId = ctx.project.id
    expect(errorOf(ctx.services.exportProject(ctx.agent, { projectId })).code).toBe('unauthorized')
    expect(
      errorOf(ctx.services.exportProject({ ...ctx.owner, origin: 'relayed' }, { projectId })).code,
    ).toBe('unauthorized')
    expect(
      errorOf(ctx.services.exportProject(ctx.owner, { projectId: `prj_${'0'.repeat(32)}` })).code,
    ).toBe('not_found')
  })
})
