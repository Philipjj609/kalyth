import type { KnowledgeView as Item, ParameterValue, PinStatus } from '@kalyth/contracts'
import { AlertTriangle, BookOpen, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  useApplicability,
  useAssessments,
  useKnowledgeItem,
  useKnowledgeSearch,
  useLibraryUses,
  usePinStatus,
} from '../api/knowledge.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { StatusBadge } from '../components/badges.tsx'
import { EmptyState, ScrollRegion, SectionTitle, Segmented, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import {
  attention,
  EFFECT_META,
  groupRelations,
  MATURITY_META,
  NATURE_HELP,
  NATURES,
  type Nature,
  REASON_TEXT,
  RELATION_TEXT,
  RESULT_META,
  readAsLines,
  stepSummary,
  testText,
  VERDICT_META,
} from '../model/knowledge.ts'
import { ErrorNotice } from '../views/shared.tsx'
import { NeighbourGraph } from './NeighbourGraph.tsx'

const TYPE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'knowledge.Pattern', label: 'Patterns' },
  { value: 'knowledge.Principle', label: 'Principles' },
  { value: 'knowledge.Concept', label: 'Concepts' },
  { value: 'knowledge.Condition', label: 'Conditions' },
  { value: 'knowledge.Method', label: 'Methods' },
] as const
type TypeFilter = (typeof TYPE_FILTERS)[number]['value']
const TYPE_LABEL: Record<string, string> = {
  'knowledge.Pattern': 'Pattern',
  'knowledge.Principle': 'Principle',
  'knowledge.Concept': 'Concept',
  'knowledge.Condition': 'Condition',
  'knowledge.Method': 'Method',
}

/**
 * The knowledge explorer (K5): discover what a library knows, read an item with its trade-offs,
 * conditions, evidence and limitations, move through connected knowledge, and, in a project, see
 * whether an item's declared conditions hold for a scenario and a chosen nature of values. Every
 * read goes through the K4 operations; nothing here writes.
 */
