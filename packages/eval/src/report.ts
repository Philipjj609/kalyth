import type { RunRecord, SummaryRow } from './run.ts'

export interface EvalMeta {
  kind: 'scored' | 'dry-run'
  provider: string
  models: Record<string, string>
  /** True when the provider is the mock or a replay of mock output. */
  mock: boolean
  repository: string
  commit: string
  revision: number
  truth: { path: string; sha256: string; reviewedBy: string; frozenAt: string } | null
  budgetChars: number
  runs: number
  chunks: number
  startedAt: string
  finishedAt: string
}

export interface EvalResults {
  meta: EvalMeta
  summary: SummaryRow[]
  records: RunRecord[]
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`
const range = (s: { mean: number; min: number; max: number } | null, f: (v: number) => string) =>
  s ? `${f(s.mean)} (${f(s.min)}-${f(s.max)})` : 'n/a'
const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`

/** A plain report: disclosures first, then numbers, with no claim of significance (ADR 0012). */
export function renderReport(results: EvalResults): string {
  const m = results.meta
  const lines = [
    `# Kalyth evaluation (${m.kind})`,
    '',
    m.mock
      ? '> **Mock output.** These numbers come from a deterministic stand-in, not a model. They exercise the pipeline and say nothing about Kalyth.'
      : `> Model output from ${m.provider}.`,
    m.kind === 'dry-run' ? '> **Dry run.** Nothing was scored; the ground truth was not read.' : '',
    '',
    `- Repository: ${m.repository} at \`${m.commit}\` (analysed as revision ${m.revision}, ${m.chunks} retrieval chunks)`,
    `- Models: ${Object.entries(m.models)
      .map(([role, id]) => `${role} = \`${id}\``)
      .join(', ')}`,
    `- Context budget for the final call: ${m.budgetChars.toLocaleString('en')} characters in both conditions`,
    m.truth
      ? `- Ground truth: \`${m.truth.path}\`, SHA-256 \`${m.truth.sha256}\`, reviewed by ${m.truth.reviewedBy}, frozen ${m.truth.frozenAt}`
      : '- Ground truth: not used',
    `- Runs per scenario and condition: ${m.runs}; ${m.startedAt} to ${m.finishedAt}`,
    '',
    'Recall and precision are file-level, as mean (min-max) over runs. Paths that do not exist at the commit are counted as unsupported and not scored. The Kalyth condition includes one extra call that picks the elements changed directly; its tokens are included below. The sample is small and no statistical significance is claimed.',
    '',
    '| Scenario | Condition | Runs | Failed | Recall | Precision | F1 | Unsupported | Context chars | Tokens in / out | Cost | Latency |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of results.summary) {
    lines.push(
      `| ${r.scenario} | ${r.condition} | ${r.runs} | ${r.failures} | ${range(r.recall, pct)} | ${range(r.precision, pct)} | ${range(r.f1, (v) => v.toFixed(2))} | ${r.unsupported} | ${range(r.contextChars, (v) => Math.round(v).toLocaleString('en'))} | ${r.inputTokens.toLocaleString('en')} / ${r.outputTokens.toLocaleString('en')} | ${usd(r.costMicroUsd)} | ${(r.latencyMs / 1000).toFixed(1)} s |`,
    )
  }
  const failures = results.records.filter((r) => r.error)
  if (failures.length > 0) {
    lines.push('', '## Failed runs', '')
    for (const f of failures) {
      lines.push(
        `- ${f.scenario} / ${f.condition} / run ${f.run}: ${f.error?.code}: ${f.error?.message}`,
      )
    }
  }
  return `${lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n')}\n`
}
