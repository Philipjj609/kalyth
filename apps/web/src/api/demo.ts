import type { StartRunBody } from './client.ts'

/** A preset change request or summary in the hosted demo (ADR 0019). */
export interface DemoPreset {
  id: string
  label: string
  /** The run input, with the template's ids; the project id is in it. */
  input: StartRunBody & { projectId: string }
  /** Recorded once against Nebius, so it runs at no cost and without the allowance. */
  recorded: boolean
}

/** What the hosted demo says about this visitor's session (GET /api/v1/demo/session). */
export interface DemoView {
  projectId: string
  judge: boolean
  judgeCodeAvailable: boolean
  live: {
    /** A live provider is configured and consented to. */
    available: boolean
    pool: 'public' | 'judges'
    runsLeftToday: number
    runsPerDay: number
    poolRemainingTodayMicroUsd: number
    /** What the pool must have left for one live run's worst case; less, and none is offered. */
    runReserveMicroUsd: number
    /** The model live runs use, e.g. nvidia/nemotron-3-super-120b-a12b. */
    model: string | null
  }
  presets: DemoPreset[]
  mcp: false
}

/** Whether a live run could start now, and if not, why, in words for the page. */
export function liveRunState(view: DemoView): { ok: boolean; reason: string } {
  if (!view.live.available) {
    return { ok: false, reason: 'Live runs are off in this demo; recorded runs work.' }
  }
  if (view.live.runsLeftToday === 0) {
    return {
      ok: false,
      reason: `You have used today’s ${view.live.runsPerDay} live runs; recorded runs still work.`,
    }
  }
  // A run is offered only if its worst case fits what the pool has left today, as the gateway
  // will check before calling the model.
  const reserve = Math.max(1, view.live.runReserveMicroUsd)
  if (view.live.poolRemainingTodayMicroUsd < reserve) {
    return {
      ok: false,
      reason:
        view.live.pool === 'judges'
          ? 'The judges’ allowance for today is used up; recorded runs still work.'
          : 'Today’s public allowance for live runs is used up; recorded runs still work. Judges have their own allowance.',
    }
  }
  return { ok: true, reason: '' }
}

/** A model id as people say it: nvidia/nemotron-3-super-120b-a12b is "Nemotron 3 Super". */
export function modelName(id: string | null): string {
  const size = /nemotron-3-(ultra|super|nano)/i.exec(id ?? '')?.[1]
  if (!size) return id ?? 'Nemotron'
  return `Nemotron 3 ${size[0]?.toUpperCase()}${size.slice(1).toLowerCase()}`
}

/** The input to send for a preset: the project id travels in the path. */
export function presetBody(preset: DemoPreset): StartRunBody {
  const { projectId: _projectId, ...body } = preset.input
  return body as StartRunBody
}
