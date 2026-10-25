import { FlaskConical, KeyRound } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { liveRunState, modelName } from '../api/demo.ts'
import { useDemoSession, useEnterJudgeCode } from '../api/queries.ts'
import { Button, Spinner } from '../components/ui.tsx'
import { plural } from '../model/format.ts'
import { ErrorNotice } from '../views/shared.tsx'
import { session, useSessionMode } from './session.ts'

/**
 * What a visitor to the hosted demo needs to know (ADR 0019): this is their own copy, what runs
 * cost them, and, for judges, how to use their own allowance.
 */
export function DemoBanner() {
  const mode = useSessionMode()
  const demo = useDemoSession()
  const [judging, setJudging] = useState(false)
  if (mode !== 'demo') return null
  const view = demo.data
  return (
    <section
      aria-label="About this demo"
      className="tone-accent flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-tone-bd border-b bg-tone-bg px-3 py-1.5 text-tone-fg text-xs"
    >
      <FlaskConical aria-hidden className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">Hosted demo.</span> This is your own copy of the analysed
        FastAPI template; nothing you change reaches anyone else, and it is kept while you use it.
        {session.demoRestarted() && ' Your earlier copy had expired, so this is a fresh one.'}{' '}
        {view &&
          (liveRunState(view).ok
            ? `Recorded Nemotron runs are free; you have ${plural(view.live.runsLeftToday, 'live run')} left today, on ${modelName(view.live.model)}.`
            : view.live.available
              ? 'Recorded Nemotron runs are free; no live run can start now.'
              : 'Recorded Nemotron runs are free; live runs are off.')}{' '}
        Agent access over MCP is off here.
      </p>
      {view?.judge ? (
        <span className="inline-flex items-center gap-1 font-medium">
          <KeyRound aria-hidden className="size-3.5" /> Judges’ allowance
        </span>
      ) : (
        view?.judgeCodeAvailable && (
          <Button size="sm" variant="secondary" onClick={() => setJudging(true)}>
            <KeyRound aria-hidden /> I have a judge code
          </Button>
        )
      )}
      <JudgeDialog open={judging} onClose={() => setJudging(false)} />
    </section>
  )
}

function JudgeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [code, setCode] = useState('')
  const enter = useEnterJudgeCode()
  const titleId = useId()
  const inputId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-xl border border-border bg-surface p-0 text-fg shadow-pop backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          enter.mutate(code, {
            onSuccess: () => {
              setCode('')
              onClose()
            },
          })
        }}
      >
        <h2 id={titleId} className="font-semibold text-[15px]">
          Judge code
        </h2>
        <p className="text-fg-muted text-sm">
          The code in the Devpost testing instructions gives this copy the judges’ own allowance of
          live Nemotron runs, so other visitors cannot use it up. Everything else works without it.
        </p>
        <div className="space-y-1">
          <label htmlFor={inputId} className="block font-medium text-xs">
            Code
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 font-mono text-sm"
          />
        </div>
        {enter.isError && <ErrorNotice error={enter.error} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => ref.current?.close()} disabled={enter.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!code.trim() || enter.isPending}>
            {enter.isPending && <Spinner label="Checking the code" />}
            Use the code
          </Button>
        </div>
      </form>
    </dialog>
  )
}
