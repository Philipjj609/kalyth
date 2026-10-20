import { Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useDecisions, useNavigatorRuns, useProposals } from '../api/queries.ts'
import { changeItems, openQuestions } from '../change/model.ts'
import { Kbd } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { objectLabel } from '../model/labels.ts'
import { searchObjects } from '../model/search.ts'
import { objectTypeMeta } from '../model/semantics.ts'
import { type AppLocation, LENSES, useAppLocation } from './location.ts'
import { PLACES } from './Rail.tsx'
import { theme } from './theme.ts'
import { useWorkbench } from './workbench.ts'

interface Action {
  id: string
  group: string
  label: string
  hint?: string
  run: () => void
}

const LENS_LABEL = {
  basis: 'claim basis',
  freshness: 'freshness',
  impact: 'impact',
  decisions: 'decisions',
}

/**
 * Every action in one place, reachable from the keyboard (ADR 0020): places, canvas lenses, the
 * changes in flight and the model's elements. Ctrl+K or Cmd+K opens it from anywhere.
 */
export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wb = useWorkbench()
  const [, navigate] = useAppLocation()
  const decisions = useDecisions(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId)
  const proposals = useProposals(wb.projectId)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const labelId = useId()

  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) {
      setQuery('')
      setActive(0)
      d.showModal()
      input.current?.focus()
    } else if (!open && d.open) d.close()
  }, [open])

  const actions = useMemo((): Action[] => {
    const go = (to: Partial<AppLocation>) => () => navigate(to)
    const places: Action[] = PLACES.map((p) => ({
      id: `place:${p.view}`,
      group: 'Go to',
      label: p.label,
      run: go(
        p.view === 'change'
          ? { view: 'change', decision: undefined, run: undefined }
          : { view: p.view },
      ),
    }))
    const lenses: Action[] = LENSES.map((lens) => ({
      id: `lens:${lens}`,
      group: 'Canvas',
      label: `Show the canvas by ${LENS_LABEL[lens]}`,
      run: go({ view: 'graph', lens }),
    }))
    const changes: Action[] = changeItems(
      decisions.data?.decisions ?? [],
      runs.data?.runs ?? [],
      proposals.data?.proposals ?? [],
      (id) => openQuestions(wb.model, id).length,
    ).map((c) => ({
      id: `change:${c.ref.id}`,
      group: 'Changes',
      label: c.title,
      hint: c.status,
      run: go(
        c.ref.kind === 'decision'
          ? { view: 'change', decision: c.ref.id, run: undefined }
          : { view: 'change', run: c.ref.id, decision: undefined },
      ),
    }))
    const other: Action[] = [
      {
        id: 'theme',
        group: 'Settings',
        label: 'Switch between light and dark',
        run: () => theme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
      },
    ]
    return [...places, ...changes, ...lenses, ...other]
  }, [navigate, decisions.data, runs.data, proposals.data, wb.model])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = q
      ? actions.filter(
          (a) => a.label.toLowerCase().includes(q) || a.group.toLowerCase().includes(q),
        )
      : actions.filter((a) => a.group !== 'Canvas')
    const elements: Action[] =
      q && wb.model
        ? searchObjects(wb.model.objects, query, 6).map((o) => ({
            id: `element:${o.id}`,
            group: 'Elements',
            label: objectLabel(o),
            hint: objectTypeMeta(o.type).label,
            run: () => {
              navigate({ view: 'graph' })
              wb.select(o.id)
            },
          }))
        : []
    return [...elements, ...matching].slice(0, 40)
  }, [actions, query, wb.model, navigate, wb])

  const choose = (a: Action | undefined) => {
    if (!a) return
    onClose()
    a.run()
  }
  const activeId = shown[active] ? `${listId}-${active}` : undefined

  return (
    <dialog
      ref={dialog}
      aria-labelledby={labelId}
      onClose={onClose}
      className="mx-auto mt-[12vh] w-[min(640px,calc(100vw-2rem))] border border-fg bg-surface p-0 text-fg shadow-pop"
    >
      <h2 id={labelId} className="sr-only">
        Search or run a command
      </h2>
      <div className="flex items-center gap-2 border-border border-b px-3">
        <Search aria-hidden className="size-4 text-fg-subtle" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label="Search elements, changes or actions"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              setActive((i) => Math.min(i + 1, shown.length - 1))
              e.preventDefault()
            } else if (e.key === 'ArrowUp') {
              setActive((i) => Math.max(i - 1, 0))
              e.preventDefault()
            } else if (e.key === 'Enter') {
              choose(shown[active])
              e.preventDefault()
            }
          }}
          placeholder="Search elements, changes or actions…"
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        className="max-h-[50vh] overflow-y-auto py-1 scrollbar-thin"
      >
        {shown.length === 0 && <p className="px-4 py-3 text-fg-muted">Nothing matches.</p>}
        {shown.map((a, i) => (
          <div
            key={a.id}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(a)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') choose(a)
            }}
            className={cn(
              'flex cursor-pointer items-baseline gap-3 px-4 py-2',
              i === active && 'bg-accent-soft',
            )}
          >
            <span className="k-eyebrow w-20 shrink-0">{a.group}</span>
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            {a.hint && <span className="shrink-0 text-fg-muted text-xs">{a.hint}</span>}
          </div>
        ))}
      </div>
    </dialog>
  )
}
