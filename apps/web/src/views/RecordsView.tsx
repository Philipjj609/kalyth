import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from 'lucide-react'
import { type ReactNode, useDeferredValue, useMemo, useState } from 'react'
import { FRESHNESS_STATUSES } from '../api/freshness.ts'
import { useRevisionModel } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  BasisBadge,
  ConfidenceBadge,
  FreshnessBadge,
  LifecycleBadge,
  StanceBadge,
  TypeLabel,
} from '../components/badges.tsx'
import { Button, EmptyState, Segmented, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { shortId } from '../model/format.ts'
import {
  ALL,
  buildRows,
  DEFAULT_FILTERS,
  filterRows,
  type RecordFilters,
  type RecordRow,
  type SortDirection,
  type SortKey,
  sortRows,
} from '../model/records.ts'
import { BASIS_META, BASIS_ORDER, compareTypes, FRESHNESS_META } from '../model/semantics.ts'
import { ErrorNotice } from './shared.tsx'

const PAGE = 300

export function RecordsView() {
  const wb = useWorkbench()
  const [filters, setFilters] = useState<RecordFilters>(DEFAULT_FILTERS)
  const [includeRetired, setIncludeRetired] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({
    key: 'type',
    dir: 'asc',
  })
  const [limit, setLimit] = useState(PAGE)
  const retired = useRevisionModel(includeRetired ? wb.projectId : undefined, wb.revision, true)
  const model = includeRetired ? retired.model : wb.model
  const loading = includeRetired ? retired.isLoading : wb.modelLoading
  const error = includeRetired ? retired.error : wb.modelError
  const text = useDeferredValue(filters.text)

  const rows = useMemo(
    () => (model ? buildRows(model.objects, model.relations, wb.freshness.index) : []),
    [model, wb.freshness.index],
  )
  const visible = useMemo(
    () => sortRows(filterRows(rows, { ...filters, text }), sort.key, sort.dir),
    [rows, filters, text, sort],
  )
  const types = useMemo(() => {
    const objectTypes = new Set<string>()
    const relationTypes = new Set<string>()
    for (const r of rows) (r.kind === 'object' ? objectTypes : relationTypes).add(r.type)
    return {
      objects: [...objectTypes].sort(compareTypes),
      relations: [...relationTypes].sort(),
    }
  }, [rows])
  const counts = useMemo(
    () => ({
      all: rows.length,
      object: rows.filter((r) => r.kind === 'object').length,
      relation: rows.filter((r) => r.kind === 'relation').length,
    }),
    [rows],
  )
  const set = (patch: Partial<RecordFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setLimit(PAGE)
  }
  const filtered =
    JSON.stringify({ ...filters, text: '' }) !== JSON.stringify({ ...DEFAULT_FILTERS, text: '' }) ||
    filters.text !== ''
  const showFreshness = wb.freshness.available

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-surface px-4 py-2.5">
        <label className="relative flex items-center">
          <span className="sr-only">Search records</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 size-4 text-fg-subtle"
          />
          <input
            data-view-search
            type="search"
            value={filters.text}
            onChange={(e) => set({ text: e.target.value })}
            placeholder="Search name, type or id  /"
            className="h-8 w-64 rounded-md border border-border-strong bg-surface pr-2 pl-8 text-sm placeholder:text-fg-subtle"
          />
        </label>
        <Segmented
          label="Record kind"
          value={filters.kind}
          onChange={(kind) => set({ kind, type: ALL })}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'object', label: 'Objects', count: counts.object },
            { value: 'relation', label: 'Relations', count: counts.relation },
          ]}
        />
        <FilterSelect label="Type" value={filters.type} onChange={(type) => set({ type })}>
          <option value={ALL}>All types</option>
          {filters.kind !== 'relation' && (
            <optgroup label="Object types">
              {types.objects.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
          {filters.kind !== 'object' && (
            <optgroup label="Relation types">
              {types.relations.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
        </FilterSelect>
        <FilterSelect label="Basis" value={filters.basis} onChange={(basis) => set({ basis })}>
          <option value={ALL}>Any basis</option>
          {BASIS_ORDER.map((b) => (
            <option key={b} value={b}>
              {BASIS_META[b].label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Stance" value={filters.stance} onChange={(stance) => set({ stance })}>
          <option value={ALL}>Any stance</option>
          <option value="asIs">As-is</option>
          <option value="toBe">To-be</option>
        </FilterSelect>
        {showFreshness && (
          <FilterSelect
            label="Freshness"
            value={filters.freshness}
            onChange={(freshness) => set({ freshness })}
          >
            <option value={ALL}>Any freshness</option>
            {FRESHNESS_STATUSES.map((s) => (
              <option key={s} value={s}>
                {FRESHNESS_META[s].label}
              </option>
            ))}
            <option value="none">Not reported</option>
          </FilterSelect>
        )}
        <label className="flex items-center gap-1.5 text-fg-muted text-xs">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => {
              setIncludeRetired(e.target.checked)
              if (!e.target.checked) set({ lifecycle: ALL })
            }}
            className="size-3.5 accent-[var(--k-accent)]"
          />
          Include retired
        </label>
        {includeRetired && (
          <FilterSelect
            label="Lifecycle"
            value={filters.lifecycle}
            onChange={(lifecycle) => set({ lifecycle })}
          >
            <option value={ALL}>Any lifecycle</option>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </FilterSelect>
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => set(DEFAULT_FILTERS)}>
            <X aria-hidden /> Clear
          </Button>
        )}
        <p className="ml-auto text-fg-muted text-xs tabular-nums" aria-live="polite">
          {visible.length.toLocaleString('en')} of {rows.length.toLocaleString('en')} records
          {wb.isHistorical && ` at r${wb.revision}`}
        </p>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto scrollbar-thin">
        {error ? (
          <div className="p-4">
            <ErrorNotice error={error} title="Records could not be loaded" />
          </div>
        ) : loading || !model ? (
          <div className="flex items-center justify-center gap-2 p-12 text-fg-muted">
            <Spinner /> Loading records…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? 'No records at this revision' : 'No records match'}
          >
            {rows.length > 0 && 'Try a broader search or clear the filters.'}
          </EmptyState>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Objects and relations at revision {wb.revision}</caption>
            <thead className="sticky top-0 z-10 bg-surface-2 text-left text-fg-muted text-xs">
              <tr>
                <SortHeader
                  label="Name"
                  k="label"
                  sort={sort}
                  onSort={toggleSort}
                  className="pl-4"
                />
                <SortHeader label="Type" k="type" sort={sort} onSort={toggleSort} />
                <SortHeader label="Basis" k="basis" sort={sort} onSort={toggleSort} />
                {showFreshness && (
                  <SortHeader label="Freshness" k="freshness" sort={sort} onSort={toggleSort} />
                )}
                <SortHeader label="Stance" k="stance" sort={sort} onSort={toggleSort} />
                <SortHeader label="Lifecycle" k="lifecycle" sort={sort} onSort={toggleSort} />
                <SortHeader
                  label="Evidence"
                  k="evidence"
                  sort={sort}
                  onSort={toggleSort}
                  align="right"
                />
                <SortHeader
                  label="Rev"
                  k="revision"
                  sort={sort}
                  onSort={toggleSort}
                  align="right"
                  className="pr-4"
                />
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, limit).map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  selected={row.id === wb.selection}
                  showFreshness={showFreshness}
                  onSelect={wb.select}
                />
              ))}
            </tbody>
          </table>
        )}
        {visible.length > limit && (
          <div className="flex justify-center p-4">
            <Button onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, visible.length - limit).toLocaleString('en')} more
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="flex items-center">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'select-control h-8 max-w-[200px] rounded-md border bg-surface pl-2 text-sm',
          value === ALL ? 'border-border-strong text-fg-muted' : 'border-accent text-fg',
        )}
      >
        {children}
      </select>
    </label>
  )
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align,
  className,
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: SortDirection }
  onSort: (k: SortKey) => void
  align?: 'right'
  className?: string
}) {
  const active = sort.key === k
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn('border-border border-b px-2 py-0 font-medium', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex h-8 w-full items-center gap-1 hover:text-fg',
          align === 'right' && 'justify-end',
          active && 'text-fg',
        )}
      >
        {label}
        <Icon aria-hidden className={cn('size-3', !active && 'opacity-40')} />
      </button>
    </th>
  )
}

