import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRepository } from '@kalyth/analyzer'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  MockProvider,
  type Provider,
  ProviderGateway,
  RecordingProvider,
  ReplayProvider,
} from '@kalyth/gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FixtureRepo, V1 } from '../../analyzer/test/fixture-repo.ts'
import {
  Bm25,
  chunkRepository,
  evalMockResponder,
  loadFrozenTruth,
  loadRequestsOnly,
  prepareEvaluation,
  renderReport,
  retrieve,
  runEvaluation,
  scoreFiles,
  summarize,
  TruthError,
  tokenize,
} from '../src/index.ts'

let fixture: FixtureRepo
let commit: string
let dir: string
beforeAll(() => {
  fixture = new FixtureRepo()
  fixture.write(V1)
  commit = fixture.commit('v1')
  dir = mkdtempSync(join(tmpdir(), 'kalyth-eval-'))
})
afterAll(() => {
  fixture?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/** A synthetic truth for the fixture; the real holdout is never used in tests. */
function writeTruth(name: string, overrides: Record<string, unknown> = {}) {
  const truth = {
    status: 'frozen',
    repository: 'example.org/fixture-app',
    commit,
    source: 'synthetic test fixture',
    unit: 'files',
    reviewedBy: 'test',
    frozenAt: '2026-10-17',
    scenarios: [
      {
        id: 'item-organisation',
        request: 'Add an organisation to every item so that items are scoped per organisation.',
        impacted: [{ path: 'backend/app/models.py' }, { path: 'backend/app/api/routes/items.py' }],
      },
    ],
    ...overrides,
  }
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(truth, null, 2)}\n`)
  return {
    path,
    sha256: createHash('sha256')
      .update(`${JSON.stringify(truth, null, 2)}\n`)
      .digest('hex'),
  }
}

function gatewayFor(provider: Provider) {
  return new ProviderGateway({
    provider,
    ledger: new BudgetLedger(':memory:'),
    roleModels: DEFAULT_ROLE_MODELS[provider.id.replace(/^replay:/, '')] ?? {},
  })
}

describe('ground truth (ADR 0012)', () => {
  it('scores only a frozen file whose hash matches the recorded one', () => {
    const frozen = writeTruth('frozen.json')
    expect(loadFrozenTruth(frozen.path, frozen.sha256).truth.scenarios).toHaveLength(1)
    expect(() => loadFrozenTruth(frozen.path, 'a'.repeat(64))).toThrow(TruthError)
    expect(() => loadFrozenTruth(frozen.path, '')).toThrow(/recorded/)
    const draft = writeTruth('draft.json', { status: 'draft', reviewedBy: null, frozenAt: null })
    expect(() => loadFrozenTruth(draft.path, draft.sha256)).toThrow(/not frozen/)
  })

  it('gives a dry run the requests and never the answers', () => {
    const draft = writeTruth('draft-requests.json', { status: 'draft', reviewedBy: null })
    const loaded = loadRequestsOnly(draft.path)
    expect(loaded.scenarios).toEqual([
      { id: 'item-organisation', request: expect.stringContaining('organisation') },
    ])
    expect(JSON.stringify(loaded)).not.toContain('models.py')
  })
})

describe('retrieval and scoring', () => {
  it('splits identifiers and ranks the chunks that share the request terms first', () => {
    expect(tokenize('getCurrentUser user_id')).toEqual(
      expect.arrayContaining(['getcurrentuser', 'get', 'current', 'user', 'id']),
    )
    const bm25 = new Bm25(['class Item: organisation', 'def unrelated(): pass', 'item item'])
    expect(bm25.rank('item organisation').map((r) => r.index)).toEqual([0, 2])
  })

  it('keeps retrieved context within the budget', () => {
    const chunks = chunkRepository(new GitRepository(fixture.path), commit)
    expect(chunks.length).toBeGreaterThan(5)
    const small = retrieve(chunks, 'item router', 600)
    expect(small.chars).toBeLessThanOrEqual(600)
    expect(small.text).toContain('<file path=')
  })

  it('computes file-level recall and precision and sets invented paths aside', () => {
    const existing = new Set(['a.py', 'b.py', 'c.py'])
    const s = scoreFiles(['./a.py', 'c.py', 'ghost.py', 'a.py'], ['a.py', 'b.py'], existing)
    expect(s).toMatchObject({
      truePositives: ['a.py'],
      falsePositives: ['c.py'],
      missed: ['b.py'],
      unsupported: ['ghost.py'],
      recall: 0.5,
      precision: 0.5,
    })
    expect(s.f1).toBeCloseTo(0.5)
  })
})

describe('the harness end to end (mock provider)', () => {
  it('runs both conditions within one budget and reports them as mock output', async () => {
    const truth = writeTruth('e2e.json')
    const { truth: t } = loadFrozenTruth(truth.path, truth.sha256)
    const prepared = await prepareEvaluation({
      git: new GitRepository(fixture.path),
      repository: t.repository,
      commit: t.commit,
      gateway: gatewayFor(new MockProvider(evalMockResponder)),
      budgetChars: 8000,
      consent: false,
    })
    const records = await runEvaluation({
      prepared,
      scenarios: t.scenarios.map((s) => ({ ...s, truth: s.impacted.map((i) => i.path) })),
      conditions: ['baseline', 'kalyth'],
      runs: 2,
    })
    expect(records).toHaveLength(4)
    for (const r of records) {
      expect(r.error).toBeNull()
      expect(r.contextChars).toBeLessThanOrEqual(8000)
      expect(r.score?.unsupported).toEqual([])
    }
    const kalyth = records.find((r) => r.condition === 'kalyth')
    expect(kalyth?.seeds.length).toBeGreaterThan(0)
    expect(kalyth?.packageId).toMatch(/^ctx_/)
    expect(kalyth?.calls.map((c) => c.purpose)).toEqual(['eval.seed.kalyth', 'eval.answer.kalyth'])
    const summary = summarize(records)
    expect(summary.map((s) => [s.condition, s.runs])).toEqual([
      ['baseline', 2],
      ['kalyth', 2],
    ])
    const report = renderReport({
      meta: {
        kind: 'scored',
        provider: 'mock',
        models: { evaluate: 'mock' },
        mock: true,
        repository: t.repository,
        commit: t.commit,
        revision: prepared.revision,
        truth: {
          path: truth.path,
          sha256: truth.sha256,
          reviewedBy: 'test',
          frozenAt: '2026-10-17',
        },
        budgetChars: 8000,
        runs: 2,
        chunks: prepared.chunks,
        startedAt: 'start',
        finishedAt: 'end',
      },
      summary,
      records,
    })
    expect(report).toMatch(/Mock output/)
    expect(report).toMatch(/\| item-organisation \| kalyth \| 2 \| 0 \|/)
  })

  it('replays recorded calls into identical results', async () => {
    const truth = writeTruth('replay.json')
    const { truth: t } = loadFrozenTruth(truth.path, truth.sha256)
    const recordings = join(dir, 'recordings')
    const run = async (provider: Provider) => {
      const prepared = await prepareEvaluation({
        git: new GitRepository(fixture.path),
        repository: t.repository,
        commit: t.commit,
        gateway: gatewayFor(provider),
        budgetChars: 8000,
        consent: false,
      })
      return runEvaluation({
        prepared,
        scenarios: t.scenarios.map((s) => ({ ...s, truth: s.impacted.map((i) => i.path) })),
        conditions: ['baseline', 'kalyth'],
        runs: 1,
      })
    }
    const original = await run(
      new RecordingProvider(new MockProvider(evalMockResponder), recordings),
    )
    const replayed = await run(ReplayProvider.fromDirectory('mock', recordings))
    const shape = (rs: typeof original) =>
      rs.map((r) => ({ c: r.condition, p: r.predicted, s: r.score, k: r.packageId, e: r.error }))
    expect(shape(replayed)).toEqual(shape(original))
    expect(replayed.every((r) => r.calls.every((c) => c.provider === 'replay:mock'))).toBe(true)
  })
})
