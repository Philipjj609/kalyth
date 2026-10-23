import type { Caller, ObjectVersion, Result } from '@kalyth/contracts'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepository, ingestRepository, objectKey } from '../src/index.ts'
import { FixtureRepo, V1, V2 } from './fixture-repo.ts'

// An ingest committed in parts and interrupted between any two of them (ADR 0025): the model says
// it is incomplete, keeps the old snapshot, holds no duplicates, and running the ingest again
// completes it to exactly what an uninterrupted ingest gives. Other projects are untouched.

const REPO = 'example.org/fixture-app'
const PART = 7
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

let fixture: FixtureRepo
let v1: string
let v2: string
beforeAll(() => {
  fixture = new FixtureRepo()
  fixture.write(V1)
  v1 = fixture.commit('v1')
  fixture.write(V2)
  v2 = fixture.commit('v2')
})
afterAll(() => fixture?.dispose())

/** Services whose `commitProposal` fails on its nth call, as an interrupted run would. */
function interrupted(services: KalythServices, nth: number): KalythServices {
  let calls = 0
  return new Proxy(services, {
    get(target, prop) {
      if (prop === 'commitProposal')
        return (...args: Parameters<KalythServices['commitProposal']>) => {
          calls++
          if (calls === nth) throw new Error('interrupted')
          return target.commitProposal(...args)
        }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function world(services = new KalythServices({ store: new SqliteStore(':memory:') })) {
  const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
  const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])
  const tool: Caller = { principalId: analyzer.id, origin: 'tool' }
  const project = (name: string) => unwrap(services.createProject(owner, { name })).id
  const ingest = (projectId: string, ref: string, via = services, maxOps?: number) =>
    ingestRepository({
      services: via,
      caller: tool,
      projectId,
      git: new GitRepository(fixture.path),
      repo: REPO,
      ref,
      ...(maxOps ? { maxOps } : {}),
    })
  const objects = (projectId: string) => unwrap(services.queryObjects(owner, { projectId })).objects
  const snapshot = (projectId: string) =>
    objects(projectId).find((o) => o.type === 'core.SourceSnapshot') as ObjectVersion
  /** The model as names and relations between names, independent of ids. */
  const shape = (projectId: string) => {
    const all = objects(projectId)
    const name = new Map(
      all.map((o) => [
        o.id,
        `${o.type}:${JSON.stringify({ ...o.attributes, pending: undefined })}`,
      ]),
    )
    const relations = unwrap(services.queryRelations(owner, { projectId })).relations
    return {
      objects: [...name.values()].sort(),
      relations: relations.map((r) => `${r.type} ${name.get(r.from)} ${name.get(r.to)}`).sort(),
    }
  }
  const duplicates = (projectId: string) => {
    const keys = objects(projectId)
      .map((o) => objectKey(o))
      .filter((k): k is string => k !== undefined)
    return keys.length - new Set(keys).size
  }
  return { services, owner, project, ingest, objects, snapshot, shape, duplicates }
}

describe('an ingest committed in parts', () => {
  it('can stop between any two parts and be completed by running it again', async () => {
    // What an uninterrupted ingest gives, and how many parts it takes.
    const whole = world()
    const reference = whole.project('reference')
    await whole.ingest(reference, v1)
    const before = unwrap(whole.services.getProjectOverview(whole.owner, { projectId: reference }))
      .project.headRevision
    const done = await whole.ingest(reference, v2, whole.services, PART)
    const parts = done.revision - before
    expect(parts).toBeGreaterThan(2)
    expect(whole.snapshot(reference).attributes.pending).toBeUndefined()
    const expected = whole.shape(reference)

    for (let stop = 1; stop <= parts; stop++) {
      const w = world()
      const projectId = w.project(`stops at part ${stop}`)
      const other = w.project('another project on the same repository')
      await w.ingest(projectId, v1)
      await w.ingest(other, v1)
      const otherShape = w.shape(other)

      await expect(w.ingest(projectId, v2, interrupted(w.services, stop), PART)).rejects.toThrow(
        'interrupted',
      )
      // The old snapshot still stands; once a part landed, it says the newer analysis is partial.
      const snap = w.snapshot(projectId)
      expect(snap.attributes.commit).toBe(v1)
      if (stop === 1) expect(snap.attributes.pending).toBeUndefined()
      else expect(snap.attributes.pending).toEqual({ commit: v2, parts })
      const freshness = unwrap(w.services.assessFreshness(w.owner, { projectId }))
      expect(freshness.snapshots[0]?.pending).toEqual(
        stop === 1 ? undefined : { commit: v2, parts },
      )
      expect(w.duplicates(projectId)).toBe(0)
      expect(w.shape(other)).toEqual(otherShape)

      // Running it again completes it, to exactly the uninterrupted result.
      await w.ingest(projectId, v2, w.services, PART)
      expect(w.snapshot(projectId).attributes.commit).toBe(v2)
      expect(w.snapshot(projectId).attributes.pending).toBeUndefined()
      expect(w.duplicates(projectId)).toBe(0)
      expect(w.shape(projectId)).toEqual(expected)
      expect((await w.ingest(projectId, v2, w.services, PART)).proposalId).toBeNull()
      expect(w.shape(other)).toEqual(otherShape)
    }
  })
})
