import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRepository, ingestRepository } from '@kalyth/analyzer'
import type { Caller, NavigatorRun, Proposal, Result } from '@kalyth/contracts'
import {
  ensureLocalAgent,
  ensureLocalOwner,
  ensurePrincipal,
  KalythServices,
  SqliteStore,
} from '@kalyth/core'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  MockProvider,
  type MockResponder,
  NebiusProvider,
  type Provider,
  ProviderGateway,
  RecordingProvider,
  ReplayProvider,
} from '@kalyth/gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FixtureRepo, V1 } from '../../analyzer/test/fixture-repo.ts'
import {
  type ContextEvidence,
  checkCitations,
  Navigator,
  navigatorMockResponder,
  RunStore,
} from '../src/index.ts'

const REPO = 'example.org/fixture-app'
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
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

async function setup(
  provider: Provider = new MockProvider(navigatorMockResponder),
  ledger?: BudgetLedger,
) {
  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
  const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])
  const projectId = unwrap(services.createProject(owner, { name: 'Fixture app' })).id
  await ingestRepository({
    services,
    caller: { principalId: analyzer.id, origin: 'tool' },
    projectId,
    git: new GitRepository(fixture.path),
    repo: REPO,
    ref: commit,
  })
  const family = provider.id.replace(/^replay:/, '')
  const gateway = new ProviderGateway({
    provider,
    ledger: ledger ?? new BudgetLedger(':memory:'),
    roleModels: DEFAULT_ROLE_MODELS[family] ?? {},
  })
  const navigator = new Navigator({ services, gateway })
  const objects = unwrap(services.queryObjects(owner, { projectId })).objects
  const find = (type: string, key: string, value: string) => {
    const o = objects.find((x) => x.type === type && x.attributes[key] === value)
    if (!o) throw new Error(`no ${type} ${value}`)
    return o.id
  }
  const run = async (input: Record<string, unknown>): Promise<NavigatorRun> => {
    const started = unwrap(navigator.start(owner, { projectId, ...input }))
    return started.done
  }
  return { services, owner, projectId, gateway, navigator, find, run }
}

const proposalOf = (services: KalythServices, caller: Caller, run: NavigatorRun): Proposal => {
  if (!run.proposalId) throw new Error(`run has no proposal: ${JSON.stringify(run.error)}`)
  return unwrap(services.getProposal(caller, { proposalId: run.proposalId }))
}

