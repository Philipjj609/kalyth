import type { DecisionSummary, ObjectVersion } from '@kalyth/contracts'
import * as Popover from '@radix-ui/react-popover'
import {
  Cable,
  FoldVertical,
  Funnel,
  Info,
  LocateFixed,
  PenLine,
  Plus,
  Search,
  Trash2,
  UnfoldVertical,
} from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { LENSES, type Lens } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { EdgeSample, TypeLabel } from '../components/badges.tsx'
import { Button } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { objectLabel } from '../model/labels.ts'
import { searchObjects } from '../model/search.ts'
import { withoutHandles } from '../views/shared.tsx'
import { relationColor } from './edges.tsx'
import type { EditKind } from './edit.tsx'
import type { GraphPrefs } from './GraphView.tsx'
import { alternativeKey, type chooseAlternative, type Hops, LENS_LABEL } from './lens.ts'
import { OFF_CANVAS_TYPES, type Projection, type typeCounts } from './projection.ts'

/**
 * The canvas toolbar: lens, the alternative shown, focus around the selection, find, filters and
 * layout controls, and the edits that create proposals. Exclusive choices are toggle buttons with
 * aria-pressed inside a labelled group; it wraps at any width.
 */

function Segment<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: readonly { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 border border-border-strong bg-surface"
    >
      {options.map((o, i) => {
        const pressed = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={pressed}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 px-2.5 text-xs',
              i > 0 && 'border-border-strong border-l',
              pressed ? 'bg-fg text-bg' : 'text-fg hover:bg-surface-2',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const Divider = () => <span aria-hidden className="h-5 w-px bg-border" />

export function GraphToolbar({
  lens,
  onLens,
  decisions,
  chosen,
  onAlternative,
  projection,
  prefs,
  setPrefs,
  counts,
  onReveal,
  onFit,
  canEdit,
  selected,
  canRename,
  onEdit,
  hasSelection,
}: {
  lens: Lens
  onLens: (lens: Lens) => void
  decisions: readonly DecisionSummary[]
  chosen: ReturnType<typeof chooseAlternative>
  onAlternative: (id: string) => void
  projection: Projection
  prefs: GraphPrefs
  setPrefs: (update: (p: GraphPrefs) => GraphPrefs) => void
  counts: ReturnType<typeof typeCounts>
  onReveal: (id: string) => void
  onFit: () => void
  canEdit: boolean
  selected: ObjectVersion | undefined
  canRename: boolean
  onEdit: (kind: EditKind) => void
  hasSelection: boolean
}) {
  const hidden = prefs.hiddenObjectTypes.size + prefs.hiddenRelationTypes.size
  const isOpenNow = (id: string) =>
    prefs.expanded.has(id) || (projection.defaultOpen.has(id) && !prefs.collapsed.has(id))
  const allExpanded = projection.expandable.length > 0 && projection.expandable.every(isOpenNow)
  const decisionSelect = useId()
  const systems = useMemo(
    () =>
      new Set(
        projection.nodes
          .filter((n) => n.kind === 'group' && n.object.type === 'software.System')
          .map((n) => n.id),
      ),
    [projection],
  )
  return (
    <div className="flex shrink-0 flex-col gap-2 border-border border-b bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] text-fg-subtle uppercase tracking-[0.08em]">
          Lens
        </span>
        <Segment
          label="Lens"
          value={lens}
          options={LENSES.map((l) => ({ value: l, label: LENS_LABEL[l] }))}
          onChange={onLens}
        />
        {lens === 'impact' && decisions.length > 1 && (
          <label htmlFor={decisionSelect} className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="sr-only">Decision</span>
            <select
              id={decisionSelect}
              value={chosen?.decision.id ?? ''}
              onChange={(e) => {
                const d = decisions.find((x) => x.id === e.target.value)
                const alt =
                  d?.alternatives.find((a) => a.status === 'accepted') ?? d?.alternatives[0]
                if (alt) onAlternative(alt.id)
              }}
              className="select-control h-7 max-w-[260px] truncate rounded-sm border border-border-strong bg-surface pl-2 text-xs"
            >
              {decisions.map((d, i) => (
                <option key={d.id} value={d.id}>
                  D{i + 1} · {withoutHandles(d.title)} ({d.status})
                </option>
              ))}
            </select>
          </label>
        )}
        {lens === 'impact' && chosen && (
          <Segment
            label={`Alternative of “${chosen.decision.title}”`}
            value={chosen.alternative.id}
            options={chosen.decision.alternatives.map((a, i) => ({
              value: a.id,
              label: <span className="font-mono">{alternativeKey(i)}</span>,
              title: `${withoutHandles(a.title)} (${a.status})`,
            }))}
            onChange={onAlternative}
          />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segment<Hops>
            label="Focus around the selection"
            value={prefs.hops}
            options={[
              { value: 0, label: 'All' },
              { value: 1, label: '1 hop', title: 'Dim everything more than one relation away' },
              { value: 2, label: '2 hops', title: 'Dim everything more than two relations away' },
            ]}
            onChange={(hops) => setPrefs((p) => ({ ...p, hops }))}
          />
          {prefs.hops > 0 && !hasSelection && (
            <span className="text-fg-subtle text-xs">Select an element to focus</span>
          )}
          {canEdit && (
            <Button
              size="sm"
              onClick={() => onEdit('add')}
              aria-label="Add an element (creates a proposal)"
            >
              <Plus aria-hidden /> Element
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <GraphSearch onReveal={onReveal} />
        <FilterMenu counts={counts} prefs={prefs} setPrefs={setPrefs} hidden={hidden} />
        <Divider />
        <Button
          size="sm"
          variant="ghost"
          disabled={projection.expandable.length === 0}
          onClick={() =>
            setPrefs((p) =>
              allExpanded
                ? {
                    ...p,
                    expanded: new Set(),
                    collapsed: new Set(
                      [...projection.defaultOpen].filter((id) => !systems.has(id)),
                    ),
                  }
                : { ...p, expanded: new Set(projection.expandable), collapsed: new Set() },
            )
          }
        >
          {allExpanded ? <FoldVertical aria-hidden /> : <UnfoldVertical aria-hidden />}
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onFit}>
          <LocateFixed aria-hidden /> Fit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={prefs.legend}
          onClick={() => setPrefs((p) => ({ ...p, legend: !p.legend }))}
        >
          <Info aria-hidden /> Legend
        </Button>
        {selected && (
          <>
            <Divider />
            {/* biome-ignore lint/a11y/useSemanticElements: a toolbar group, not a form fieldset */}
            <div
              role="group"
              aria-label={`Edit ${objectLabel(selected)}`}
              className="flex flex-wrap items-center gap-1"
            >
              <span
                className="max-w-[180px] truncate text-fg-muted text-xs"
                title={objectLabel(selected)}
              >
                {objectLabel(selected)}:
              </span>
              {canRename && (
                <Button size="sm" variant="ghost" onClick={() => onEdit('rename')}>
                  <PenLine aria-hidden /> Rename
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onEdit('connect')}>
                <Cable aria-hidden /> Connect to
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit('retire')}>
                <Trash2 aria-hidden /> Retire
              </Button>
            </div>
          </>
        )}
        <p className="ml-auto text-fg-muted text-xs tabular-nums">
          {projection.nodes.length} nodes · {projection.edges.length} edges
          <span className="text-fg-subtle">
            {' '}
            for {projection.stats.objects} elements
            {projection.stats.hiddenObjects + projection.stats.hiddenRelations > 0 &&
              ` · ${projection.stats.hiddenObjects + projection.stats.hiddenRelations} filtered`}
          </span>
        </p>
      </div>
    </div>
  )
}

function GraphSearch({ onReveal }: { onReveal: (id: string) => void }) {
  const wb = useWorkbench()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const matches = useMemo(() => {
    if (!wb.model) return []
    return searchObjects(
      wb.model.objects.filter((o) => !OFF_CANVAS_TYPES.has(o.type)),
      query,
      8,
    )
  }, [query, wb.model])
  const choose = (id: string) => {
    onReveal(id)
    setOpen(false)
  }
  return (
    <div className="relative">
      <label className="relative flex items-center">
        <span className="sr-only">Find an element</span>
        <Search aria-hidden className="pointer-events-none absolute left-2 size-4 text-fg-subtle" />
        <input
          data-view-search
          type="search"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          value={query}
          placeholder="Find and focus an element  /"
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
            } else if (e.key === 'Enter' && matches[active]) {
              choose(matches[active].id)
              e.preventDefault()
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          className="h-7 w-60 rounded-sm border border-border-strong bg-surface pr-2 pl-8 text-xs placeholder:text-fg-subtle"
        />
      </label>
      {open && matches.length > 0 && (
        <div
          id={listId}
          role="listbox"
          aria-label="Matching elements"
          className="absolute top-8 left-0 z-40 w-80 overflow-hidden border border-border bg-surface py-1 shadow-pop"
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
                choose(o.id)
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
  )
}

function FilterMenu({
  counts,
  prefs,
  setPrefs,
  hidden,
}: {
  counts: ReturnType<typeof typeCounts>
  prefs: GraphPrefs
  setPrefs: (update: (p: GraphPrefs) => GraphPrefs) => void
  hidden: number
}) {
  const toggle = (key: 'hiddenObjectTypes' | 'hiddenRelationTypes', type: string) =>
    setPrefs((p) => {
      const next = new Set(p[key])
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return { ...p, [key]: next }
    })
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant={hidden > 0 ? 'primary' : 'secondary'}>
          <Funnel aria-hidden /> Filter
          {hidden > 0 && <span className="tabular-nums">· {hidden} hidden</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 grid w-[min(520px,calc(100vw-2rem))] grid-cols-2 gap-4 border border-border bg-surface p-3 shadow-pop"
        >
          <fieldset className="min-w-0">
            <legend className="mb-1.5 font-mono text-[10.5px] text-fg-subtle uppercase tracking-[0.08em]">
              Element types
            </legend>
            <ul className="space-y-0.5">
              {counts.objectTypes.map(([type, n]) => (
                <li key={type}>
                  <label className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--k-accent)]"
                      checked={!prefs.hiddenObjectTypes.has(type)}
                      onChange={() => toggle('hiddenObjectTypes', type)}
                    />
                    <TypeLabel type={type} className="min-w-0 flex-1 text-sm" />
                    <span className="font-mono text-fg-subtle text-xs tabular-nums">{n}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 font-mono text-[10.5px] text-fg-subtle uppercase tracking-[0.08em]">
              Relation types
            </legend>
            <ul className="space-y-0.5">
              {counts.relationTypes.map(([type, n]) => (
                <li key={type}>
                  <label className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--k-accent)]"
                      checked={!prefs.hiddenRelationTypes.has(type)}
                      onChange={() => toggle('hiddenRelationTypes', type)}
                    />
                    <EdgeSample color={relationColor(type)} dash={undefined} width={16} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{type}</span>
                    <span className="font-mono text-fg-subtle text-xs tabular-nums">{n}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-2xs text-fg-subtle">
              Hiding <span className="font-mono">contains</span> hides its edges; nesting stays.
              Decisions and questions live in change threads, not on the canvas.
            </p>
          </fieldset>
          <label className="col-span-2 flex cursor-pointer items-start gap-2 border-border border-t px-1 pt-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 accent-[var(--k-accent)]"
              checked={prefs.imports}
              onChange={() => setPrefs((p) => ({ ...p, imports: !p.imports }))}
            />
            <span>
              Draw every import between members of a container
              <span className="block text-fg-subtle text-xs">
                Off: imports inside a container are drawn for the selected element only, so the
                structure and data access stay readable.
              </span>
            </span>
          </label>
          <div className="col-span-2 flex justify-end gap-2 border-border border-t pt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setPrefs((p) => ({
                  ...p,
                  hiddenObjectTypes: new Set(),
                  hiddenRelationTypes: new Set(),
                }))
              }
            >
              Show everything
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
