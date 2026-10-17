import { GitRepository, ingestRepository } from '@kalyth/analyzer'
import type { Caller, OperationInput, Result } from '@kalyth/contracts'
import { canonicalJson } from '@kalyth/contracts'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FixtureRepo, V1 } from '../../analyzer/test/fixture-repo.ts'
import { ContextCompiler } from '../src/index.ts'

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok)
    throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.issues)}`)
  return r.value
}

let fixture: FixtureRepo
let commit: string
beforeAll(() => {
  fixture = new FixtureRepo()
  fixture.write(V1)
  commit = fixture.commit('v1')
})
afterAll(() => fixture?.dispose())

const stated = { basis: 'stated' as const }

/** The fixture analysed, plus constraints, a decision with two alternatives and a question. */
async function setup(options: { longInvariant?: boolean } = {}) {
  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
  const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])
  const projectId = unwrap(services.createProject(owner, { name: 'Fixture' })).id
  await ingestRepository({
    services,
    caller: { principalId: analyzer.id, origin: 'tool' },
    projectId,
    git: new GitRepository(fixture.path),
    repo: 'example.org/fixture-app',
    ref: commit,
  })
  const objects = unwrap(services.queryObjects(owner, { projectId })).objects
  const find = (type: string, key: string, value: string) => {
    const o = objects.find((x) => x.type === type && x.attributes[key] === value)
    if (!o) throw new Error(`no ${type} ${value}`)
    return o.id
  }
  const item = find('software.DataEntity', 'name', 'Item')
  const backend = find('software.Container', 'name', 'backend')
  const frontend = find('software.Container', 'name', 'frontend')
  const commitOps = (ops: OperationInput[]) => {
    const head = unwrap(services.getProjectOverview(owner, { projectId })).project.headRevision
    const p = unwrap(
      services.proposeChange(owner, { projectId, baseRevision: head, rationale: 'test', ops }),
    )
    return unwrap(services.commitProposal(owner, { proposalId: p.proposalId }))
  }
  commitOps([
    {
      op: 'createObject',
      ref: '$inv',
      type: 'core.Constraint',
      stance: 'toBe',
      attributes: {
        title: 'No data loss',
        statement: options.longInvariant ? 'x'.repeat(7000) : 'Migrations never drop user data.',
        severity: 'must',
        appliesTo: 'project',
      },
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$be',
      type: 'core.Constraint',
      stance: 'toBe',
      attributes: {
        title: 'Python 3.12',
        statement: 'The backend runs on Python 3.12.',
        severity: 'must',
      },
      claim: stated,
    },
    {
      op: 'createRelation',
      type: 'constrains',
      from: '$be',
      to: backend,
      stance: 'toBe',
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$fe',
      type: 'core.Constraint',
      stance: 'toBe',
      attributes: { title: 'Browsers', statement: 'Evergreen browsers only.', severity: 'should' },
      claim: stated,
    },
    {
      op: 'createRelation',
      type: 'constrains',
      from: '$fe',
      to: frontend,
      stance: 'toBe',
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$d',
      type: 'core.Decision',
      stance: 'toBe',
      attributes: { title: 'Tenancy', question: 'How do items belong to an organisation?' },
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$a',
      type: 'core.Alternative',
      stance: 'toBe',
      attributes: { title: 'Row level', summary: 'Add organisation_id to Item.' },
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$b',
      type: 'core.Alternative',
      stance: 'toBe',
      attributes: { title: 'Schema per tenant', summary: 'One schema each.' },
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
    {
      op: 'createRelation',
      type: 'alternativeOf',
      from: '$b',
      to: '$d',
      stance: 'toBe',
      claim: stated,
    },
    {
      op: 'createRelation',
      type: 'impacts',
      from: '$a',
      to: item,
      stance: 'toBe',
      properties: { change: 'add organisation_id' },
      claim: stated,
    },
    {
      op: 'createObject',
      ref: '$q',
      type: 'core.Question',
      stance: 'toBe',
      attributes: {
        text: 'Can an item move between organisations?',
        inquiryRole: 'decision-sensitive',
      },
      claim: stated,
    },
    { op: 'createRelation', type: 'concerns', from: '$q', to: '$d', stance: 'toBe', claim: stated },
  ])
  const decisions = unwrap(services.listDecisions(owner, { projectId })).decisions
  const decision = decisions[0]
  if (!decision) throw new Error('no decision')
  const [a, b] = decision.alternatives
  if (!a || !b) throw new Error('no alternatives')
  const rowLevel = a.title === 'Row level' ? a : b
  const perSchema = a.title === 'Row level' ? b : a
  commitOps([
    { op: 'setDecisionStatus', id: decision.id, status: 'accepted', rationale: 'simplest' },
    { op: 'setDecisionStatus', id: rowLevel.id, status: 'accepted', rationale: 'simplest' },
    { op: 'setDecisionStatus', id: perSchema.id, status: 'rejected', rationale: 'other accepted' },
  ])
  const compiler = new ContextCompiler({ services })
  return { services, owner, projectId, compiler, item, decision, rowLevel, perSchema, commitOps }
}

describe('context packages (ADR 0011)', () => {
  it('hands off an accepted decision with its mandatory set, focus, impact and question', async () => {
    const { compiler, owner, projectId, decision, rowLevel, perSchema, item } = await setup()
    const result = unwrap(
      compiler.compile(owner, {
        projectId,
        focus: [decision.id],
        task: {
          title: 'Add organisations',
          acceptanceCriteria: ['Items are listed per organisation'],
        },
      }),
    )
    const pkg = result.package
    expect(pkg.status).toBe('ready')
    expect(pkg.id).toBe(`ctx_${pkg.sha256.slice(0, 32)}`)
    expect(result.uri).toBe(`kalyth://context/${pkg.id}`)
    expect(pkg.mandatory.invariants.map((i) => i.label)).toEqual(['No data loss'])
    expect(pkg.mandatory.constraints.map((i) => i.label)).toEqual(['Python 3.12'])
    const decided = pkg.mandatory.decisions.map((i) => [i.role, i.id])
    expect(decided).toContainEqual(['decision', decision.id])
    expect(decided).toContainEqual(['alternative', rowLevel.id])
    expect(decided.map(([, id]) => id)).not.toContain(perSchema.id)
    expect(pkg.mandatory.decisions.find((i) => i.role === 'directChange')).toMatchObject({
      to: item,
      attributes: { change: 'add organisation_id' },
    })
    expect(pkg.mandatory.acceptanceCriteria).toEqual(['Items are listed per organisation'])
    expect(pkg.mandatory.policy.join(' ')).toMatch(/People commit/)

    const focus = pkg.items.find((i) => i.id === item)
    expect(focus).toMatchObject({
      role: 'focus',
      distance: 0,
      basis: 'observed',
      freshness: 'current',
    })
    expect(focus?.evidence[0]?.excerpt).toContain('class Item')
    const impacted = pkg.items.filter((i) => i.role === 'impacted')
    expect(impacted.length).toBeGreaterThan(0)
    expect(
      impacted.every(
        (i) => i.path.length === i.distance && i.evidence.every((e) => e.excerpt === null),
      ),
    ).toBe(true)
    expect(pkg.items.map((i) => i.role)).toContain('question')
    const distances = pkg.items.map((i) => i.distance)
    expect(distances).toEqual([...distances].sort((x, y) => x - y))
    expect(pkg.size.chars).toBe(
      canonicalJson(
        Object.fromEntries(Object.entries(pkg).filter(([k]) => k !== 'id' && k !== 'sha256')),
      ).length,
    )
    expect(result.callerScopes).toContain('proposal.commit')
  })

  it('is deterministic and content-addressed, and keeps its revision after the head moves', async () => {
    const { compiler, owner, projectId, decision, commitOps } = await setup()
    const first = unwrap(compiler.compile(owner, { projectId, focus: [decision.id] })).package
    const again = unwrap(compiler.compile(owner, { projectId, focus: [decision.id] })).package
    expect(again).toEqual(first)
    commitOps([
      {
        op: 'createObject',
        type: 'core.Constraint',
        stance: 'toBe',
        attributes: {
          title: 'Audit',
          statement: 'Log tenant changes.',
          severity: 'should',
          appliesTo: 'project',
        },
        claim: stated,
      },
    ])
    const moved = unwrap(compiler.compile(owner, { projectId, focus: [decision.id] })).package
    expect(moved.id).not.toBe(first.id)
    expect(moved.revision).toBe(first.revision + 1)
    const stored = unwrap(compiler.get(owner, { packageId: first.id })).package
    expect(stored).toEqual(first)
  })

  it('cuts optional items nearest first at the size limit and lists what it left out', async () => {
    const { compiler, owner, projectId, decision } = await setup()
    const full = unwrap(compiler.compile(owner, { projectId, focus: [decision.id] })).package
    const limit = full.size.mandatoryChars + 2500
    const small = unwrap(
      compiler.compile(owner, { projectId, focus: [decision.id], maxChars: limit }),
    ).package
    expect(small.status).toBe('ready')
    expect(small.size.chars).toBeLessThanOrEqual(limit)
    expect(small.items.length).toBeLessThan(full.items.length)
    expect(small.items.map((i) => i.id)).toEqual(
      full.items.slice(0, small.items.length).map((i) => i.id),
    )
    const omission = small.omissions.find((o) => o.reason === 'size_limit')
    expect(omission?.count).toBe(full.items.length - small.items.length)
    expect(omission?.ids[0]).toBe(full.items[small.items.length]?.id)
    expect(small.retrieval.map((r) => r.tool)).toContain('query_objects')
  })

  it('blocks instead of truncating the mandatory set, and suggests a split', async () => {
    const { compiler, owner, projectId, decision } = await setup({ longInvariant: true })
    const pkg = unwrap(
      compiler.compile(owner, { projectId, focus: [decision.id], maxChars: 4000 }),
    ).package
    expect(pkg.status).toBe('blocked')
    expect(pkg.blocked).toMatchObject({ code: 'context_overflow', maxChars: 4000 })
    expect(pkg.blocked?.mandatoryChars).toBeGreaterThan(4000)
    expect(pkg.items).toEqual([])
    expect(pkg.blocked?.splits.flat().length).toBeGreaterThan(0)
  })

  it('reads only what the caller may read', async () => {
    const { services, compiler, owner, projectId, decision } = await setup()
    const pkg = unwrap(compiler.compile(owner, { projectId, focus: [decision.id] })).package
    const elsewhere = unwrap(services.createProject(owner, { name: 'Elsewhere' })).id
    const token = unwrap(services.issueAgentToken(owner, { projectId: elsewhere, label: 'other' }))
    const outsider: Caller = { principalId: token.summary.principalId, origin: 'agent' }
    const denied = compiler.get(outsider, { packageId: pkg.id })
    expect(denied.ok).toBe(false)
    expect(compiler.compile(outsider, { projectId, focus: [decision.id] }).ok).toBe(false)
    const own = unwrap(services.issueAgentToken(owner, { projectId, label: 'agent' }))
    const agent: Caller = { principalId: own.summary.principalId, origin: 'agent' }
    const read = unwrap(compiler.get(agent, { packageId: pkg.id }))
    expect(read.package).toEqual(pkg)
    expect(read.callerScopes).toEqual(['project.read', 'proposal.create'])
    const missing = compiler.get(owner, { packageId: 'ctx_00000000000000000000000000000000' })
    expect(missing.ok || missing.error.code).toBe('not_found')
  })
})
