import type { NavigatorRun } from '@kalyth/contracts'
import { Play } from 'lucide-react'
import { liveRunState, modelName, presetBody } from '../api/demo.ts'
import { useDemoSession, useStartNavigatorRun } from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { StatusBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, Panel, Spinner } from '../components/ui.tsx'
import { plural } from '../model/format.ts'
import { ErrorNotice } from '../views/shared.tsx'
import { Usd } from './RunReport.tsx'

/**
 * The hosted demo's preset requests (ADR 0019). A recorded preset replays a real Nemotron run made
 * once against Nebius, at no cost; the others run live and count against today's allowance.
 */
export function DemoPresets({ runs }: { runs: readonly NavigatorRun[] | undefined }) {
  const wb = useWorkbench()
  const [, navigate] = useAppLocation()
  const notify = useToast()
  const demo = useDemoSession()
  const start = useStartNavigatorRun(wb.projectId)
  const view = demo.data
  if (!view) return null
  const busy = start.isPending || (runs ?? []).some((r) => r.status === 'running')
  const live = liveRunState(view)
  return (
    <Panel
      title="Try a change request"
      aside={<span className="text-fg-subtle text-xs">hosted demo</span>}
    >
      <div className="space-y-3 p-4">
        <p className="text-fg-muted text-xs">
          Recorded runs replay a real Nemotron 3 Ultra answer recorded on this same project, so they
          cost nothing and never wait for the allowance. A live run asks{' '}
          {modelName(view.live.model)} on Nebius now.
        </p>
        <ul className="space-y-2">
          {view.presets.map((preset) => (
            <li key={preset.id} className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || (!preset.recorded && !live.ok)}
                onClick={() =>
                  start.mutate(presetBody(preset), {
                    onSuccess: (run) => {
                      // As with a request typed by hand: alternatives open their change thread,
                      // which follows the run; a summary, or a run that failed at once, stays here.
                      navigate(
                        run.input.kind === 'alternatives' && run.status !== 'failed'
                          ? { view: 'change', run: run.id, decision: undefined }
                          : { run: run.id },
                      )
                      notify({
                        tone: run.status === 'failed' ? 'danger' : 'neutral',
                        title:
                          run.status === 'failed'
                            ? 'The run did not start'
                            : preset.recorded
                              ? 'Replaying the recorded run'
                              : 'Live run started',
                        body: preset.label,
                      })
                    },
                  })
                }
              >
                <Play aria-hidden /> {preset.label}
              </Button>
              <StatusBadge
                size="sm"
                tone={preset.recorded ? 'success' : 'warning'}
                label={preset.recorded ? 'Recorded, free' : 'Live'}
                description={
                  preset.recorded
                    ? 'Replays a Nemotron run recorded on this project'
                    : 'Asks Nemotron now and counts as one of your live runs'
                }
                prefix="Run:"
              />
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-border border-t pt-3 text-xs">
          <dt className="text-fg-muted">Your live runs left today</dt>
          <dd>
            {view.live.available
              ? `${view.live.runsLeftToday} of ${view.live.runsPerDay}`
              : 'none: live runs are off'}
          </dd>
          <dt className="text-fg-muted">
            {view.live.pool === 'judges' ? 'Judges’ allowance' : 'Public allowance'} left today
          </dt>
          <dd>
            <Usd micro={view.live.poolRemainingTodayMicroUsd} />
          </dd>
        </dl>
        {!live.ok && <p className="text-fg-muted text-xs">{live.reason}</p>}
        {busy && start.isPending && <Spinner label="Starting the run" />}
        {start.isError && <ErrorNotice error={start.error} />}
        <p className="text-fg-subtle text-xs">
          A request you write yourself runs live, and counts as one of your{' '}
          {plural(view.live.runsPerDay, 'live run')} a day.
        </p>
      </div>
    </Panel>
  )
}
