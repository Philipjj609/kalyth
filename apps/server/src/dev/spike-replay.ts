import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Caller, GroundingReport } from '@kalyth/contracts'
import { KalythServices, SqliteStore } from '@kalyth/core'
import {
  type AlternativesOutput,
  alternativesContext,
  ensureNavigatorPrincipal,
  type GroundingOptions,
  mapAlternatives,
  mapSummary,
  ProjectReader,
  SummaryOutput,
  summarizeContext,
} from '@kalyth/navigator'

// Replays the keyed spike's recorded answers through the current grounding validator, against the
// same contexts the spike built (ADR 0017). No network and no spend: it reads the demo database
// and the recordings that `pnpm spike` wrote, and prints exact, normalised and rejected citations
// with and without the Python delimiter fallback, then every normalised match for review.
//
//   pnpm spike:replay [--db .kalyth/demo.db] [--recordings .kalyth/recordings/spike] [--revision 4]

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: '.kalyth/demo.db' },
    recordings: { type: 'string', default: '.kalyth/recordings/spike' },
    revision: { type: 'string', default: '4' },
  },
})
const services = new KalythServices({ store: new SqliteStore(values.db ?? '') })
const caller: Caller = { principalId: ensureNavigatorPrincipal(services).id, origin: 'model' }
const owner = services.listProjects(caller)
if (!owner.ok) throw new Error(owner.error.message)
const project = owner.value.projects[0]
if (!project) throw new Error(`no project in ${values.db}`)
const reader = new ProjectReader(services, caller, project.id, Number(values.revision))
const objects = [...reader.objects.values()]
const named = (type: string, name: string) => {
  const id = objects.find((o) => o.type === type && o.attributes.name === name)?.id
  if (!id) throw new Error(`no ${type} named ${name}`)
  return id
}
// The spike's own inputs: the backend container, and User and Item as focus.
const backend = named('software.Container', 'backend')
const summaryContext = summarizeContext(reader, backend)
const alternativesCtx = alternativesContext(reader, [
  named('software.DataEntity', 'User'),
  named('software.DataEntity', 'Item'),
])

interface Recording {
  model: string
  recordedAt: string
  response: { content: string; finishReason: string | null }
}
const recordings = (
  JSON.parse(readFileSync(`${values.recordings}/recordings.json`, 'utf8')) as Recording[]
)
  .filter((r) => r.response.finishReason === 'stop')
  .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1))

const model = { provider: 'replay', model: 'replay' }
/**
 * Answers are scored as recorded, not against today's output schema: the first spike answer has
 * more direct changes than the limit added afterwards.
 */
const asRecorded = (value: unknown): AlternativesOutput => {
  const out = value as AlternativesOutput
  return {
    ...out,
    alternatives: out.alternatives.map((a) => ({ ...a, combines: a.combines ?? [] })),
  }
}
const fmt = (g: GroundingReport) =>
  `${g.citations} citations: exact ${g.exactCitations}, normalised ${g.normalizedCitations}, rejected ${g.citations - g.validCitations}; items kept ${g.itemsKept}, rejected ${g.itemsRejected.length}`

const settings: [string, GroundingOptions][] = [
  ['bounded (default)', {}],
  ['with Python delimiters', { pythonStringDelimiters: true }],
]
const review: { label: string; g: GroundingReport }[] = []
for (const r of recordings) {
  const label = `${r.recordedAt} ${r.model}`
  const value: unknown = JSON.parse(r.response.content)
  const isSummary = SummaryOutput.safeParse(value).success
  process.stdout.write(`\n${label} (${isSummary ? 'summary' : 'alternatives'})\n`)
  for (const [name, options] of settings) {
    const g = isSummary
      ? mapSummary(value as SummaryOutput, summaryContext, backend, model, options).grounding
      : mapAlternatives(asRecorded(value), alternativesCtx, model, undefined, options).grounding
    process.stdout.write(`  ${name}: ${fmt(g)}\n`)
    if (name === settings[1]?.[0]) review.push({ label, g })
  }
}

process.stdout.write('\nNormalised matches (with the Python fallback), model quote vs source:\n')
for (const { label, g } of review) {
  for (const m of g.normalizedMatches ?? []) {
    process.stdout.write(
      `\n- ${label} ${m.item} ${m.ref} [${m.differences.join(', ')}]\n  quote:  ${JSON.stringify(m.quote)}\n  source: ${JSON.stringify(m.source)}\n`,
    )
  }
}