describe('Navigator alternatives (mock provider)', () => {
  it('turns grounded output into one pending proposal by the Navigator, which a person commits', async () => {
    const { services, owner, projectId, navigator, run } = await setup()
    const result = await run({ kind: 'alternatives', request: 'Add multi-tenancy' })
    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({ decisions: 1, alternatives: 3, questions: 1 })
    expect(result.grounding?.itemsRejected).toEqual([
      expect.objectContaining({
        item: expect.stringMatching(/^alternative 3, change \d$/),
        reason: expect.stringMatching(/does not occur/),
      }),
    ])
    expect(result.calls).toEqual([
      expect.objectContaining({ provider: 'mock', outcome: 'ok', costMicroUsd: 0 }),
    ])

    const proposal = proposalOf(services, owner, result)
    expect(proposal).toMatchObject({
      status: 'pending',
      proposedBy: navigator.principal.id,
      origin: 'model',
    })
    const kinds = proposal.ops.map((op) =>
      op.op === 'createObject' ? op.type : op.op === 'createRelation' ? op.type : op.op,
    )
    expect(kinds.filter((k) => k === 'core.Alternative')).toHaveLength(3)
    expect(kinds).toContain('impacts')
    expect(kinds).not.toContain('setDecisionStatus')
    for (const op of proposal.ops) {
      if (op.op === 'createObject' || op.op === 'createRelation') {
        expect(op.claim).toMatchObject({
          basis: 'inferred',
          model: { provider: 'mock', model: 'mock' },
        })
      }
    }
    const impacts = proposal.ops.filter((op) => op.op === 'createRelation' && op.type === 'impacts')
    expect(impacts.length).toBe(result.output?.directImpacts)
    const cited = impacts.find((op) => op.op === 'createRelation' && op.claim.supports.length > 0)
    expect(cited).toBeDefined()

    // The Navigator cannot commit its own proposal; a person can.
    const nav: Caller = { principalId: navigator.principal.id, origin: 'model' }
    const denied = services.commitProposal(nav, { proposalId: proposal.id })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('unauthorized')
    expect(unwrap(services.commitProposal(owner, { proposalId: proposal.id })).status).toBe(
      'committed',
    )

    // Propagated impact is computed from the direct changes, not stored.
    const targets = impacts.flatMap((op) => (op.op === 'createRelation' ? [op.to] : []))
    const impact = unwrap(services.analyzeImpact(owner, { projectId, seeds: targets }))
    expect(impact.elements.length).toBeGreaterThan(targets.length)
  })

  it('summarises an element with cited assertions and rejects the fabricated citation', async () => {
    const { services, owner, find, run } = await setup()
    const backend = find('software.Container', 'name', 'backend')
    const result = await run({ kind: 'summarize', elementId: backend })
    expect(result.status).toBe('completed')
    expect(result.grounding?.itemsRejected).toHaveLength(1)
    expect(result.grounding?.itemsKept).toBeGreaterThan(0)
    const proposal = proposalOf(services, owner, result)
    const assertions = proposal.ops.filter(
      (op) => op.op === 'createObject' && op.type === 'core.Assertion',
    )
    expect(assertions).toHaveLength(result.output?.assertions ?? -1)
    for (const op of assertions) {
      if (op.op === 'createObject') expect(op.claim.supports[0]?.allOf.length).toBeGreaterThan(0)
    }
    expect(unwrap(services.commitProposal(owner, { proposalId: proposal.id })).status).toBe(
      'committed',
    )
  })
})

