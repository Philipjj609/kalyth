import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Caller, NavigatorRun, Result } from '@kalyth/contracts'
import { ensureLocalOwner } from '@kalyth/core'
import { findModel, MODEL_CATALOG, NebiusProvider } from '@kalyth/gateway'
import { loadLocalEnv, openLocalServices, openNavigator } from '../runtime.ts'

// The keyed Nebius feasibility spike (KAL-20261016-010, option a). It runs only with
// KALYTH_PROVIDER=nebius, a key in .env, a ledger cap and the project's consent, all set by a
// person beforehand. It lists models (not billed), then makes one summary call and one
// alternatives call through the gateway, records both for replay, and reports what it learned.
//
//   pnpm spike --project <project id or name> [--element <id>] [--request <text>]

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    element: { type: 'string' },
    request: { type: 'string' },
  },
})
const out = (line = '') => process.stdout.write(`${line}\n`)
const stop = (message: string): never => {
  process.stderr.write(`spike: ${message}\n`)
  process.exit(1)
}
const unwrap = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) stop(`${what}: ${r.error.code}: ${r.error.message}`)
  return (r as { ok: true; value: T }).value
}

loadLocalEnv()
if (process.env.KALYTH_PROVIDER !== 'nebius') stop('set KALYTH_PROVIDER=nebius in .env first')
const apiKey = process.env.KALYTH_NEBIUS_API_KEY ?? stop('set KALYTH_NEBIUS_API_KEY in .env first')
process.env.KALYTH_RECORD_DIR ??= resolve('.kalyth', 'recordings', 'spike')

const services = openLocalServices()
const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
const { navigator, gateway } = openNavigator(services)
const projects = unwrap(services.listProjects(owner), 'projects').projects
const project =
  projects.find((p) => p.id === values.project || p.name === values.project) ??
  stop(
    `no project ${values.project ?? '(pass --project)'}; known: ${projects.map((p) => p.name).join(', ')}`,
  )

const status = unwrap(navigator.status(owner, { projectId: project.id }), 'status')
if (!status.consent.granted) stop(`grant consent for ${project.name} in the UI first`)
const usd = (micro: number) => `${(micro / 1e6).toFixed(4)} USD`
out(`project:   ${project.name} at revision ${project.headRevision}`)
out(`models:    ${JSON.stringify(status.models)}`)
out(
  `budget:    cap ${usd(status.budget.capMicroUsd)}, remaining ${usd(status.budget.remainingMicroUsd)}`,
)
out(`recording: ${process.env.KALYTH_RECORD_DIR}`)

// 1. Model ids (not billed).
const listed = await new NebiusProvider({
  apiKey,
  ...(process.env.KALYTH_NEBIUS_BASE_URL ? { baseUrl: process.env.KALYTH_NEBIUS_BASE_URL } : {}),
}).listModels(AbortSignal.timeout(30_000))
out()
out(
  `listed ${listed.length} models; NVIDIA: ${listed.filter((id) => /nvidia|nemotron/i.test(id)).join(', ')}`,
)
for (const spec of MODEL_CATALOG.filter((m) => m.provider === 'nebius')) {
  const exact = listed.includes(spec.id)
  const loose = listed.find((id) => id.toLowerCase() === spec.id.toLowerCase())
  out(`  ${spec.id}: ${exact ? 'listed' : loose ? `listed as ${loose}` : 'NOT listed'}`)
}
for (const role of Object.values(status.models)) {
  if (!listed.includes(role) || !findModel(role))
    stop(`role model ${role} is not available; fix the catalogue first`)
}

// 2. One call per Navigator operation.
const objects = unwrap(
  services.queryObjects(owner, { projectId: project.id, limit: 1000 }),
  'objects',
).objects
const named = (type: string, name: string) =>
  objects.find((o) => o.type === type && o.attributes.name === name)?.id
const element =
  values.element ??
  named('software.Container', 'backend') ??
  stop('pass --element <id> (no container named backend)')
const focus = ['User', 'Item'].flatMap((n) => named('software.DataEntity', n) ?? [])

async function run(input: Record<string, unknown>): Promise<NavigatorRun> {
  const started = unwrap(navigator.start(owner, { projectId: project.id, ...input }), 'start')
  return started.done
}
function report(run: NavigatorRun) {
  out()
  out(
    `${run.input.kind}: ${run.status}${run.error ? ` (${run.error.code}: ${run.error.message})` : ''}`,
  )
  for (const c of run.calls) {
    out(
      `  call ${c.attempt} ${c.model}: ${c.outcome}, in ${c.inputTokens ?? '?'} out ${c.outputTokens ?? '?'} tokens, ` +
        `${usd(c.costMicroUsd)} (reserved ${usd(c.reservedMicroUsd)}), ${c.latencyMs} ms` +
        (c.issues.length > 0 ? `\n    issues: ${c.issues.join(' | ')}` : ''),
    )
  }
  if (run.grounding) {
    const g = run.grounding
    out(
      `  citations ${g.citations}: exact ${g.exactCitations ?? g.validCitations}, normalised ${g.normalizedCitations ?? 0}, rejected ${g.citations - g.validCitations}; items kept ${g.itemsKept}, rejected ${g.itemsRejected.length}`,
    )
    for (const r of g.itemsRejected)
      out(`    rejected ${r.item}: ${r.reason}${r.ref ? ` (${r.ref})` : ''}`)
  }
  if (run.output) out(`  output ${JSON.stringify(run.output)}; proposal ${run.proposalId}`)
}

report(await run({ kind: 'summarize', elementId: element }))
report(
  await run({
    kind: 'alternatives',
    request: values.request ?? 'Add multi-tenancy: every user and item belongs to an organisation.',
    focus,
  }),
)
const after = gateway.ledger.status()
out()
out(
  `spent ${usd(after.spentMicroUsd)}, reserved ${usd(after.reservedMicroUsd)}, remaining ${usd(after.remainingMicroUsd)}`,
)
