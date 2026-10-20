import { analyzeRepository, GitRepository, ingestRepository } from '@kalyth/analyzer'
import { ContextCompiler } from '@kalyth/context'
import type { Caller, ObjectVersion, OperationInput, Result } from '@kalyth/contracts'
import { ensureLocalAgent, ensureLocalOwner, KalythServices, SqliteStore } from '@kalyth/core'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureRepo, V1, V2 } from '../../analyzer/test/fixture-repo.ts'
import {
  ensureAnalyzer,
  matchKey,
  observeChange,
  RECONCILE_METHOD,
  summariseObserved,
  TaskCoordinator,
  taskTrailer,
} from '../src/index.ts'

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok)
    throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.issues)}`)
  return r.value
}
const errorOf = <T>(r: Result<T>) => {
  if (r.ok) throw new Error('expected an error')
  return r.error
}

const REPO = 'example.org/fixture-app'
const ITEMS = 'backend/app/api/routes/items.py'
const repos: FixtureRepo[] = []
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose()
})

const inferred = {
  basis: 'inferred' as const,
  confidence: { level: 'medium' as const, rationale: 'proposed for the test' },
}

/**
 * The fixture at V2 (no POST route), analysed; an accepted decision whose alternative changes the
 * items routes module and proposes the POST endpoint and an Organisation entity; and a ready task
 * implementing it, from the V2 commit, with the task repository registered.
 */
async function world() {
  const repo = new FixtureRepo()
  repos.push(repo)
  repo.write(V1)
  repo.commit('v1')
  repo.write(V2)
  const base = repo.commit('v2')

  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
  const agent: Caller = { principalId: ensureLocalAgent(services).id, origin: 'agent' }
  const analyzer: Caller = { principalId: ensureAnalyzer(services).id, origin: 'tool' }
  const projectId = unwrap(services.createProject(owner, { name: 'Fixture app' })).id
  const ingest = (ref: string, git = repo) =>
    ingestRepository({
      services,
      caller: analyzer,
      projectId,
      git: new GitRepository(git.path),
      repo: REPO,
      ref,
    })
  await ingest(base)
  const objects = () => unwrap(services.queryObjects(owner, { projectId, limit: 1000 })).objects
  const find = (pred: (o: ObjectVersion) => boolean) => {
    const o = objects().find(pred)
    if (!o) throw new Error('not found')
    return o
  }
  const itemsModule = find((o) => o.type === 'software.Module' && o.attributes.path === ITEMS)
  expect(
    objects().some((o) => o.type === 'software.Endpoint' && o.attributes.method === 'POST'),
  ).toBe(false)

  const commitOps = (ops: OperationInput[]) => {
    const head = unwrap(services.getProjectOverview(owner, { projectId })).project.headRevision
    const p = unwrap(
      services.proposeChange(owner, { projectId, baseRevision: head, rationale: 'test', ops }),
    )
    if (p.status !== 'pending') throw new Error(JSON.stringify(p.issues))
    return unwrap(services.commitProposal(owner, { proposalId: p.proposalId }))
  }
  const planned = commitOps([
    {
      op: 'createObject',
      ref: '$d',
      type: 'core.Decision',
      stance: 'toBe',
      attributes: { title: 'Create items', question: 'How do clients create items?' },
      claim: inferred,
    },
    {
      op: 'createObject',
      ref: '$a',
      type: 'core.Alternative',
      stance: 'toBe',
      attributes: { title: 'A POST route', summary: 'Add POST /api/v1/items.' },
      claim: inferred,
    },
    {
      op: 'createRelation',
      type: 'alternativeOf',
      from: '$a',
      to: '$d',
      stance: 'toBe',
      claim: inferred,
    },
    {
      op: 'createObject',
      ref: '$post',
      type: 'software.Endpoint',
      stance: 'toBe',
      attributes: { method: 'POST', path: '/api/v1/items' },
      claim: inferred,
    },
    {
      op: 'createObject',
      ref: '$org',
      type: 'software.DataEntity',
      stance: 'toBe',
      attributes: { name: 'Organisation' },
      claim: inferred,
    },
    {
      op: 'createRelation',
      type: 'impacts',
      from: '$a',
      to: itemsModule.id,
      stance: 'toBe',
      properties: { change: 'add the POST handler' },
      claim: inferred,
    },
    {
      op: 'createRelation',
      type: 'impacts',
      from: '$a',
      to: '$post',
      stance: 'toBe',
      properties: { change: 'new endpoint' },
      claim: inferred,
    },
    {
      op: 'createRelation',
      type: 'impacts',
      from: '$a',
      to: '$org',
      stance: 'toBe',
      properties: { change: 'new entity' },
      claim: inferred,
    },
    {
      op: 'createObject',
      ref: '$t',
      type: 'core.Task',
      stance: 'toBe',
      attributes: {
        title: 'Add the POST route',
        acceptanceCriteria: ['POST /api/v1/items/ creates an item'],
        baseCommit: base,
      },
      claim: { basis: 'stated' },
    },
    {
      op: 'createRelation',
      type: 'implements',
      from: '$t',
      to: '$d',
      stance: 'toBe',
      claim: { basis: 'stated' },
    },
  ])
  const ids = planned.refs as Record<string, string>
  const decisionId = ids.$d as string
  const taskId = ids.$t as string
  commitOps([
    { op: 'setDecisionStatus', id: decisionId, status: 'accepted', rationale: 'simplest' },
    { op: 'setDecisionStatus', id: ids.$a as string, status: 'accepted', rationale: 'simplest' },
    { op: 'setTaskStatus', id: taskId, status: 'ready', rationale: 'scoped' },
  ])
  const tasks = new TaskCoordinator({ services, context: new ContextCompiler({ services }) })
  unwrap(tasks.setRepository(owner, { projectId, path: repo.path }))

  /** The agent's work: the POST route back, committed with the trailer, reported and verified. */
  const deliver = () => {
    const { lease } = unwrap(tasks.claim(agent, { taskId }))
    repo.write({ [ITEMS]: V1[ITEMS] as string })
    const sha = repo.commit(`Add the POST route\n\n${taskTrailer(taskId)}`)
    const reported = unwrap(
      tasks.submitReport(agent, {
        taskId,
        leaseId: lease.id,
        idempotencyKey: `report-${sha.slice(0, 8)}`,
        outcome: 'succeeded',
        summary: 'Added the POST route.',
        commit: sha,
        filesChanged: [ITEMS],
      }),
    )
    expect(reported.verification.outcome).toBe('pass')
    return sha
  }
  return {
    services,
    owner,
    agent,
    projectId,
    repo,
    base,
    ingest,
    objects,
    tasks,
    taskId,
    decisionId,
    itemsModule,
    post: ids.$post as string,
    org: ids.$org as string,
    commitOps,
    deliver,
  }
}

describe('what the source shows changed (ADR 0024, amendment of 2026-10-20)', () => {
  it('reports fields, new entities and references, and tells own source from a shared file', async () => {
    const repo = new FixtureRepo()
    repos.push(repo)
    repo.write(V1)
    const base = repo.commit('v1')
    repo.write({
      'backend/app/models.py': [
        'from sqlmodel import Field, SQLModel',
        '',
        '',
        'class Team(SQLModel, table=True):',
        '    id: int | None = Field(default=None, primary_key=True)',
        '',
        '',
        'class ItemBase(SQLModel):',
        '    title: str',
        '',
        '',
        'class Item(ItemBase, table=True):',
        '    id: int | None = Field(default=None, primary_key=True)',
        '    team_id: int | None = Field(default=None, foreign_key="team.id")',
        '',
      ].join('\n'),
      // Only create_item changes; read_items, in the same file, keeps its source.
      [ITEMS]: (V1[ITEMS] as string).replace(
        '    return item',
        '    item.title = item.title.strip()\n    return item',
      ),
    })
    const commit = repo.commit('teams')
    const git = new GitRepository(repo.path)
    const seen = observeChange(
      await analyzeRepository({ git, repo: REPO, ref: base }),
      await analyzeRepository({ git, repo: REPO, ref: commit }),
    )
    expect(seen.byKey.get('entity:Team')).toMatchObject({ change: 'added', sourceChanged: true })
    expect(seen.byKey.get('entity:Item')?.details).toEqual(
      expect.arrayContaining([
        'field team_id (int | None, references team.id) added',
        'now references Team',
      ]),
    )
    expect(seen.byKey.get('endpoint:POST /api/v1/items/')).toMatchObject({
      change: 'changed',
      sourceChanged: true,
    })
    expect(seen.byKey.has('endpoint:GET /api/v1/items/')).toBe(false)
    const summary = summariseObserved(seen, new Set(['entity:Item']))
    expect(summary.unplanned.map((e) => e.key)).toEqual([
      'endpoint:POST /api/v1/items/',
      'entity:Team',
    ])
    expect(summary.modulesChanged).toBe(2)
  })
})

describe('reconciling the model with a task (ADR 0024)', () => {
  it('matches observed elements by type and name, endpoints by method and path', () => {
    const key = (type: string, attributes: Record<string, string>) => matchKey({ type, attributes })
    expect(key('software.Endpoint', { method: 'post', path: '/api/v1/items/' })).toBe(
      key('software.Endpoint', { method: 'POST', path: '/api/v1/items' }),
    )
    expect(key('software.Endpoint', { method: 'GET', path: '/' })).toBe('software.Endpoint|GET /')
    expect(key('software.DataEntity', { name: ' Organisation ' })).toBe(
      key('software.DataEntity', { name: 'organisation' }),
    )
    expect(key('software.DataEntity', { name: 'Item' })).not.toBe(
      key('software.Container', { name: 'Item' }),
    )
  })

  it('counts what the verified report touched on the decision before any reconciliation', async () => {
    const w = await world()
    const facets = () =>
      unwrap(w.services.listDecisions(w.owner, { projectId: w.projectId })).decisions[0]?.facets
    expect(facets()?.implementation).toMatchObject({ touched: 0, changes: 3 })
    w.deliver()
    expect(facets()?.implementation).toMatchObject({ state: 'reported', touched: 1, changes: 3 })
    expect(facets()?.verification.state).toBe('passed')
  })

  it('re-analyses the verified commit, says what it touched, and proposes realizes links', async () => {
    const w = await world()
    const sha = w.deliver()
    const result = unwrap(await w.tasks.reconcile(w.owner, { taskId: w.taskId }))
    expect(result.report).toMatchObject({ commit: sha, filesChanged: [ITEMS] })
    expect(result.analysis).toMatchObject({ repo: REPO, commit: sha, status: 'analysed' })
    expect(result.analysis.proposalId).not.toBeNull()
    expect(result.analysis.created).toBeGreaterThan(0)

    // The analyzer committed what it observed, under its own principal and rules.
    const observedPost = w
      .objects()
      .find(
        (o) =>
          o.type === 'software.Endpoint' && o.attributes.method === 'POST' && o.stance === 'asIs',
      )
    expect(observedPost?.claim.basis).toBe('observed')
    const snapshot = w.objects().find((o) => o.type === 'core.SourceSnapshot')
    expect(snapshot?.attributes).toMatchObject({ repo: REPO, commit: sha })

    const [decision] = result.decisions
    expect(result.decisions).toHaveLength(1)
    expect(decision).toMatchObject({ id: w.decisionId, status: 'accepted', touched: 1 })
    expect(decision?.alternatives.map((a) => a.title)).toEqual(['A POST route'])
    const change = (target: string) => decision?.changes.find((c) => c.target === target)
    expect(change(w.itemsModule.id)).toMatchObject({
      proposed: false,
      touched: true,
      files: [ITEMS],
      change: 'add the POST handler',
    })
    expect(change(w.post)).toMatchObject({ proposed: true, touched: false, files: [] })

    // What the source shows, base against commit with one analyzer: the module's own source
    // changed, the proposed endpoint now exists, and nothing was observed for the entity.
    expect(result.observed).toMatchObject({ base: w.base, commit: sha, unplanned: [], note: null })
    expect(result.observed?.analyzer).toMatch(/^kalyth-analyzer /)
    expect(decision?.changed).toBe(2)
    expect(change(w.itemsModule.id)?.observed).toBe('changed')
    expect(change(w.itemsModule.id)?.details[0]).toMatch(/^its source changed \(/)
    expect(change(w.post)?.observed).toBe('changed')
    expect(change(w.post)?.details[0]).toMatch(/^observed in backend\/app\/api\/routes\/items\.py:/)
    expect(change(w.org)).toMatchObject({ observed: 'unchanged', details: [] })

    // The proposed endpoint now has an observed match, linked by a pending proposal.
    const post = decision?.proposed.find((p) => p.id === w.post)
    expect(post).toMatchObject({
      type: 'software.Endpoint',
      match: { id: observedPost?.id, inCommit: true },
      link: { state: 'pending', relationId: null, created: true },
    })
    expect(decision?.proposed.find((p) => p.id === w.org)).toMatchObject({
      match: null,
      link: null,
    })
    const proposal = unwrap(
      w.services.getProposal(w.owner, { proposalId: post?.link?.proposalId ?? '' }),
    )
    expect(proposal.status).toBe('pending')
    expect(proposal.origin).toBe('tool')
    expect(proposal.ops).toEqual([
      expect.objectContaining({
        op: 'createRelation',
        type: 'realizes',
        from: observedPost?.id,
        to: w.post,
        stance: 'asIs',
        claim: expect.objectContaining({
          basis: 'inferred',
          method: RECONCILE_METHOD,
          confidence: expect.objectContaining({ level: 'high' }),
          derivedFrom: [observedPost?.id, w.post],
        }),
      }),
    ])

    // Asking again analyses nothing new and proposes nothing twice.
    const again = unwrap(await w.tasks.reconcile(w.owner, { taskId: w.taskId }))
    expect(again.analysis).toMatchObject({ status: 'analysed', proposalId: null })
    expect(again.analysis.detail).toMatch(/nothing changed/)
    expect(again.decisions[0]?.proposed.find((p) => p.id === w.post)?.link).toMatchObject({
      state: 'pending',
      proposalId: proposal.id,
      created: false,
    })

    // Once a person commits the link, it is reported as committed.
    unwrap(w.services.commitProposal(w.owner, { proposalId: proposal.id }))
    const linked = unwrap(await w.tasks.reconcile(w.owner, { taskId: w.taskId }))
    expect(linked.decisions[0]?.proposed.find((p) => p.id === w.post)?.link).toMatchObject({
      state: 'committed',
      proposalId: null,
      created: false,
    })
    // Reconciliation decides nothing: the task stays in review for a person to complete.
    expect(unwrap(w.tasks.getTask(w.owner, { taskId: w.taskId })).status).toBe('review')
  })

  it('leaves the model alone when it already reflects a later commit that contains the work', async () => {
    const w = await world()
    const sha = w.deliver()
    w.repo.write({ 'README.md': 'later\n' })
    const later = w.repo.commit('later work')
    await w.ingest(later)
    const result = unwrap(await w.tasks.reconcile(w.owner, { taskId: w.taskId }))
    expect(result.analysis).toMatchObject({ status: 'skipped', commit: sha, proposalId: null })
    expect(result.analysis.detail).toBe(
      `the model already reflects ${later.slice(0, 12)}, which contains ${sha.slice(0, 12)}`,
    )
    const snapshot = w.objects().find((o) => o.type === 'core.SourceSnapshot')
    expect(snapshot?.attributes.commit).toBe(later)
    // The summary is still computed, at the head.
    expect(result.decisions[0]?.touched).toBe(1)
  })

  it('is for a person, after a verified report, on the repository the model was built from', async () => {
    const w = await world()
    expect(errorOf(await w.tasks.reconcile(w.owner, { taskId: w.taskId })).message).toMatch(
      /^the task is ready: reconcile it once git has verified a report/,
    )
    w.deliver()
    expect(errorOf(await w.tasks.reconcile(w.agent, { taskId: w.taskId })).code).toBe(
      'unauthorized',
    )
    expect(
      errorOf(await w.tasks.reconcile({ ...w.owner, origin: 'relayed' }, { taskId: w.taskId }))
        .code,
    ).toBe('unauthorized')

    // A task repository that holds none of the commits the model was analysed from is refused.
    const other = new FixtureRepo()
    repos.push(other)
    other.write({ 'app/x.py': 'X = 1\n' })
    other.commit('unrelated')
    unwrap(w.tasks.setRepository(w.owner, { projectId: w.projectId, path: other.path }))
    const refused = errorOf(await w.tasks.reconcile(w.owner, { taskId: w.taskId }))
    expect(refused.code).toBe('conflicting')
    expect(refused.message).toMatch(/is no longer in the task repository/)
  })
})