export default function KnowledgeView() {
  const wb = useWorkbench()
  const [loc, navigate] = useAppLocation()
  const isLibrary = wb.overview.project.kind === 'library'
  const [text, setText] = useState(loc.find ?? '')
  const [filter, setFilter] = useState<TypeFilter>('all')
  const search = useKnowledgeSearch(wb.projectId, text)
  const uses = useLibraryUses(wb.projectId, !isLibrary)
  const selected = useMemo(() => {
    const [library, id] = (loc.item ?? '').split('/')
    return library && id ? { library, id } : undefined
  }, [loc.item])
  const open = (library: string, id: string) =>
    navigate({ item: `${library}/${id}`, find: text || undefined })

  const hits = (search.data?.hits ?? []).filter((h) => filter === 'all' || h.type === filter)
  const groups = TYPE_FILTERS.slice(1)
    .map((t) => ({ ...t, hits: hits.filter((h) => h.type === t.value) }))
    .filter((g) => g.hits.length > 0)
  const skipped = (search.data?.libraries ?? []).filter((l) => !l.searched)

  if (!isLibrary && uses.data && uses.data.uses.length === 0)
    return (
      <EmptyState icon={<BookOpen />} title="This project uses no knowledge library yet">
        Declare a library with a LibraryUse to explore its knowledge here and assess it against this
        project’s scenarios.
      </EmptyState>
    )

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside
        aria-label="Knowledge discovery"
        className="flex w-full shrink-0 flex-col border-border border-b bg-surface md:w-80 md:border-r md:border-b-0"
      >
        <div className="space-y-2 border-border border-b p-3">
          <h1 className="font-semibold text-base">Knowledge</h1>
          <p className="text-fg-muted text-xs">
            {isLibrary
              ? 'Everything this library holds, at its head.'
              : (uses.data?.uses ?? [])
                  .map(
                    (u) =>
                      `${u.libraryName ?? u.library} at revision ${u.revision}${u.behind ? ` (${u.behind} behind)` : ''}`,
                  )
                  .join('; ') || 'The libraries this project uses.'}
          </p>
          <label className="relative block">
            <span className="sr-only">Search knowledge</span>
            <Search aria-hidden className="absolute top-2 left-2 size-4 text-fg-subtle" />
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search names, aliases and text"
              className="h-8 w-full rounded-md border border-border-strong bg-surface pr-2 pl-8 text-sm"
            />
          </label>
          <Segmented label="Type" value={filter} options={TYPE_FILTERS} onChange={setFilter} />
        </div>
        <ScrollRegion label="Knowledge items" className="min-h-0 flex-1 p-2">
          {search.isLoading && <Spinner label="Searching" />}
          {search.error && <ErrorNotice error={search.error} />}
          {skipped.map((l) => (
            <p
              key={l.library}
              className="tone-warning mb-2 rounded border border-tone-bd bg-tone-bg p-2 text-tone-fg text-xs"
            >
              Not searched: {l.library} ({l.reason}).
            </p>
          ))}
          {search.data && hits.length === 0 && (
            <p className="p-2 text-fg-muted text-sm">Nothing matches.</p>
          )}
          {groups.map((g) => (
            <section key={g.value} className="mb-3">
              <h2 className="px-1 pb-1 font-medium text-fg-muted text-xs uppercase tracking-wide">
                {g.label} <span className="font-normal">({g.hits.length})</span>
              </h2>
              <ul className="space-y-0.5">
                {g.hits.map((h) => {
                  const active = selected?.id === h.id
                  const maturity = MATURITY_META[h.maturity]
                  return (
                    <li key={`${h.library}/${h.id}`}>
                      <button
                        type="button"
                        onClick={() => open(h.library, h.id)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2',
                          active && 'bg-surface-2 font-medium',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{h.name}</span>
                        {h.disputed && <StatusBadge size="sm" tone="danger" label="Disputed" />}
                        {maturity && h.maturity !== 'proposed' && (
                          <StatusBadge size="sm" tone={maturity.tone} label={maturity.label} />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          {search.data?.truncated && (
            <p className="p-2 text-fg-muted text-xs">Showing the first 200 matches.</p>
          )}
        </ScrollRegion>
      </aside>
      <section aria-label="Knowledge item" className="min-h-0 min-w-0 flex-1 overflow-auto">
        {selected ? (
          <ItemDetail item={selected} isLibrary={isLibrary} onOpen={open} />
        ) : (
          <EmptyState icon={<BookOpen />} title="Choose an item">
            Pick a pattern, principle or concept to read what the library says about it, the
            evidence behind it and
            {isLibrary ? '' : ' whether its declared conditions hold for this project'}.
          </EmptyState>
        )}
      </section>
    </div>
  )
}

function ItemDetail({
  item,
  isLibrary,
  onOpen,
}: {
  item: { library: string; id: string }
  isLibrary: boolean
  onOpen: (library: string, id: string) => void
}) {
  const wb = useWorkbench()
  const q = useKnowledgeItem(item)
  const pins = usePinStatus(wb.projectId, !isLibrary)
  if (q.isLoading) return <Spinner label="Loading" />
  if (q.error) return <ErrorNotice error={q.error} />
  const k = q.data
  if (!k) return null
  const content = (k.content ?? {}) as { attributes?: Record<string, unknown> }
  const a = content.attributes ?? {}
  const name = String(a.name ?? a.statement ?? a.text ?? k.id)
  const maturity = k.maturity ? MATURITY_META[k.maturity] : undefined
  const groups = groupRelations(k.relations)
  const pin = pins.data?.pins.find(
    (p) => p.library === k.library && p.id === k.id && p.target === k.target,
  )

  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="k-eyebrow">
          {TYPE_LABEL[k.type] ?? k.type} · {k.libraryName} · revision {k.revision}
          {k.revision !== k.headRevision && ` (head ${k.headRevision})`}
        </p>
        <h2 className="font-semibold text-2xl leading-tight tracking-tight">{name}</h2>
        <div className="flex flex-wrap gap-1.5">
          {maturity && (
            <StatusBadge
              tone={maturity.tone}
              label={maturity.label}
              description={maturity.description}
              prefix="Maturity:"
            />
          )}
          {k.dispute?.status === 'disputed' && (
            <StatusBadge
              tone="danger"
              icon={AlertTriangle}
              label={`Disputed by ${k.dispute.by.length + k.dispute.contradictedBy.length}`}
            />
          )}
          {pin && <PinBadge pin={pin} />}
        </div>
        <ul className="space-y-1">
          {readAsLines(k.readAs).map((l) => (
            <li key={l.text} className={cn(`tone-${l.tone}`, 'text-tone-fg text-xs')}>
              {l.text}
            </li>
          ))}
        </ul>
      </header>

      <Description attributes={a} />

      {!isLibrary && k.type !== 'knowledge.Concept' && k.type !== 'knowledge.Condition' && (
        <Applicability pin={pin} />
      )}

      {groups.tradeoffs.length > 0 && (
        <section aria-labelledby="k-tradeoffs" className="space-y-2">
          <SectionTitle>
            <span id="k-tradeoffs">Trade-offs</span>
          </SectionTitle>
          <ul className="space-y-1.5">
            {groups.tradeoffs.map((r) => {
              const effect = EFFECT_META[String(r.properties.effect)]
              return (
                <li key={r.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  {effect && <StatusBadge size="sm" tone={effect.tone} label={effect.label} />}
                  <RelatedLink library={k.library} other={r.other} onOpen={onOpen} />
                  {typeof r.properties.note === 'string' && (
                    <span className="text-fg-muted">{r.properties.note}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {groups.conditions.length > 0 && (
        <section aria-labelledby="k-conditions" className="space-y-2">
          <SectionTitle>
            <span id="k-conditions">Declared conditions</span>
          </SectionTitle>
          <ul className="space-y-1 text-sm">
            {groups.conditions.map((r) => (
              <li key={r.id}>
                <span className="text-fg-muted">
                  {RELATION_TEXT[r.type]?.[r.direction === 'out' ? 0 : 1] ?? r.type}
                </span>{' '}
                <RelatedLink library={k.library} other={r.other} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {k.type === 'knowledge.Pattern' && groups.conditions.length === 0 && (
        <p className="tone-warning rounded border border-tone-bd bg-tone-bg p-2 text-tone-fg text-sm">
          The library declares no conditions for this pattern, so whether it applies is not
          established.
        </p>
      )}

      {(groups.structure.length > 0 || groups.other.length > 0) && (
        <section aria-labelledby="k-connected" className="space-y-2">
          <SectionTitle>
            <span id="k-connected">Connected knowledge</span>
          </SectionTitle>
          <NeighbourGraph item={k} name={name} onOpen={(id) => onOpen(k.library, id)} />
          <ul className="space-y-1 text-sm">
            {[...groups.structure, ...groups.other].map((r) => (
              <li key={r.id}>
                <span className="text-fg-muted">
                  {RELATION_TEXT[r.type]?.[r.direction === 'out' ? 0 : 1] ?? r.type}
                </span>{' '}
                <RelatedLink library={k.library} other={r.other} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {k.relationsOmitted > 0 && (
            <p className="text-fg-muted text-xs">{k.relationsOmitted} more relations not shown.</p>
          )}
        </section>
      )}

      <Evidence k={k} />
      {!isLibrary && <Recorded item={k} />}
    </article>
  )
}

const FIELDS: [string, string][] = [
  ['definition', 'Definition'],
  ['statement', 'Statement'],
  ['problem', 'Problem'],
  ['solution', 'Solution'],
  ['structure', 'Structure'],
  ['consequences', 'Consequences'],
  ['rationale', 'Rationale'],
  ['scope', 'Scope'],
  ['purpose', 'Purpose'],
]

function Description({ attributes }: { attributes: Record<string, unknown> }) {
  const exceptions = Array.isArray(attributes.exceptions) ? (attributes.exceptions as string[]) : []
  const aliases = Array.isArray(attributes.aliases) ? (attributes.aliases as string[]) : []
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[9rem_1fr]">
      {aliases.length > 0 && (
        <>
          <dt className="font-medium text-fg-muted text-sm">Also called</dt>
          <dd className="text-sm">{aliases.join(', ')}</dd>
        </>
      )}
      {FIELDS.filter(([key]) => typeof attributes[key] === 'string').map(([key, label]) => (
        <div key={key} className="contents">
          <dt className="font-medium text-fg-muted text-sm">{label}</dt>
          <dd className="text-sm leading-relaxed">{String(attributes[key])}</dd>
        </div>
      ))}
      {attributes.test !== undefined && (
        <>
          <dt className="font-medium text-fg-muted text-sm">Test</dt>
          <dd className="text-sm">{testText(attributes.test as never)}</dd>
        </>
      )}
      {attributes.kind === 'principle' || exceptions.length > 0 ? (
        <>
          <dt className="font-medium text-fg-muted text-sm">Exceptions</dt>
          <dd className="text-sm">
            {exceptions.length ? exceptions.join('; ') : 'None stated by its source.'}
          </dd>
        </>
      ) : null}
    </dl>
  )
}

function RelatedLink({
  library,
  other,
  onOpen,
}: {
  library: string
  other: { id: string; type: string; name: string }
  onOpen: (library: string, id: string) => void
}) {
  if (!other.type.startsWith('knowledge.')) return <span>{other.name}</span>
  return (
    <button
      type="button"
      onClick={() => onOpen(library, other.id)}
      className="font-medium text-accent underline-offset-2 hover:underline"
    >
      {other.name}
    </button>
  )
}

function PinBadge({ pin }: { pin: PinStatus }) {
  if (pin.resolution.state !== 'resolved')
    return <StatusBadge tone="danger" label={`Pin unresolved: ${pin.resolution.reason}`} />
  const tone = pin.freshness === 'current' || pin.freshness === 'unchanged' ? 'accent' : 'warning'
  return (
    <StatusBadge
      tone={tone}
      label={`Pinned at revision ${pin.revision}: ${pin.freshness}`}
      description="This project pinned this version; its copy travels with the project."
    />
  )
}

/** Each support group's review and each source's provenance (ADR 0026 §6, ADR 0030 A9). */
function Evidence({ k }: { k: Item }) {
  const sources = new Map(k.sources.map((s) => [s.evidence, s]))
  const groups = k.support ?? []
  const total = groups.flatMap((g) => g.sources).filter((s) => s.locatorVerification !== null)
  const verified = total.filter((s) => s.locatorVerification === 'verified').length
  return (
    <section aria-labelledby="k-evidence" className="space-y-3">
      <SectionTitle>
        <span id="k-evidence">Evidence and sources</span>
      </SectionTitle>
      <p className="text-fg-muted text-sm">
        {groups.length} support group{groups.length === 1 ? '' : 's'}; {verified} of {total.length}{' '}
        source locators verified. Kalyth stores no source text, so no quotation is matched: a
        verified locator means a person found the passage, not that any wording was checked.
      </p>
      <ol className="space-y-3">
        {groups.map((g, i) => (
          <li key={g.key} className="rounded-md border border-border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Group {i + 1}</span>
              <StatusBadge
                size="sm"
                tone={
                  g.review === 'supports'
                    ? 'success'
                    : g.review === 'unreviewed'
                      ? 'warning'
                      : 'neutral'
                }
                label={g.review === 'unreviewed' ? 'Support not reviewed' : `Reviewed: ${g.review}`}
              />
              {!g.counts && <StatusBadge size="sm" tone="danger" label="Does not count" />}
              {g.scopeLimit && (
                <span className="text-fg-muted text-xs">Holds only for: {g.scopeLimit}</span>
              )}
            </div>
            <ul className="space-y-2">
              {g.sources.map((s) => {
                const src = sources.get(s.evidence)
                const meta = src?.meta
                return (
                  <li key={s.evidence} className="text-sm">
                    <p className="font-medium">
                      {meta?.title ?? src?.uri ?? s.evidence}
                      {meta?.authors?.length ? (
                        <span className="font-normal text-fg-muted">
                          {' '}
                          · {meta.authors.join(', ')}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-fg-muted text-xs">
                      {[
                        meta?.publisher,
                        meta?.published,
                        meta?.locator ?? src?.locator,
                        `licence ${meta?.licence ?? 'unknown'}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="text-xs">
                      {s.quote === 'stored'
                        ? 'Quote stored, not matched'
                        : 'Paraphrase with a locator'}
                      {s.locatorVerification !== null && ` · locator ${s.locatorVerification}`}
                      {src?.uri && (
                        <>
                          {' · '}
                          <a
                            href={src.uri}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent underline-offset-2 hover:underline"
                          >
                            open source
                          </a>
                        </>
                      )}
                    </p>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Whether the item's declared conditions hold for this project (K3), read-only. */
function Applicability({ pin }: { pin: PinStatus | undefined }) {
  const wb = useWorkbench()
  const objects = wb.model?.objects ?? []
  const scenarios = objects.filter((o) => o.type === 'core.Scenario' && o.lifecycle === 'active')
  const elements = objects.filter((o) => o.type.startsWith('software.') && o.lifecycle === 'active')
  const [scenario, setScenario] = useState<string | undefined>(scenarios[0]?.id)
  const [element, setElement] = useState<string | undefined>(undefined)
  const [nature, setNature] = useState<Nature | undefined>(undefined)
  const result = useApplicability({
    projectId: wb.projectId,
    item: pin?.evidence,
    scenario,
    element,
    nature,
  })

  return (
    <section
      aria-labelledby="k-applicability"
      className="space-y-3 rounded-md border border-border-strong p-4"
    >
      <SectionTitle>
        <span id="k-applicability">Applicability in this project</span>
      </SectionTitle>
      {!pin ? (
        <p className="text-fg-muted text-sm">
          This project has not pinned this item, so it cannot be assessed here. Applicability is
          assessed only against knowledge a project pins.
        </p>
      ) : scenarios.length === 0 ? (
        <p className="text-fg-muted text-sm">
          The project has no scenario yet. Add one to assess applicability.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="block font-medium">Scenario</span>
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                className="h-8 rounded-md border border-border-strong bg-surface px-2"
              >
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {String(s.attributes.name)} ({String(s.attributes.status)})
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block font-medium">Element</span>
              <select
                value={element ?? ''}
                onChange={(e) => setElement(e.target.value || undefined)}
                className="h-8 rounded-md border border-border-strong bg-surface px-2"
              >
                <option value="">Whole system</option>
                {elements.map((e) => (
                  <option key={e.id} value={e.id}>
                    {String(e.attributes.name ?? e.attributes.path ?? e.id)}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1 text-sm">
              <span className="block font-medium" id="k-nature">
                Values to assess
              </span>
              <Segmented
                label="Values to assess"
                value={nature ?? ('' as Nature)}
                options={NATURES.map((n) => ({ value: n, label: n }))}
                onChange={setNature}
              />
            </div>
          </div>
          {nature ? (
            <p className="text-fg-muted text-xs">
              {NATURE_HELP[nature]}. Other natures are shown as context, never used.
            </p>
          ) : (
            <p className="text-fg-muted text-xs">
              Choose which values to assess: current, expected, target or limit.
            </p>
          )}
          {result.isFetching && <Spinner label="Evaluating" />}
          {result.error && <ErrorNotice error={result.error} />}
          {result.data && <Verdict data={result.data} />}
        </>
      )}
    </section>
  )
}

function Verdict({ data }: { data: NonNullable<ReturnType<typeof useApplicability>['data']> }) {
  const meta = VERDICT_META[data.verdict]
  const notes = attention(data)
  const e = data.explanation
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          tone={meta.tone}
          label={meta.label}
          description={meta.description}
          prefix="Verdict:"
        />
        <span className="text-fg-muted text-xs">for {e.nature} values</span>
      </div>
      <p className="text-sm">{meta.description}</p>
      {notes.length > 0 && (
        <ul className="tone-warning space-y-1 rounded border border-tone-bd bg-tone-bg p-2 text-tone-fg text-sm">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {e.steps.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Conditions evaluated</caption>
          <thead className="text-fg-muted text-xs">
            <tr>
              <th className="py-1 pr-3 font-medium">Condition</th>
              <th className="py-1 pr-3 font-medium">Value used</th>
              <th className="py-1 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {e.steps.map((s) => (
              <tr key={s.condition} className="border-border border-t align-top">
                <td className="py-1.5 pr-3">
                  <span className="text-fg-muted">
                    {RELATION_TEXT[s.relation]?.[0] ?? s.relation}
                  </span>{' '}
                  {s.text}
                  {s.test && <span className="text-fg-muted"> ({testText(s.test)})</span>}
                </td>
                <td className="py-1.5 pr-3">
                  {s.parameters.length === 0
                    ? '—'
                    : s.parameters.map((p) => (
                        <span key={p.id} className="block">
                          {valueText(p.value)}{' '}
                          <span className="text-fg-muted text-xs">from {p.resolvedFrom}</span>
                        </span>
                      ))}
                  {s.context?.map((c) => (
                    <span key={c.id} className="block text-fg-muted text-xs">
                      {c.nature}: {valueText(c.value)} (context only)
                    </span>
                  ))}
                </td>
                <td className="py-1.5">
                  <StatusBadge
                    size="sm"
                    tone={RESULT_META[s.result]?.tone ?? 'neutral'}
                    label={stepSummary(s)}
                  />
                  {s.note && <span className="block text-fg-muted text-xs">{s.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {e.missing.length > 0 && (
        <p className="text-sm">
          Missing:{' '}
          {e.missing
            .map((m) => `${m.conceptName} (${m.nature}${m.dimension ? `, ${m.dimension}` : ''})`)
            .join('; ')}
          .
        </p>
      )}
      {e.alternatives?.map((alt) => (
        <p key={alt.correspondence} className="text-sm">
          {alt.item.name} in another library ({alt.relation}):{' '}
          {VERDICT_META[alt.verdict].label.toLowerCase()}.
        </p>
      ))}
      {e.conflict.state !== 'none' && <p className="text-fg-muted text-xs">{e.conflict.note}</p>}
    </div>
  )
}

function valueText(v: ParameterValue): string {
  const unit = 'unit' in v && v.unit !== '1' ? ` ${v.unit}` : ''
  if (v.kind === 'point') return `${v.value}${unit}`
  if (v.kind === 'interval') return `${v.min ?? '…'} to ${v.max ?? '…'}${unit}`
  if (v.kind === 'unknown') return `unknown (${v.reason})`
  return String(v.value)
}

/** Recorded assessments of this item in the project, with freshness (ADR 0029 §3). */
function Recorded({ item }: { item: Item }) {
  const wb = useWorkbench()
  const list = useAssessments(wb.projectId, true)
  const mine = (list.data?.assessments ?? []).filter(
    (a) => a.item.library === item.library && a.item.id === item.id,
  )
  if (mine.length === 0) return null
  return (
    <section aria-labelledby="k-recorded" className="space-y-2">
      <SectionTitle>
        <span id="k-recorded">Recorded assessments</span>
      </SectionTitle>
      <ul className="space-y-2">
        {mine.map((a) => (
          <li key={a.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                size="sm"
                tone={VERDICT_META[a.verdict].tone}
                label={VERDICT_META[a.verdict].label}
              />
              <StatusBadge
                size="sm"
                tone={a.freshness.status === 'current' ? 'accent' : 'warning'}
                label={a.freshness.status === 'current' ? 'Current' : 'Stale'}
              />
              <span className="text-fg-muted text-xs">
                {wb.model?.nameOf(a.scenario) ?? a.scenario}
                {a.element ? ` · ${wb.model?.nameOf(a.element) ?? a.element}` : ''} · {a.nature}{' '}
                values
              </span>
            </div>
            {a.freshness.status === 'stale' && (
              <p className="text-fg-muted text-xs">
                {a.freshness.reasons.slice(0, 3).join('; ')}
                {a.freshness.verdictNow &&
                  ` · now: ${VERDICT_META[a.freshness.verdictNow].label.toLowerCase()}`}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="text-fg-muted text-xs">
        Reassessing is a proposal a person commits; nothing is recomputed here.
      </p>
    </section>
  )
}
