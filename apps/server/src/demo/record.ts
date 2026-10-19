import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KalythServices, SqliteStore } from '@kalyth/core'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  NebiusProvider,
  ProviderGateway,
  RecordingProvider,
} from '@kalyth/gateway'
import { Navigator } from '@kalyth/navigator'
import { buildTemplate } from './template.ts'

// Records the demo's preset runs against Nebius, once (ADR 0019, amendment 5): `pnpm demo:record`.
// It SPENDS MONEY, so it runs only when Philip has approved it and set the cap of its own ledger:
//
//   KALYTH_LEDGER=<recording ledger> pnpm budget set 0.30 --note "<approval entry>"
//   KALYTH_DEMO_RECORDING_LEDGER=<recording ledger> KALYTH_NEBIUS_API_KEY=... \
//     KALYTH_DEMO_NEBIUS_CONSENT=<template project id> pnpm demo:record
//
// Each preset runs in a fresh copy of the template, as a visitor's would, and its exchanges are
// written to deploy/demo/recordings. The ledger's cap stops it like any other run.

const env = process.env
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const stop = (message: string): never => {
  process.stderr.write(`demo:record: ${message}\n`)
  process.exit(2)
}
const apiKey = env.KALYTH_NEBIUS_API_KEY ?? stop('KALYTH_NEBIUS_API_KEY is not set')
const ledgerPath =
  env.KALYTH_DEMO_RECORDING_LEDGER ?? stop('KALYTH_DEMO_RECORDING_LEDGER is not set')
const recordingsDir = resolve(env.KALYTH_DEMO_RECORDINGS ?? join(repo, 'deploy/demo/recordings'))
const work = mkdtempSync(join(tmpdir(), 'kalyth-record-'))
const template = buildTemplate({
  exportFile: resolve(env.KALYTH_DEMO_TEMPLATE ?? join(repo, 'deploy/demo/template.json')),
  dir: work,
})
if (env.KALYTH_DEMO_NEBIUS_CONSENT !== template.projectId) {
  stop(`set KALYTH_DEMO_NEBIUS_CONSENT=${template.projectId} to consent for the template project`)
}
const ledger = new BudgetLedger(resolve(ledgerPath))
if (ledger.status().capMicroUsd === 0) stop('the recording ledger has no cap; nothing can run')
ledger.setConsent(template.projectId, 'nebius', true, 'demo operator')
const gateway = new ProviderGateway({
  provider: new RecordingProvider(new NebiusProvider({ apiKey }), recordingsDir),
  ledger,
  roleModels: DEFAULT_ROLE_MODELS.nebius ?? {},
})
mkdirSync(recordingsDir, { recursive: true })

const recorded: { id: string; recordedAt: string; status: string; costMicroUsd: number }[] = []
for (const preset of template.presets) {
  const file = join(work, `${preset.id}.db`)
  copyFileSync(template.file, file)
  const store = new SqliteStore(file)
  const navigator = new Navigator({ services: new KalythServices({ store }), gateway })
  const started = navigator.start({ principalId: template.ownerId, origin: 'human' }, preset.input)
  if (!started.ok) stop(`${preset.id}: ${started.error.message}`)
  const run = await (started as Extract<typeof started, { ok: true }>).value.done
  store.close()
  process.stdout.write(
    `${preset.id}: ${run.status}${run.error ? ` (${run.error.message})` : ''}, ${run.costMicroUsd} micro-USD\n`,
  )
  if (run.status === 'completed') {
    recorded.push({
      id: preset.id,
      recordedAt: run.finishedAt ?? run.startedAt,
      status: run.status,
      costMicroUsd: run.costMicroUsd,
    })
  }
}
writeFileSync(join(recordingsDir, 'presets.json'), `${JSON.stringify(recorded, null, 2)}\n`)
const after = ledger.status()
process.stdout.write(
  `recorded ${recorded.length} of ${template.presets.length} presets; spent ${after.spentMicroUsd} micro-USD of ${after.capMicroUsd}\n`,
)
ledger.close()
rmSync(work, { recursive: true, force: true })
