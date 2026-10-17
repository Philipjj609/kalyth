import { type GitRepository, ingestRepository } from '@kalyth/analyzer'
import { ContextCompiler } from '@kalyth/context'
import {
  type Caller,
  ID_PREFIX,
  type IdKind,
  type KernelError,
  type ModelCallRecord,
} from '@kalyth/contracts'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import type { ProviderGateway } from '@kalyth/gateway'
import { type Condition, type EvalEnv, runBaseline, runKalyth } from './conditions.ts'
import { chunkRepository } from './retrieval.ts'
import { type Score, scoreFiles } from './score.ts'

/**
 * Ids from a counter, so the same commit always yields the same project, packages and prompts, and
 * recorded model calls replay exactly (ADR 0012).
 */
export function deterministicIds(): (kind: IdKind) => string {
  let n = 0
  return (kind) => `${ID_PREFIX[kind]}_${(++n).toString(16).padStart(32, '0')}`
}

export interface PreparedEvaluation {
  env: EvalEnv
  /** Every file path at the commit, for telling real paths from invented ones. */
  existing: Set<string>
  revision: number
  chunks: number
}

/**
 * A fresh, in-memory project holding the analysis of the pinned commit, so every run starts from
 * the same model whatever the state of the developer's own databases.
 */
export async function prepareEvaluation(options: {
  git: GitRepository
  repository: string
  commit: string
  gateway: ProviderGateway
  budgetChars: number
  /** The person running the evaluation consents to sending this public repository's content. */
  consent: boolean
}): Promise<PreparedEvaluation> {
  const services = new KalythServices({
    store: new SqliteStore(':memory:'),
    ids: deterministicIds(),
  })
  const owner = ensureLocalOwner(services)
  const human: Caller = { principalId: owner.id, origin: 'human' }
  const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])
  const evaluator = ensurePrincipal(services, 'evaluator', 'tool', 'Evaluation harness', [
    'project.read',
  ])
  const created = services.createProject(human, { name: `Evaluation of ${options.repository}` })
  if (!created.ok) throw new Error(created.error.message)
  const projectId = created.value.id
  const report = await ingestRepository({
    services,
    caller: { principalId: analyzer.id, origin: 'tool' },
    projectId,
    git: options.git,
    repo: options.repository,
    ref: options.commit,
  })
  if (options.consent && options.gateway.provider.external) {
    options.gateway.ledger.setConsent(projectId, options.gateway.provider.id, true, owner.id)
  }
  const chunks = chunkRepository(options.git, options.commit)
  const existing = new Set(
    options.git
      .listTree(options.commit)
      .filter((e) => e.type === 'blob')
      .map((e) => e.path),
  )
  return {
    env: {
      services,
      caller: { principalId: evaluator.id, origin: 'tool' },
      projectId,
      gateway: options.gateway,
      context: new ContextCompiler({ services }),
      chunks,
      budgetChars: options.budgetChars,
    },
    existing,
    revision: report.revision,
    chunks: chunks.length,
  }
}

export interface ScenarioInput {
  id: string
  request: string
  /** Truth paths; absent in a dry run, which scores nothing. */
  truth?: string[]
}

export interface RunRecord {
  scenario: string
  condition: Condition
  run: number
  predicted: string[]
  contextChars: number
  seeds: { id: string; label: string }[]
  packageId: string | null
  calls: ModelCallRecord[]
  error: KernelError | null
  score: Score | null
}

export async function runEvaluation(options: {
  prepared: PreparedEvaluation
  scenarios: readonly ScenarioInput[]
  conditions: readonly Condition[]
  runs: number
  onRun?: (record: RunRecord) => void
}): Promise<RunRecord[]> {
  const records: RunRecord[] = []
  for (const scenario of options.scenarios) {
    for (let run = 1; run <= options.runs; run++) {
      for (const condition of options.conditions) {
        const result =
          condition === 'baseline'
            ? await runBaseline(options.prepared.env, scenario.request)
            : await runKalyth(options.prepared.env, scenario.request)
        const record: RunRecord = {
          scenario: scenario.id,
          run,
          ...result,
          score:
            scenario.truth && !result.error
              ? scoreFiles(result.predicted, scenario.truth, options.prepared.existing)
              : null,
        }
        records.push(record)
        options.onRun?.(record)
      }
    }
  }
  return records
}

interface Spread {
  mean: number
  min: number
  max: number
}
const spread = (values: number[]): Spread | null =>
  values.length === 0
    ? null
    : {
        mean: values.reduce((a, v) => a + v, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      }

export interface SummaryRow {
  scenario: string
  condition: Condition
  runs: number
  failures: number
  recall: Spread | null
  precision: Spread | null
  f1: Spread | null
  unsupported: number
  contextChars: Spread | null
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  latencyMs: number
}

export function summarize(records: readonly RunRecord[]): SummaryRow[] {
  const groups = new Map<string, RunRecord[]>()
  for (const r of records) {
    const key = `${r.scenario}\u0000${r.condition}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.values()].map((rs) => {
    const first = rs[0] as RunRecord
    const scored = rs.flatMap((r) => (r.score ? [r.score] : []))
    const calls = rs.flatMap((r) => r.calls)
    return {
      scenario: first.scenario,
      condition: first.condition,
      runs: rs.length,
      failures: rs.filter((r) => r.error).length,
      recall: spread(scored.map((s) => s.recall)),
      precision: spread(scored.map((s) => s.precision)),
      f1: spread(scored.map((s) => s.f1)),
      unsupported: scored.reduce((a, s) => a + s.unsupported.length, 0),
      contextChars: spread(rs.filter((r) => !r.error).map((r) => r.contextChars)),
      inputTokens: calls.reduce((a, c) => a + (c.inputTokens ?? 0), 0),
      outputTokens: calls.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
      costMicroUsd: calls.reduce((a, c) => a + c.costMicroUsd, 0),
      latencyMs: calls.reduce((a, c) => a + c.latencyMs, 0),
    }
  })
}