function Row({
  row,
  selected,
  showFreshness,
  onSelect,
}: {
  row: RecordRow
  selected: boolean
  showFreshness: boolean
  onSelect: (id: string) => void
}) {
  const cell = 'border-border border-b px-2 py-1.5 align-middle'
  return (
    <tr
      onClick={() => onSelect(row.id)}
      aria-selected={selected}
      className={cn(
        'cursor-pointer [content-visibility:auto] hover:bg-surface-2',
        selected && 'bg-accent-soft hover:bg-accent-soft',
        row.lifecycle === 'retired' && 'text-fg-subtle',
      )}
    >
      <td className={cn(cell, 'max-w-[420px] pl-4')}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onSelect(row.id)
          }}
          className="flex w-full min-w-0 flex-col items-start text-left"
        >
          <span
            className={cn(
              'max-w-full truncate font-medium',
              row.kind === 'relation' && 'font-normal',
            )}
          >
            {row.label}
          </span>
          <span className="max-w-full truncate font-mono text-2xs text-fg-subtle">
            {shortId(row.id)}
            {row.detail && <span className="font-sans"> · {row.detail}</span>}
          </span>
        </button>
      </td>
      <td className={cn(cell, 'text-fg-muted')}>
        {row.kind === 'object' ? (
          <TypeLabel type={row.type} />
        ) : (
          <span className="font-mono text-xs">{row.type}</span>
        )}
      </td>
      <td className={cell}>
        <span className="flex flex-wrap items-center gap-1">
          <BasisBadge basis={row.basis} size="sm" />
          {row.confidence && <ConfidenceBadge level={row.confidence} size="sm" />}
        </span>
      </td>
      {showFreshness && (
        <td className={cell}>
          {row.freshness === 'current' ? (
            <span className="text-fg-muted text-xs">Current</span>
          ) : row.freshness ? (
            <FreshnessBadge status={row.freshness} size="sm" />
          ) : (
            <span className="text-fg-subtle text-xs">—</span>
          )}
        </td>
      )}
      <td className={cell}>
        {row.stance === 'asIs' ? (
          <span className="text-fg-muted text-xs">As-is</span>
        ) : (
          <StanceBadge stance={row.stance} size="sm" />
        )}
      </td>
      <td className={cell}>
        {row.lifecycle === 'active' ? (
          <span className="text-fg-muted text-xs">Active</span>
        ) : (
          <LifecycleBadge lifecycle={row.lifecycle} size="sm" />
        )}
      </td>
      <td className={cn(cell, 'text-right font-mono text-xs tabular-nums')}>{row.evidenceCount}</td>
      <td className={cn(cell, 'pr-4 text-right font-mono text-fg-muted text-xs tabular-nums')}>
        r{row.revision}
      </td>
    </tr>
  )
}
