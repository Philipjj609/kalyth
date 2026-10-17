import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { GitRepository } from '@kalyth/analyzer'
import {
  type Condition,
  type EvalResults,
  evalMockResponder,
  loadFrozenTruth,
  loadRequestsOnly,
  prepareEvaluation,
  renderReport,
  runEvaluation,
  type ScenarioInput,
  summarize,
  TruthError,
} from '@kalyth/eval'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  defaultLedgerPath,
  MockProvider,
  type Provider,
  ProviderGateway,
  RecordingProvider,
} from '@kalyth/gateway'
import { loadLocalEnv, providerFromEnv } from '../runtime.ts'

// The G6 evaluation (ADR 0012). Scoring needs a frozen ground truth and the SHA-256 recorded when
// it was frozen; --dry-run exercises the pipeline on the repository without reading any answers.
//
//   pnpm eval --truth docs/evaluation/ground-truth.json --truth-sha <sha256> --git <clone> [--consent]
//   pnpm eval --truth docs/evaluation/ground-truth.draft.json --git <clone> --dry-run
//
// The model comes from KALYTH_PROVIDER (mock by default). Real calls are recorded for replay and
// spend only within the ledger cap.

const { values } = parseArgs({
  options: {
    truth: { type: 'string' },
    'truth-sha': { type: 'string' },
    git: { type: 'string' },
    runs: { type: 'string', default: '3' },
    budget: { type: 'string', default: '60000' },
    conditions: { type: 'string', default: 'baseline,kalyth' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    consent: { type: 'boolean', default: false },
  },
})
const stop = (message: string): never => {
  process.stderr.write(`eval: ${message}\n`)
  process.exit(2)
}

loadLocalEnv()
const truthPath = values.truth ?? stop('pass --truth <ground-truth file>')
const gitPath = values.git ?? stop('pass --git <local clone of the repository>')
const runs = Number(values.runs)
const budgetChars = Number(values.budget)
const conditions = (values.conditions ?? '').split(',') as Condition[]
if (!Number.isInteger(runs) || runs < 1 || runs > 10) stop('--runs must be 1 to 10')
if (!Number.isInteger(budgetChars) || budgetChars < 4000 || budgetChars > 400_000) {
  stop('--budget must be 4000 to 400000 characters')
}
if (conditions.some((c) => c !== 'baseline' && c !== 'kalyth'))
  stop('--conditions: baseline,kalyth')

const dryRun = values['dry-run'] === true
let repository: string
let commit: string
let scenarios: ScenarioInput[]
let truthMeta: EvalResults['meta']['truth'] = null
if (dryRun) {
  const requests = loadRequestsOnly(truthPath)
  ;({ repository, commit } = requests)
  scenarios = requests.scenarios
} else {
  let loaded: ReturnType<typeof loadFrozenTruth>
  try {
    loaded = loadFrozenTruth(truthPath, values['truth-sha'] ?? '')
  } catch (error) {
    if (error instanceof TruthError) stop(error.message)
    throw error
  }
  const { truth, sha256 } = loaded
  repository = truth.repository
  commit = truth.commit
  scenarios = truth.scenarios.map((s) => ({
    id: s.id,
    request: s.request,
    truth: s.impacted.map((i) => i.path),
  }))
  truthMeta = {
    path: truthPath,
    sha256,
    reviewedBy: truth.reviewedBy ?? '',
    frozenAt: truth.frozenAt ?? '',
  }
}

const startedAt = new Date().toISOString()
const out = resolve(values.out ?? join('.kalyth', 'eval', startedAt.replace(/[:.]/g, '-')))
mkdirSync(out, { recursive: true })

const kind = process.env.KALYTH_PROVIDER ?? 'mock'
let provider: Provider
let family: string
if (kind === 'mock') {
  provider = new MockProvider(evalMockResponder)
  family = 'mock'
} else {
  process.env.KALYTH_RECORD_DIR ??= join(out, 'recordings')
  ;({ provider, family } = providerFromEnv())
  if (provider.external && !(provider instanceof RecordingProvider))
    stop('real runs must be recorded')
}
const gateway = new ProviderGateway({
  provider,
  ledger: new BudgetLedger(defaultLedgerPath()),
  roleModels: DEFAULT_ROLE_MODELS[family] ?? {},
})
if (provider.external && !values.consent) {
  stop(`pass --consent to send ${repository} content to ${provider.id}; only public repositories`)
}

const git = new GitRepository(resolve(gitPath))
if (git.resolveCommit(commit) !== commit) stop(`${gitPath} does not contain ${commit}`)
const prepared = await prepareEvaluation({
  git,
  repository,
  commit,
  gateway,
  budgetChars,
  consent: values.consent === true,
})
process.stderr.write(
  `eval: ${dryRun ? 'dry run' : 'scored run'} on ${repository} @ ${commit.slice(0, 8)} (revision ${prepared.revision}, ${prepared.chunks} chunks), provider ${provider.id}\n`,
)
const records = await runEvaluation({
  prepared,
  scenarios,
  conditions,
  runs,
  onRun: (r) =>
    process.stderr.write(
      `  ${r.scenario} / ${r.condition} / run ${r.run}: ${r.error ? `failed (${r.error.code})` : `${r.predicted.length} files, ${r.contextChars} context chars`}\n`,
    ),
})
const results: EvalResults = {
  meta: {
    kind: dryRun ? 'dry-run' : 'scored',
    provider: provider.id,
    models: { ...gateway.roleModels },
    mock: family === 'mock',
    repository,
    commit,
    revision: prepared.revision,
    truth: truthMeta,
    budgetChars,
    runs,
    chunks: prepared.chunks,
    startedAt,
    finishedAt: new Date().toISOString(),
  },
  summary: summarize(records),
  records,
}
writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
const report = renderReport(results)
writeFileSync(join(out, 'report.md'), report)
process.stdout.write(report)
process.stderr.write(`eval: wrote ${join(out, 'results.json')} and report.md\n`)
