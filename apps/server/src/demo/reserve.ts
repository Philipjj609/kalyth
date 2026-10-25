import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KalythServices, SqliteStore } from '@kalyth/core'
import type { ProviderGateway } from '@kalyth/gateway'
import { Navigator } from '@kalyth/navigator'
import type { DemoTemplate } from './template.ts'

/** The model live alternatives runs use in the hosted demo (ADR 0019, live runs on Super). */
export const LIVE_ALTERNATIVES_MODEL = 'nvidia/nemotron-3-super-120b-a12b'

/**
 * The gateway's live models in the hosted demo: the presets replay recordings made with the
 * configured alternatives model (Nemotron Ultra), and anything unrecorded runs live on Nemotron
 * Super, whose worst case fits the daily allowance.
 */
export function demoLiveModels(
  roleModels: Readonly<Record<string, string>>,
): Record<string, string> {
  const recorded = roleModels.alternatives
  return recorded ? { [recorded]: LIVE_ALTERNATIVES_MODEL } : {}
}

/**
 * Room for what a visitor's own copy may add to the prompt: elements committed in the copy, and
 * a focus that leads with longer excerpts than the template's defaults.
 */
const COPY_MARGIN = 1.1

/**
 * What one live alternatives run in the demo may need left in a pool before it starts: the
 * gateway's worst case for its first call on the template, with the longest request the API
 * accepts (2,000 characters, at three UTF-8 bytes each), plus a margin for the visitor's copy.
 * The UI offers a live run only when a pool has this much left today; the gateway still checks
 * every call against the ledger. Computed on a scratch copy, so the template stays untouched.
 */
export function liveRunReserveMicroUsd(
  template: DemoTemplate,
  gateway: ProviderGateway,
  dir: string,
): number {
  const scratch = join(dir, 'reserve-estimate.db')
  copyFileSync(template.file, scratch)
  const store = new SqliteStore(scratch)
  try {
    const navigator = new Navigator({ services: new KalythServices({ store }), gateway })
    const worst = navigator.liveAlternativesReservationMicroUsd({
      projectId: template.projectId,
      request: '€'.repeat(2000),
      requestedBy: template.ownerId,
    })
    if (worst === null) throw new Error('no catalogued live model for alternatives')
    return Math.ceil(worst * COPY_MARGIN)
  } finally {
    store.close()
    rmSync(scratch, { force: true })
    rmSync(`${scratch}-wal`, { force: true })
    rmSync(`${scratch}-shm`, { force: true })
  }
}
