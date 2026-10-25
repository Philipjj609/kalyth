import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KalythServices, SqliteStore } from '@kalyth/core'
import type { LiveModel, ProviderGateway } from '@kalyth/gateway'
import { Navigator } from '@kalyth/navigator'
import type { DemoTemplate } from './template.ts'

/**
 * How live alternatives runs answer in the hosted demo (ADR 0019, live runs on Super): Nemotron
 * Super, whose worst case fits the daily allowance, reasoning within a budget. Unbounded, Super
 * spent its whole output on thinking and cut its answer off (KAL-20261025-056); with reasoning
 * off, its alternatives were much weaker (KAL-20261025-057). The output cap bounds the cost
 * whether or not the provider enforces the budget, and keeps the worst case within the judges'
 * daily allowance.
 */
export const DEMO_LIVE: LiveModel = {
  model: 'nvidia/nemotron-3-super-120b-a12b',
  reasoning: true,
  reasoningBudget: 8_000,
  maxOutputTokens: 14_000,
}
export const LIVE_ALTERNATIVES_MODEL = DEMO_LIVE.model

/**
 * Live runs make one attempt. A corrective retry would resend the rejected answer, and its worst
 * case would not fit a day's allowance, so the UI could not honestly offer a run that needs one.
 * An answer that fails the schema still proposes nothing.
 */
export const DEMO_LIVE_CORRECTIONS = 0

/**
 * The live pools' gateway options in the hosted demo: the presets replay recordings made with the
 * configured alternatives model (Nemotron Ultra), and anything unrecorded runs live as DEMO_LIVE.
 */
export function demoLiveGatewayOptions(roleModels: Readonly<Record<string, string>>): {
  liveModels: Record<string, LiveModel>
  maxCorrections: number
} {
  const recorded = roleModels.alternatives
  return {
    liveModels: recorded ? { [recorded]: DEMO_LIVE } : {},
    maxCorrections: DEMO_LIVE_CORRECTIONS,
  }
}

/**
 * Room for what a visitor's own copy may add to the prompt: elements committed in the copy, and
 * a focus that leads with longer excerpts than the template's defaults.
 */
const COPY_MARGIN = 1.1

/**
 * What one live alternatives run in the demo may need left in a pool before it starts: the
 * gateway's worst case for its call on the template, with the longest request the API accepts
 * (2,000 characters, at three UTF-8 bytes each), plus a margin for the visitor's copy. It covers
 * the whole run only because live runs make no corrective retry, so a gateway that would retry is
 * refused. The UI offers a live run only when a pool has this much left today; the gateway still
 * checks every call against the ledger. Computed on a scratch copy; the template stays untouched.
 */
export function liveRunReserveMicroUsd(
  template: DemoTemplate,
  gateway: ProviderGateway,
  dir: string,
): number {
  if (gateway.maxCorrections > 0) {
    throw new Error('the live reserve covers one attempt; the live gateway must not retry')
  }
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
