import { createHash } from 'node:crypto'
import type { Caller, ClaimFreshness, Result } from '@kalyth/contracts'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeRepository, GitRepository, ingestRepository } from '../src/index.ts'
import { FixtureRepo, V1, V2 } from './fixture-repo.ts'

const REPO = 'example.org/fixture-app'
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

function project() {
  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
  const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])
  const tool: Caller = { principalId: analyzer.id, origin: 'tool' }
  const projectId = unwrap(services.createProject(owner, { name: 'Fixture app' })).id
  const ingest = (ref: string) =>
    ingestRepository({
      services,
      caller: tool,
      projectId,
      git: new GitRepository(fixture.path),
      repo: REPO,
      ref,
    })
  return { services, owner, tool, projectId, ingest }
}

describe('static analysis', () => {
  it('extracts containers, modules, imports, libraries, routes and tables with full route paths', async () => {
    const result = await analyzeRepository({
      git: new GitRepository(fixture.path),
      repo: REPO,
      ref: v1,
    })
    const keys = new Set(result.objects.map((o) => o.key))
    for (const key of [
      'system',
      'container:backend',
      'container:frontend',
      'module:backend/app/api/routes/items.py',
      'module:frontend/src/client.ts',
      'endpoint:GET /api/v1/items/',
      'endpoint:POST /api/v1/items/',
      'entity:Item',
      'library:pypi:fastapi',
      'library:pypi:sqlmodel',
      'library:npm:react',
    ])
      expect(keys, key).toContain(key)
    expect(keys).not.toContain('entity:ItemBase')
    const relations = new Set(result.relations.map((r) => r.key))
    expect(relations).toContain(
      'dependsOn|module:frontend/src/main.tsx|module:frontend/src/App.tsx',
    )
    expect(relations).toContain(
      'dependsOn|module:backend/app/main.py|module:backend/app/api/main.py',
    )
    expect(relations).toContain(
      'exposes|module:backend/app/api/routes/items.py|endpoint:POST /api/v1/items/',
    )
    expect(relations).toContain('contains|container:backend|module:backend/app/models.py')
    expect([...keys].some((k) => k.includes('pypi:app'))).toBe(false)
    expect(result.stats.unmountedRoutes ?? 0).toBe(0)
    // A served asset ("/assets/logo.svg") is not a package.
    expect(
      result.objects.filter((o) => o.type === 'software.Library').every((o) => o.attributes.name),
    ).toBe(true)
    expect(result.stats.unresolvedTypeScriptImports).toBe(1)
  })

  it('pins every evidence span to the real blob and the exact text of the span', async () => {
    const result = await analyzeRepository({
      git: new GitRepository(fixture.path),
      repo: REPO,
      ref: v1,
    })
    const spans = [...result.objects, ...result.relations].flatMap((f) => f.supports.flat())
    expect(spans.length).toBeGreaterThan(30)
    // One git call per file, not per span: process spawns are slow on Windows runners.
    const blobs = new Map<string, string>()
    const contents = new Map<string, string>()
    const once = <T>(cache: Map<string, T>, key: string, load: () => T): T => {
      if (!cache.has(key)) cache.set(key, load())
      return cache.get(key) as T
    }
    for (const span of spans) {
      expect(span.blobSha).toBe(once(blobs, span.path, () => fixture.blob(v1, span.path)))
      const text = once(contents, span.path, () => fixture.show(v1, span.path))
        .split(/\r?\n/)
        .slice(span.startLine - 1, span.endLine)
        .join('\n')
      const expected = createHash('sha256').update(text, 'utf8').digest('hex')
      // git show trims the final newline; whole-file spans may differ only by that empty last line.
      if (span.spanSha256 !== expected) {
        const withNewline = createHash('sha256').update(`${text}\n`, 'utf8').digest('hex')
        expect(span.spanSha256).toBe(withNewline)
      }
    }
  })

  it('treats repository text as data: instructions inside it change nothing', async () => {
    const result = await analyzeRepository({
      git: new GitRepository(fixture.path),
      repo: REPO,
      ref: v1,
    })
    expect(Object.keys(result.files)).not.toContain('AGENTS.md')
    const p = project()
    await p.ingest(v1)
    const proposals = unwrap(
      p.services.listProposals(p.owner, { projectId: p.projectId }),
    ).proposals
    const opKinds = new Set(proposals.flatMap((pr) => pr.ops.map((o) => o.op)))
    expect([...opKinds].sort()).toEqual(['createObject', 'createRelation', 'recordEvidence'])
    const claims = proposals.flatMap((pr) =>
      pr.ops.flatMap((o) => ('claim' in o && o.claim ? [o.claim] : [])),
    )
    expect(
      claims.every((c) => c.basis === 'observed' && c.observation?.tool === 'kalyth-analyzer'),
    ).toBe(true)
    expect(JSON.stringify(proposals)).not.toContain('decision.decide')
  })
})

