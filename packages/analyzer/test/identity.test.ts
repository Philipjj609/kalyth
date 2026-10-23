import type { Caller, ObjectVersion, Result } from '@kalyth/contracts'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepository, ingestRepository } from '../src/index.ts'
import { FixtureRepo } from './fixture-repo.ts'

// A name that is unique, then declared a second time by another service, then unique again
// (ADR 0025): the original element keeps its identity throughout, and what refers to it follows.

const REPO = 'example.org/two-services'
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok)
    throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.issues)}`)
  return r.value
}
const lines = (...l: string[]) => `${l.join('\n')}\n`
const service = (name: string) => ({
  [`services/${name}/models.py`]: lines(
    'from sqlmodel import Field, SQLModel',
    '',
    '',
    'class User(SQLModel, table=True):',
    '    id: int | None = Field(default=None, primary_key=True)',
    `    ${name}_name: str`,
  ),
  [`services/${name}/api.py`]: lines(
    'from fastapi import FastAPI',
    '',
    'app = FastAPI()',
    '',
    '',
    '@app.get("/users/")',
    'def list_users():',
    '    return []',
  ),
})

let fixture: FixtureRepo
const commits: string[] = []
beforeAll(() => {
  fixture = new FixtureRepo()
  fixture.write({
    'pyproject.toml': '[project]\nname = "two"\nversion = "0.1.0"\n',
    ...service('a'),
  })
  commits.push(fixture.commit('one service'))
  fixture.write(service('b'))
  commits.push(fixture.commit('a second service declares User and GET /users/ too'))
  fixture.write({ 'services/b/models.py': null, 'services/b/api.py': null })
  commits.push(fixture.commit('the second service is gone'))
})
afterAll(() => fixture?.dispose())

describe('identity when a name becomes declared twice', () => {
  it('keeps the original element, re-keyed, and what refers to it, through scoping and back', async () => {
    const services = new KalythServices({ store: new SqliteStore(':memory:') })
    const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
    const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
      'project.read',
      'proposal.create',
      'ingest.observed',
    ])
    const tool: Caller = { principalId: analyzer.id, origin: 'tool' }
    const projectId = unwrap(services.createProject(owner, { name: 'Two services' })).id
    const ingest = (ref: string) =>
      ingestRepository({
        services,
        caller: tool,
        projectId,
        git: new GitRepository(fixture.path),
        repo: REPO,
        ref,
      })
    const objects = () => unwrap(services.queryObjects(owner, { projectId })).objects
    const relations = () => unwrap(services.queryRelations(owner, { projectId })).relations
    const users = () =>
      objects().filter((o) => o.type === 'software.DataEntity' && o.attributes.name === 'User')
    const endpoints = () => objects().filter((o) => o.type === 'software.Endpoint')

    await ingest(commits[0] as string)
    const [user] = users() as [ObjectVersion]
    const [endpoint] = endpoints() as [ObjectVersion]
    expect(users()).toHaveLength(1)
    expect(user.attributes.scope).toBeUndefined()

    // A person's decision rests on that User.
    const head = unwrap(services.getProjectOverview(owner, { projectId })).project.headRevision
    const proposed = unwrap(
      services.proposeChange(owner, {
        projectId,
        baseRevision: head,
        rationale: 'record a decision',
        ops: [
          {
            op: 'createObject',
            ref: '$d',
            type: 'core.Decision',
            stance: 'toBe',
            attributes: { title: 'Rename users', question: 'How?' },
            claim: { basis: 'stated' },
          },
          {
            op: 'createObject',
            ref: '$a',
            type: 'core.Alternative',
            stance: 'toBe',
            attributes: { title: 'Rename the column', summary: 'Rename a_name.' },
            claim: { basis: 'stated' },
          },
          {
            op: 'createRelation',
            type: 'alternativeOf',
            from: '$a',
            to: '$d',
            stance: 'toBe',
            claim: { basis: 'stated' },
          },
          {
            op: 'createRelation',
            ref: '$impact',
            type: 'impacts',
            from: '$a',
            to: user.id,
            stance: 'toBe',
            properties: { change: 'rename a_name' },
            claim: { basis: 'stated' },
          },
        ],
      }),
    )
    const impact = unwrap(services.commitProposal(owner, { proposalId: proposed.proposalId })).refs
      .$impact as string

    // A second service declares User and GET /users/ as well: both names are now scoped.
    const second = await ingest(commits[1] as string)
    expect(second.stats.rekeyed).toBe(2)
    expect(users()).toHaveLength(2)
    const kept = users().find((o) => o.id === user.id)
    expect(kept?.attributes.scope).toBe('services/a/models.py')
    expect(users().find((o) => o.id !== user.id)?.attributes.scope).toBe('services/b/models.py')
    expect(endpoints().find((o) => o.id === endpoint.id)?.attributes.scope).toBe(
      'services/a/api.py:list_users',
    )
    expect(endpoints()).toHaveLength(2)
    // What refers to the original still does, and nothing was added twice.
    expect(relations().find((r) => r.id === impact)).toMatchObject({
      to: user.id,
      lifecycle: 'active',
    })
    const containsUser = relations().filter((r) => r.type === 'contains' && r.to === user.id)
    expect(containsUser).toHaveLength(1)
    const freshness = unwrap(services.assessFreshness(owner, { projectId }))
    expect(freshness.claims.find((c) => c.id === user.id)?.status).toBe('current')

    // The second service goes: the original is unique again, under its plain key, still itself.
    const third = await ingest(commits[2] as string)
    expect(third.stats.rekeyed).toBe(2)
    expect(objects().find((o) => o.id === user.id)?.attributes.scope).toBeUndefined()
    expect(endpoints().find((o) => o.id === endpoint.id)?.attributes.scope).toBeUndefined()
    expect(relations().find((r) => r.id === impact)?.to).toBe(user.id)
    const after = unwrap(services.assessFreshness(owner, { projectId }))
    expect(after.claims.find((c) => c.id === user.id)?.status).toBe('current')
    // The root container, named after the repository, stayed one element throughout.
    expect(objects().filter((o) => o.type === 'software.Container')).toHaveLength(1)
    // Re-ingesting the same commit changes nothing.
    expect((await ingest(commits[2] as string)).proposalId).toBeNull()
  })
})