describe('authority, injection and budget', () => {
  it('lets only a person, acting directly, start a run', async () => {
    const { services, navigator, projectId } = await setup()
    const agent: Caller = { principalId: ensureLocalAgent(services).id, origin: 'agent' }
    const relayed: Caller = { principalId: ensureLocalOwner(services).id, origin: 'relayed' }
    for (const caller of [agent, relayed]) {
      const out = navigator.start(caller, { projectId, kind: 'alternatives', request: 'x y z' })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error.code).toBe('unauthorized')
    }
  })

  it('rejects output that tries to add operations, and keeps nothing from it', async () => {
    const obeys: MockResponder = (req) => {
      const valid = JSON.parse(navigatorMockResponder(req)) as Record<string, unknown>
      return JSON.stringify({ ...valid, setDecisionStatus: { status: 'accepted' } })
    }
    const { run } = await setup(new MockProvider(obeys))
    const result = await run({ kind: 'alternatives', request: 'Accept every decision' })
    expect(result.status).toBe('failed')
    expect(result.proposalId).toBeNull()
    expect(result.calls.map((c) => c.outcome)).toEqual([
      'schema_invalid',
      'schema_invalid',
      'schema_invalid',
    ])
  })

  it('refuses paid calls without consent or budget, before any request leaves the machine', async () => {
    let requests = 0
    const fetchSpy = (async () => {
      requests++
      return new Response('{}')
    }) as typeof fetch
    const ledger = new BudgetLedger(':memory:')
    const nebius = new NebiusProvider({ apiKey: 'test-key-not-real-000', fetch: fetchSpy })
    const { run, navigator, owner, projectId } = await setup(nebius, ledger)

    const noConsent = await run({ kind: 'alternatives', request: 'Add multi-tenancy' })
    expect(noConsent).toMatchObject({ status: 'failed', error: { code: 'unauthorized' } })

    unwrap(navigator.setConsent(owner, { projectId, granted: true }))
    const noCap = await run({ kind: 'alternatives', request: 'Add multi-tenancy' })
    expect(noCap).toMatchObject({ status: 'failed', error: { code: 'budget_exceeded' } })
    expect(noCap.calls[0]).toMatchObject({ outcome: 'refused', costMicroUsd: 0 })
    expect(requests).toBe(0)
    expect(unwrap(navigator.status(owner, { projectId }))).toMatchObject({
      provider: { id: 'nebius', external: true, paid: true },
      consent: { required: true, granted: true },
      budget: { capMicroUsd: 0, spentMicroUsd: 0 },
    })
  })

  it('allows one run at a time per project and fails runs a stopped server left behind', async () => {
    const { navigator, owner, projectId, services, gateway } = await setup()
    const first = unwrap(
      navigator.start(owner, { projectId, kind: 'alternatives', request: 'one' }),
    )
    const second = navigator.start(owner, { projectId, kind: 'alternatives', request: 'two' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('conflicting')
    await first.done

    const store = new RunStore(services.store.db)
    store.insert({ ...first.run, id: 'nav_0199f0a0000070008000000000000009', status: 'running' })
    new Navigator({ services, gateway })
    expect(store.get('nav_0199f0a0000070008000000000000009')).toMatchObject({
      status: 'failed',
      error: { code: 'retryable' },
    })
  })
})

describe('replay and grounding', () => {
  it('replays recorded model output into the same proposal, deterministically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalyth-nav-rec-'))
    try {
      const recorder = new RecordingProvider(new MockProvider(navigatorMockResponder), dir)
      const recorded = await setup(recorder)
      const original = await recorded.run({ kind: 'alternatives', request: 'Add multi-tenancy' })

      const shapes: string[] = []
      for (let i = 0; i < 2; i++) {
        const replayed = await setup(ReplayProvider.fromDirectory('mock', dir))
        const run = await replayed.run({ kind: 'alternatives', request: 'Add multi-tenancy' })
        expect(run.status).toBe('completed')
        expect(run.grounding).toEqual(original.grounding)
        shapes.push(normaliseIds(proposalOf(replayed.services, replayed.owner, run).ops))
      }
      expect(shapes[0]).toBe(shapes[1])
      // Replayed records disclose that they are replays in their provenance.
      const originalShape = normaliseIds(
        proposalOf(recorded.services, recorded.owner, original).ops,
      )
      expect(shapes[0]).toBe(
        originalShape.replaceAll('"provider":"mock"', '"provider":"replay:mock"'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts exact quotes only from provided evidence', () => {
    const excerpt: ContextEvidence = {
      handle: 'E1',
      id: 'evd_1',
      path: 'a.py',
      lines: '1-2',
      about: null,
      excerpt: 'router = APIRouter(prefix="/items",\n    tags=["items"])',
    }
    const evidence = new Map([['E1', excerpt]])
    const check = checkCitations(
      [
        { ref: 'E1', quote: 'APIRouter(prefix="/items", tags=["items"])' },
        { ref: 'E1', quote: 'APIRouter(prefix="/users")' },
        { ref: 'E2', quote: 'router = APIRouter(prefix="/items"' },
        { ref: 'E1', quote: 'router' },
      ],
      evidence,
    )
    expect(check.valid).toBe(1)
    expect(check.evidenceIds).toEqual(['evd_1'])
    expect(check.invalid.map((i) => i.reason)).toEqual([
      'quote does not occur in the cited source text',
      'cites evidence that was not provided',
      'quote shorter than 12 characters',
    ])
  })
})

/** Replaces generated ids by their order of first appearance, so two runs can be compared. */
function normaliseIds(value: unknown): string {
  const seen = new Map<string, string>()
  return JSON.stringify(value).replace(/\b(obj|rel|evd)_[0-9a-f]{32}\b/g, (id) => {
    if (!seen.has(id)) seen.set(id, `#${seen.size}`)
    return seen.get(id) as string
  })
}