describe('ingest and staleness', () => {
  it('ingests observed facts that are all current, and re-ingesting the same commit changes nothing', async () => {
    const p = project()
    const first = await p.ingest(v1)
    expect(first.revision).toBe(1)
    expect(first.stats.created).toBeGreaterThan(40)
    const freshness = unwrap(p.services.assessFreshness(p.owner, { projectId: p.projectId }))
    expect(freshness.snapshots).toEqual([expect.objectContaining({ repo: REPO, commit: v1 })])
    expect(Object.keys(freshness.summary)).toEqual(['current'])

    const again = await p.ingest(v1)
    expect(again).toMatchObject({ revision: 1, proposalId: null })
  })

  it('advancing to a newer commit refreshes re-observed facts and leaves vanished ones stale for review', async () => {
    const p = project()
    await p.ingest(v1)
    const objects = unwrap(p.services.queryObjects(p.owner, { projectId: p.projectId })).objects
    const idOf = (type: string, attr: string, value: string) =>
      objects.find((o) => o.type === type && o.attributes[attr] === value)?.id as string
    const post = objects.find(
      (o) => o.type === 'software.Endpoint' && o.attributes.method === 'POST',
    )?.id as string
    const get = objects.find((o) => o.type === 'software.Endpoint' && o.attributes.method === 'GET')
      ?.id as string
    const client = idOf('software.Module', 'path', 'frontend/src/client.ts')
    const item = idOf('software.DataEntity', 'name', 'Item')

    // A person records a decision that rests on the POST endpoint, and accepts it.
    const decision = unwrap(
      p.services.proposeChange(p.owner, {
        projectId: p.projectId,
        baseRevision: 1,
        rationale: 'record decision',
        ops: [
          {
            op: 'createObject',
            ref: '$d',
            type: 'core.Decision',
            stance: 'toBe',
            attributes: {
              title: 'Item creation stays public',
              question: 'Should POST /items require admin?',
            },
            claim: { basis: 'stated', derivedFrom: [post] },
          },
        ],
      }),
    )
    unwrap(p.services.commitProposal(p.owner, { proposalId: decision.proposalId }))
    const decisionId = unwrap(
      p.services.queryObjects(p.owner, { projectId: p.projectId, types: ['core.Decision'] }),
    ).objects[0]?.id as string

    const second = await p.ingest(v2)
    expect(second.revision).toBe(3)
    expect(second.stats.notReobserved).toBeGreaterThan(0)

    const freshness = unwrap(p.services.assessFreshness(p.owner, { projectId: p.projectId }))
    const status = (id: string) => freshness.claims.find((c: ClaimFreshness) => c.id === id)?.status
    expect(freshness.snapshots[0]?.commit).toBe(v2)
    expect(status(get)).toBe('current')
    expect(status(item)).toBe('current')
    expect(status(post)).toBe('stale')
    expect(status(client)).toBe('stale')
    expect(status(decisionId)).toBe('derived-stale')

    // History keeps the earlier picture: at revision 1 everything was current against v1.
    const before = unwrap(
      p.services.assessFreshness(p.owner, { projectId: p.projectId, revision: 1 }),
    )
    expect(Object.keys(before.summary)).toEqual(['current'])
  })
})
