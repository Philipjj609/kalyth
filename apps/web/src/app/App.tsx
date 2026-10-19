import { QueryClientProvider } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { createQueryClient } from '../api/queries.ts'
import { ToastProvider } from '../components/toast.tsx'
import { Button, Spinner, TooltipProvider } from '../components/ui.tsx'
import { Shell } from './Shell.tsx'
import { type SessionState, session, useSessionState } from './session.ts'

const queryClient = createQueryClient()

export function App() {
  const state = useSessionState()
  // Drop everything fetched under a session the server no longer accepts.
  useEffect(() => {
    if (state !== 'ok') queryClient.clear()
  }, [state])
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          {state === 'ok' ? (
            <Shell />
          ) : state === 'starting' ? (
            <StartingScreen />
          ) : state === 'unavailable' ? (
            <DemoUnavailable />
          ) : (
            <SessionScreen state={state} />
          )}
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** While the page finds out whether this is the hosted demo, and starts a demo session if so. */
function StartingScreen() {
  return (
    <main className="flex h-full items-center justify-center bg-bg p-6">
      <Spinner label="Starting Kalyth" />
    </main>
  )
}

/** The hosted demo could not start a session, for example after too many from one address. */
function DemoUnavailable() {
  return (
    <main className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-pop">
        <h1 className="mb-2 font-semibold text-[17px]">The demo could not start</h1>
        <p className="text-fg-muted">
          Kalyth could not start your copy of the demo project: {session.problem()}.
        </p>
        <Button variant="primary" className="mt-4" onClick={() => session.retry()}>
          Try again
        </Button>
      </div>
    </main>
  )
}

/**
 * Shown when there is no session token, or the server refused it (it changes on every launch).
 * The usual path is the link the server prints; pasting the token is the fallback.
 */
function SessionScreen({ state }: { state: SessionState }) {
  const [value, setValue] = useState('')
  const inputId = useId()
  return (
    <main className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-pop">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound aria-hidden className="size-5 text-fg-subtle" />
          <h1 className="font-semibold text-[17px]">
            {state === 'rejected' ? 'Session expired' : 'Open Kalyth from the server link'}
          </h1>
        </div>
        <p className="text-fg-muted">
          {state === 'rejected'
            ? 'The server did not accept this session. It issues a new token every time it starts.'
            : 'The local server prints a link with a session token when it starts.'}{' '}
          Open the link it printed:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs">
          kalyth ui: {window.location.origin}/#token=…
        </pre>
        <form
          className="mt-5 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) {
              session.use(value)
            }
          }}
        >
          <label htmlFor={inputId} className="block font-medium text-xs">
            Or paste the session token
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 font-mono text-sm"
            />
            <Button type="submit" variant="primary" disabled={!value.trim()}>
              Continue
            </Button>
          </div>
          <p className="text-fg-subtle text-xs">
            The token stays in this tab only and is sent to this server only.
          </p>
        </form>
      </div>
    </main>
  )
}
