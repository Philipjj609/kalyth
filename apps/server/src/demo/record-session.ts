import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLocalOwner, importProjectExport, KalythServices, SqliteStore } from '@kalyth/core'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  NebiusProvider,
  ProviderGateway,
  RecordingProvider,
} from '@kalyth/gateway'
import { Navigator } from '@kalyth/navigator'

// Records the newcomer session's first Navigator run against Nebius, once
// (docs/usability/idea-first-session.md). It SPENDS MONEY, so it runs only with Philip's approval
// and a capped ledger of its own:
//
//   KALYTH_LEDGER=<ledger> pnpm budget set 0.05 --note "<approval entry>"
//   KALYTH_SESSION_RECORDING_LEDGER=<ledger> KALYTH_SESSION_NEBIUS_CONSENT=<project id> \
//     node --env-file=.env apps/server/src/demo/record-session.ts
//
// The run is the one the workbench starts from "Sketch from the idea": an alternatives request
// whose text is the project's idea, with no focus. Import keeps the export's ids, so the recording
// replays exactly when the tester makes that request (KALYTH_PROVIDER=replay).

const env = process.env
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const stop = (message: string): never => {
  process.stderr.write(`record-session: ${message}\n`)
  process.exit(2)
}
const apiKey = env.KALYTH_NEBIUS_API_KEY ?? stop('KALYTH_NEBIUS_API_KEY is not set')
const ledgerPath =
  env.KALYTH_SESSION_RECORDING_LEDGER ?? stop('KALYTH_SESSION_RECORDING_LEDGER is not set')
const exportFile = resolve(
  env.KALYTH_SESSION_EXPORT ?? join(repo, 'deploy/usability/clinic-bookings.json'),
)
const recordingsDir = resolve(
  env.KALYTH_SESSION_RECORDINGS ?? join(repo, 'deploy/usability/recordings'),
)

const work = mkdtempSync(join(tmpdir(), 'kalyth-session-'))
const store = new SqliteStore(join(work, 'session.db'))
const imported = importProjectExport(store, JSON.parse(readFileSync(exportFile, 'utf8')))
if (!imported.ok) stop(`the session project does not import: ${imported.error.message}`)
const { projectId } = (imported as Extract<typeof imported, { ok: true }>).value
if (env.KALYTH_SESSION_NEBIUS_CONSENT !== projectId) {
  stop(`set KALYTH_SESSION_NEBIUS_CONSENT=${projectId} to consent for the session project`)
}
const services = new KalythServices({ store })
const owner = ensureLocalOwner(services)
const caller = { principalId: owner.id, origin: 'human' as const }
const overview = services.getProjectOverview(caller, { projectId })
if (!overview.ok) stop(overview.error.message)
const idea = (overview as Extract<typeof overview, { ok: true }>).value.project.description.trim()

const ledger = new BudgetLedger(resolve(ledgerPath))
if (ledger.status().capMicroUsd === 0) stop('the recording ledger has no cap; nothing can run')
ledger.setConsent(projectId, 'nebius', true, 'session operator')
mkdirSync(recordingsDir, { recursive: true })
const navigator = new Navigator({
  services,
  gateway: new ProviderGateway({
    provider: new RecordingProvider(new NebiusProvider({ apiKey }), recordingsDir),
    ledger,
    roleModels: DEFAULT_ROLE_MODELS.nebius ?? {},
  }),
})
const started = navigator.start(caller, {
  kind: 'alternatives',
  projectId,
  request: idea,
  focus: [],
})
if (!started.ok) stop(started.error.message)
const run = await (started as Extract<typeof started, { ok: true }>).value.done
store.close()
rmSync(work, { recursive: true, force: true })
process.stdout.write(
  `session run: ${run.status}${run.error ? ` (${run.error.message})` : ''}, ${run.costMicroUsd} micro-USD; spent ${ledger.status().spentMicroUsd} of ${ledger.status().capMicroUsd}\n`,
)
if (run.status !== 'completed') process.exit(1)
