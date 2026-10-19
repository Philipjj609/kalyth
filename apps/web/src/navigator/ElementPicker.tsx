import { Plus, Search, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useWorkbench } from '../app/workbench.ts'
import { TypeLabel } from '../components/badges.tsx'
import { Button } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { shortId } from '../model/format.ts'
import { objectLabel } from '../model/labels.ts'
import { searchObjects } from '../model/search.ts'

const MATCHES = 8

/**
 * Picks elements from the records at the viewed revision: type to search, or add the record
 * selected in the Inspector. A combobox with a listbox, operable by keyboard alone.
 */
export function ElementPicker({
  value,
  onChange,
  max,
  disabled,
  describedBy,
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  max: number
  disabled?: boolean
  describedBy: string
}) {
  const wb = useWorkbench()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const chosen = useMemo(() => new Set(value), [value])
  const full = value.length >= max
  const matches = useMemo(() => {
    if (!wb.model) return []
    return searchObjects(wb.model.objects, query, MATCHES, chosen)
  }, [query, wb.model, chosen])
  const add = (id: string) => {
    if (chosen.has(id) || full) return
    onChange([...value, id])
    setQuery('')
    setActive(0)
  }
  const selected = wb.selection ? wb.model?.objectById.get(wb.selection) : undefined
  const showList = open && matches.length > 0 && !disabled

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul aria-label="Focus elements" className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const object = wb.model?.objectById.get(id)
            const name = object ? objectLabel(object) : shortId(id)
            return (
              <li
                key={id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 py-0.5 pr-0.5 pl-2 text-xs"
              >
                {object && <TypeLabel type={object.type} className="shrink-0 text-fg-muted" />}
                <span className="truncate font-medium" title={id}>
                  {name}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  aria-label={`Remove ${name} from the focus`}
                  className="rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg disabled:opacity-50"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="relative">
        <label className="relative flex items-center">
          <span className="sr-only">Find an element to focus on</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 size-4 text-fg-subtle"
          />
          <input
            type="search"
            role="combobox"
            aria-describedby={describedBy}
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && matches[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            value={query}
            disabled={disabled || full || !wb.model}
            placeholder={full ? `At most ${max} elements` : 'Find a module, endpoint, entity…'}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                setActive((a) => Math.min(a + 1, matches.length - 1))
                e.preventDefault()
              } else if (e.key === 'ArrowUp') {
                setActive((a) => Math.max(a - 1, 0))
                e.preventDefault()
              } else if (e.key === 'Enter') {
                // Enter picks a match; it never submits the change request by accident.
                e.preventDefault()
                if (matches[active]) add(matches[active].id)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            className="h-8 w-full rounded-md border border-border-strong bg-surface pr-2 pl-8 text-sm placeholder:text-fg-subtle disabled:bg-surface-2"
          />
        </label>
        {showList && (
          <div
            id={listId}
            role="listbox"
            aria-label="Matching elements"
            className="absolute top-9 right-0 left-0 z-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-pop"
          >
            {matches.map((o, i) => (
              <div
                key={o.id}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  add(o.id)
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm',
                  i === active && 'bg-accent-soft',
                )}
              >
                <TypeLabel type={o.type} className="w-24 shrink-0 text-fg-muted text-xs" />
                <span className="truncate">{objectLabel(o)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && !chosen.has(selected.id) && (
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2.5 max-w-full"
          disabled={disabled || full}
          onClick={() => add(selected.id)}
        >
          <Plus aria-hidden />
          <span className="truncate">Add the selected record: {objectLabel(selected)}</span>
        </Button>
      )}
    </div>
  )
}
