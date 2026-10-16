import { X } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react'
import { cn } from '../lib/cn.ts'
import type { Tone } from '../model/semantics.ts'

/** Short-lived outcome notices (commit, reject), announced politely to screen readers. */
export interface ToastInput {
  tone: Tone
  title: string
  body?: string
}

interface Toast extends ToastInput {
  id: number
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

const LIFETIME_MS = 7000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const notify = useCallback(
    (toast: ToastInput) => {
      const id = next.current++
      setToasts((t) => [...t.slice(-3), { ...toast, id }])
      window.setTimeout(() => dismiss(id), LIFETIME_MS)
    },
    [dismiss],
  )
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <section
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[360px] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              `tone-${t.tone}`,
              'pointer-events-auto flex items-start gap-2 rounded-lg border border-tone-bd bg-surface p-3 shadow-pop',
            )}
          >
            <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-tone-fg" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm text-tone-fg">{t.title}</p>
              {t.body && <p className="mt-0.5 line-clamp-2 text-fg-muted text-xs">{t.body}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        ))}
      </section>
    </ToastContext.Provider>
  )
}
