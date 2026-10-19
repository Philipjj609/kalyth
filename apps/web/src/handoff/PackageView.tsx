import type { ContextItem, ContextPackage, ContextPackageResult } from '@kalyth/contracts'
import { OctagonAlert, Package, TriangleAlert } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import {
  BasisBadge,
  ConfidenceBadge,
  DecisionStatusBadge,
  FreshnessBadge,
  StanceBadge,
  StatusBadge,
  TypeLabel,
} from '../components/badges.tsx'
import { CopyButton, Panel, ScrollRegion } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural, shortId, shortSha } from '../model/format.ts'
import {
  approxTokens,
  type DecisionGroup,
  groupDecisions,
  groupItems,
  itemPathElement,
  itemText,
  omissionText,
  packageJson,
  ROLE_META,
  sizeShare,
  sizeText,
} from '../model/handoff.ts'
import { ElementButton, ImpactPath } from '../navigator/ProposedOutput.tsx'

/** Names for ids and an optional way to inspect a record; passed in so the view stays pure. */
export interface PackageLookup {
  labelOf: (id: string) => string
  onInspect?: ((id: string) => void) | undefined
}

const SECTION_TITLE =
  'mb-2 flex items-center gap-2 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]'

function Count({ n }: { n: number }) {
  return <span className="font-mono text-fg-muted tabular-nums">{n}</span>
}

function None({ children = 'None.' }: { children?: ReactNode }) {
  return <p className="text-fg-subtle text-xs">{children}</p>
}

// ---------- items ----------

function DistanceBadge({ distance }: { distance: number }) {
  return (
    <StatusBadge
      size="sm"
      tone={distance === 0 ? 'accent' : 'neutral'}
      label={`Distance ${distance}`}
      description="Typed distance from the focus: 0 for the focus itself and for mandatory items."
    />
  )
}

/** Where the evidence is, and its pinned excerpt as preformatted text when the package has one. */
function EvidenceList({ evidence }: { evidence: ContextItem['evidence'] }) {
  if (evidence.length === 0) return null
  return (
    <ul aria-label="Evidence" className="mt-1.5 space-y-1">
      {evidence.map((e) => (
        <li key={e.id} className="min-w-0 text-xs">
          <code className="break-all font-mono text-[11px] text-fg-muted">{e.location}</code>
          {e.excerpt !== null && (
            <ScrollRegion
              as="pre"
              label={`Excerpt from ${e.location}`}
              className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-fg leading-relaxed scrollbar-thin"
            >
              {e.excerpt}
            </ScrollRegion>
          )}
        </li>
      ))}
    </ul>
  )
}

function ItemBadges({ item, distance = true }: { item: ContextItem; distance?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {distance && <DistanceBadge distance={item.distance} />}
      <BasisBadge basis={item.basis} size="sm" />
      <FreshnessBadge status={item.freshness} size="sm" />
      {item.confidence && <ConfidenceBadge level={item.confidence.level} size="sm" />}
      {item.stance === 'toBe' && <StanceBadge stance={item.stance} size="sm" />}
    </span>
  )
}

function ItemTitle({ item, lookup }: { item: ContextItem; lookup: PackageLookup }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {item.kind === 'object' ? (
        <TypeLabel type={item.type} className="shrink-0 text-fg-muted text-xs" />
      ) : (
        <code className="shrink-0 font-mono text-2xs text-fg-muted">{item.type}</code>
      )}
      <ElementButton
        id={item.id}
        label={item.label || lookup.labelOf(item.id)}
        onInspect={item.kind === 'object' ? lookup.onInspect : undefined}
        className="min-w-0 font-medium text-sm"
      />
    </span>
  )
}

/** The text that says what an item is: a statement, a summary, a question or a change. */
function itemBody(item: ContextItem): string {
  for (const key of ['statement', 'question', 'summary', 'text', 'change']) {
    const value = itemText(item, key)
    if (value && value !== item.label) return value
  }
  return ''
}

function ItemRow({ item, lookup }: { item: ContextItem; lookup: PackageLookup }) {
  const body = itemBody(item)
  return (
    <li className="space-y-1 px-4 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <ItemTitle item={item} lookup={lookup} />
        <ItemBadges item={item} />
      </div>
      {body && <p className="whitespace-pre-line break-words text-fg-muted text-xs">{body}</p>}
      {item.confidence && (
        <p className="break-words text-fg-subtle text-xs">{item.confidence.rationale}</p>
      )}
      {item.path.length > 0 && (
        <ImpactPath element={itemPathElement(item)} labelOf={lookup.labelOf} />
      )}
      <EvidenceList evidence={item.evidence} />
    </li>
  )
}

// ---------- header ----------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-muted text-xs">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function SizeMeter({ chars, maxChars }: { chars: number; maxChars: number }) {
  const share = sizeShare(chars, maxChars)
  return (
    <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
      <span
        className={cn(chars > maxChars ? 'tone-danger' : 'tone-accent', 'block h-full bg-tone-fg')}
        style={{ width: `${share * 100}%` }}
      />
    </div>
  )
}

export function PackageHeader({
  result,
  headRevision,
  titleId,
}: {
  result: ContextPackageResult
  headRevision: number
  titleId: string
}) {
  const pkg = result.package
  const blocked = pkg.status === 'blocked'
  const chars = blocked ? (pkg.blocked?.mandatoryChars ?? pkg.size.mandatoryChars) : pkg.size.chars
  return (
    <header className="rounded-lg border border-border bg-surface px-4 py-3 shadow-panel">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          tone={blocked ? 'danger' : 'success'}
          icon={blocked ? OctagonAlert : Package}
          label={blocked ? 'Blocked' : 'Ready'}
          prefix="Package status:"
          description={
            blocked
              ? 'The mandatory part alone exceeds the size limit; compile a split instead.'
              : 'Fits the size limit with its whole mandatory part.'
          }
        />
        <span className="font-medium text-fg-muted text-xs">Context package</span>
        <span className="ml-auto">
          <CopyButton text={packageJson(pkg)} label="Copy package JSON">
            Copy package JSON
          </CopyButton>
        </span>
      </div>
      <h2
        id={titleId}
        tabIndex={-1}
        className="mt-1.5 break-words font-semibold text-[15px] text-fg leading-snug outline-none"
      >
        {pkg.task?.title || `Context for ${plural(pkg.focus.length, 'focus element')}`}
      </h2>
      {result.current.headMoved && (
        <div
          role="status"
          className={cn(
            'mt-3 rounded border px-3 py-2 text-sm',
            result.current.stale.length + result.current.removed.length > 0
              ? 'tone-warning border-tone-bd bg-tone-bg text-tone-fg'
              : 'border-border bg-surface-2 text-fg-muted',
          )}
        >
          {result.current.warning}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-3">
        <Fact label="Id">
          <span className="flex items-center gap-1">
            <code className="truncate font-mono text-xs" title={pkg.id}>
              {pkg.id}
            </code>
            <CopyButton text={pkg.id} label="Copy package id" />
          </span>
        </Fact>
        <Fact label="URI">
          <span className="flex items-center gap-1">
            <code className="truncate font-mono text-xs" title={result.uri}>
              {result.uri}
            </code>
            <CopyButton text={result.uri} label="Copy package URI" />
          </span>
        </Fact>
        <Fact label="Revision">
          <span className="font-mono">r{pkg.revision}</span>
          {pkg.revision < headRevision && (
            <span className="tone-warning ml-2 rounded border border-tone-bd bg-tone-bg px-1.5 text-tone-fg text-xs">
              the head is r{headRevision}
            </span>
          )}
        </Fact>
        <Fact label="Source snapshots">
          {pkg.snapshots.length === 0 ? (
            <span className="text-fg-subtle text-xs">None recorded.</span>
          ) : (
            <ul className="space-y-0.5">
              {pkg.snapshots.map((s) => (
                <li key={`${s.repo}@${s.commit}`} className="break-all font-mono text-xs">
                  {s.repo} @ {shortSha(s.commit)}
                </li>
              ))}
            </ul>
          )}
        </Fact>
        <Fact label={blocked ? 'Mandatory size against the limit' : 'Size against the limit'}>
          <span className="tabular-nums">
            {chars.toLocaleString('en')} of {pkg.size.maxChars.toLocaleString('en')} characters
          </span>
          <span className="block text-fg-muted text-xs tabular-nums">
            ≈ {approxTokens(chars).toLocaleString('en')} of{' '}
            {approxTokens(pkg.size.maxChars).toLocaleString('en')} tokens
          </span>
          <SizeMeter chars={chars} maxChars={pkg.size.maxChars} />
        </Fact>
        <Fact label="Mandatory size">
          <span className="tabular-nums">{sizeText(pkg.size.mandatoryChars)}</span>
          <span className="block text-fg-muted text-xs">never cut to fit</span>
        </Fact>
      </dl>
      {result.callerScopes.length > 0 && (
        <p className="mt-3 text-fg-subtle text-xs">
          Read with your scopes: <span className="font-mono">{result.callerScopes.join(', ')}</span>
          . Scopes are beside the package, not part of it.
        </p>
      )}
    </header>
  )
}

// ---------- blocked ----------

export function BlockedNotice({
  pkg,
  lookup,
  renderSplitAction,
}: {
  pkg: ContextPackage
  lookup: PackageLookup
  /** The compile action for one suggested split. */
  renderSplitAction?: ((split: string[], index: number) => ReactNode) | undefined
}) {
  const blocked = pkg.blocked
  if (pkg.status !== 'blocked' || !blocked) return null
  return (
    <section
      aria-label="Package blocked"
      className="tone-danger rounded-lg border border-tone-bd bg-tone-bg px-4 py-3 text-sm"
    >
      <p className="flex items-start gap-2 font-semibold text-tone-fg">
        <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        The mandatory part alone exceeds the size limit.
      </p>
      <p className="mt-1 pl-6 text-fg">
        Invariants, constraints, decisions, acceptance criteria and the agent policy come to{' '}
        {blocked.mandatoryChars.toLocaleString('en')} characters, over the limit of{' '}
        {blocked.maxChars.toLocaleString('en')}. They are never cut to fit, so this package cannot
        be handed off. Compile each suggested part as its own package instead.
      </p>
      {blocked.splits.length === 0 ? (
        <p className="mt-2 pl-6 text-fg-muted text-xs">
          No split was suggested. Raise the size limit or narrow the focus.
        </p>
      ) : (
        <ol aria-label="Suggested splits" className="mt-2 space-y-2 pl-6">
          {blocked.splits.map((split, i) => (
            <li
              key={split.join(',')}
              className="flex flex-wrap items-center gap-2 rounded-md border border-tone-bd bg-surface px-3 py-2"
            >
              <span className="font-medium text-fg text-xs">Part {i + 1}</span>
              <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {split.map((id) => (
                  <li
                    key={id}
                    className="rounded border border-border px-1.5 py-0.5 text-fg text-xs"
                    title={id}
                  >
                    {lookup.labelOf(id)}
                  </li>
                ))}
              </ul>
              {renderSplitAction?.(split, i)}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

// ---------- mandatory ----------

function DecisionCard({ group, lookup }: { group: DecisionGroup; lookup: PackageLookup }) {
  const { decision } = group
  const status = decision ? itemText(decision, 'status') : ''
  return (
    <li className="rounded-md border border-border">
      {decision && (
        <div className="space-y-1 px-3 py-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <ItemTitle item={decision} lookup={lookup} />
            <span className="flex flex-wrap items-center gap-1.5">
              {status && <DecisionStatusBadge status={status} size="sm" />}
              <ItemBadges item={decision} distance={false} />
            </span>
          </div>
          {itemText(decision, 'question') && (
            <p className="break-words text-fg-muted text-xs">{itemText(decision, 'question')}</p>
          )}
          {itemText(decision, 'statusRationale') && (
            <p className="break-words text-fg-muted text-xs">
              <span className="font-medium text-fg">Rationale: </span>
              {itemText(decision, 'statusRationale')}
            </p>
          )}
        </div>
      )}
      {group.alternatives.length === 0 ? (
        <p className="border-border border-t px-3 py-2 text-fg-subtle text-xs">
          No accepted alternative in this package.
        </p>
      ) : (
        <ul className="divide-y divide-border border-border border-t">
          {group.alternatives.map((a, i) => (
            <li key={a.alternative?.id ?? `changes-${i}`} className="space-y-1.5 px-3 py-2">
              {a.alternative && (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-fg-muted text-xs">Accepted alternative</span>
                      <ElementButton
                        id={a.alternative.id}
                        label={a.alternative.label}
                        onInspect={lookup.onInspect}
                        className="min-w-0 font-medium text-sm"
                      />
                    </span>
                    <ItemBadges item={a.alternative} distance={false} />
                  </div>
                  {itemText(a.alternative, 'summary') && (
                    <p className="whitespace-pre-line break-words text-fg text-xs">
                      {itemText(a.alternative, 'summary')}
                    </p>
                  )}
                </>
              )}
              <div>
                <p className="mb-1 font-medium text-fg-muted text-xs">
                  Direct changes <Count n={a.changes.length} />
                </p>
                {a.changes.length === 0 ? (
                  <None>None recorded.</None>
                ) : (
                  <ul className="space-y-1.5 border-border border-l pl-2.5">
                    {a.changes.map((c) => (
                      <li key={c.id} className="space-y-0.5 text-xs">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {c.to ? (
                            <ElementButton
                              id={c.to}
                              label={lookup.labelOf(c.to)}
                              onInspect={lookup.onInspect}
                              className="font-medium"
                            />
                          ) : (
                            <span className="font-medium">{c.label}</span>
                          )}
                          <BasisBadge basis={c.basis} size="sm" />
                          <FreshnessBadge status={c.freshness} size="sm" />
                        </span>
                        <p className="whitespace-pre-line break-words text-fg-muted">
                          {itemText(c, 'change') || 'No description of the change.'}
                        </p>
                        <EvidenceList evidence={c.evidence} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function ConstraintList({
  items,
  lookup,
  empty,
}: {
  items: readonly ContextItem[]
  lookup: PackageLookup
  empty: string
}) {
  if (items.length === 0) return <None>{empty}</None>
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((c) => {
        const severity = itemText(c, 'severity')
        return (
          <li key={c.id} className="space-y-1 px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <ItemTitle item={c} lookup={lookup} />
              <span className="flex flex-wrap items-center gap-1.5">
                {severity && (
                  <StatusBadge
                    size="sm"
                    tone={severity === 'must' ? 'danger' : 'warning'}
                    label={severity === 'must' ? 'Must' : 'Should'}
                    prefix="Severity:"
                  />
                )}
                <ItemBadges item={c} distance={false} />
              </span>
            </div>
            {itemText(c, 'statement') && (
              <p className="whitespace-pre-line break-words text-fg text-xs">
                {itemText(c, 'statement')}
              </p>
            )}
            <EvidenceList evidence={c.evidence} />
          </li>
        )
      })}
    </ul>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number | undefined
  children: ReactNode
}) {
  return (
    <section aria-label={count === undefined ? title : `${title}, ${count}`} className="px-4 py-3">
      <h3 className={SECTION_TITLE}>
        {title}
        {count !== undefined && <Count n={count} />}
      </h3>
      {children}
    </section>
  )
}

export function MandatorySections({ pkg, lookup }: { pkg: ContextPackage; lookup: PackageLookup }) {
  const { invariants, constraints, decisions, acceptanceCriteria, policy } = pkg.mandatory
  const groups = groupDecisions(decisions)
  return (
    <Panel
      title="Mandatory"
      aside={
        <span className="text-fg-subtle text-xs">
          never cut · {pkg.size.mandatoryChars.toLocaleString('en')} characters
        </span>
      }
    >
      <div className="divide-y divide-border">
        <Section title="Invariants" count={invariants.length}>
          <ConstraintList items={invariants} lookup={lookup} empty="No project-wide constraints." />
        </Section>
        <Section title="Constraints" count={constraints.length}>
          <ConstraintList
            items={constraints}
            lookup={lookup}
            empty="No constraints on the focus or what contains it."
          />
        </Section>
        <Section title="Decisions" count={groups.filter((g) => g.decision).length}>
          {groups.length === 0 ? (
            <None>No accepted decisions about the focus.</None>
          ) : (
            <ul className="space-y-2">
              {groups.map((g, i) => (
                <DecisionCard key={g.decision?.id ?? `group-${i}`} group={g} lookup={lookup} />
              ))}
            </ul>
          )}
        </Section>
        <Section title="Acceptance criteria" count={acceptanceCriteria.length}>
          {acceptanceCriteria.length === 0 ? (
            <None>No acceptance criteria were given.</None>
          ) : (
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {acceptanceCriteria.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: criteria are an immutable, ordered list that may repeat
                <li key={i} className="whitespace-pre-line break-words">
                  {c}
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section title="Agent policy" count={policy.length}>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {policy.map((p) => (
              <li key={p} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </Panel>
  )
}

// ---------- optional ----------

export function OptionalItems({ pkg, lookup }: { pkg: ContextPackage; lookup: PackageLookup }) {
  const groups = groupItems(pkg.items)
  return (
    <Panel
      title="Optional items"
      aside={
        <span className="text-fg-subtle text-xs">
          nearest first · {plural(pkg.items.length, 'item')}
        </span>
      }
    >
      {groups.length === 0 ? (
        <p className="px-4 py-3 text-fg-subtle text-xs">
          {pkg.status === 'blocked'
            ? 'None: a blocked package holds only its mandatory part.'
            : 'No optional items fit, or none apply to this focus.'}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {groups.map((g) => {
            const meta = ROLE_META[g.role]
            return (
              <section key={g.role} aria-label={`${meta?.label ?? g.role}, ${g.items.length}`}>
                <header className="px-4 pt-3">
                  <h3 className={cn(SECTION_TITLE, 'mb-0.5')}>
                    {meta?.label ?? g.role}
                    <Count n={g.items.length} />
                  </h3>
                  {meta && <p className="text-fg-subtle text-xs">{meta.description}</p>}
                </header>
                <ul className="divide-y divide-border">
                  {g.items.map((item) => (
                    <ItemRow key={item.id} item={item} lookup={lookup} />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

// ---------- omissions and retrieval ----------

const OMITTED_SHOWN = 8

export function Omissions({ pkg, lookup }: { pkg: ContextPackage; lookup: PackageLookup }) {
  return (
    <Panel title="Left out">
      {pkg.omissions.length === 0 ? (
        <p className="px-4 py-3 text-fg-muted text-sm">
          {pkg.status === 'blocked'
            ? 'Nothing is listed: the package stopped at its mandatory part.'
            : 'Nothing was left out.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {pkg.omissions.map((o) => (
            <li key={`${o.reason}-${o.count}`} className="space-y-1.5 px-4 py-3">
              <p className="flex items-start gap-2 text-sm">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                <span>{omissionText(o)}.</span>
              </p>
              {o.ids.length > 0 && (
                <div className="pl-6">
                  <p className="mb-1 text-fg-muted text-xs">
                    {o.ids.length < o.count
                      ? `The first ${o.ids.length}, nearest first:`
                      : 'Nearest first:'}
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {o.ids.slice(0, OMITTED_SHOWN).map((id) => (
                      <li
                        key={id}
                        className="inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-xs"
                      >
                        <span>{lookup.labelOf(id)}</span>
                        <span className="font-mono text-2xs text-fg-subtle">{shortId(id)}</span>
                      </li>
                    ))}
                  </ul>
                  {o.ids.length > OMITTED_SHOWN && (
                    <p className="mt-1 text-fg-subtle text-xs">
                      and {o.ids.length - OMITTED_SHOWN} more listed in the package
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export function RetrievalHints({ pkg }: { pkg: ContextPackage }) {
  return (
    <Panel
      title="Retrieval hints"
      aside={<span className="text-fg-subtle text-xs">MCP calls for detail left out</span>}
    >
      {pkg.retrieval.length === 0 ? (
        <p className="px-4 py-3 text-fg-subtle text-xs">None.</p>
      ) : (
        <ul className="divide-y divide-border">
          {pkg.retrieval.map((hint, i) => {
            const args = JSON.stringify(hint.arguments, null, 2)
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: hints are an immutable, ordered list; one tool may repeat
              <li key={i} className="space-y-1 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <code className="font-mono font-semibold text-sm">{hint.tool}</code>
                  <span className="min-w-0 flex-1 text-fg-muted text-xs">{hint.purpose}</span>
                  <CopyButton text={args} label={`Copy the arguments for ${hint.tool}`} />
                </div>
                <ScrollRegion
                  as="pre"
                  label={`Arguments for ${hint.tool}`}
                  className="max-h-48 overflow-auto rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-fg leading-relaxed scrollbar-thin"
                >
                  {args}
                </ScrollRegion>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

/**
 * A context package in full: header, the blocked notice, `children` (the handoff actions), the
 * mandatory sections, optional items by role, omissions and retrieval hints. Everything in it is
 * rendered as text.
 */
export function PackageView({
  result,
  headRevision,
  lookup,
  renderSplitAction,
  children,
}: {
  result: ContextPackageResult
  headRevision: number
  lookup: PackageLookup
  renderSplitAction?: ((split: string[], index: number) => ReactNode) | undefined
  children?: ReactNode
}) {
  const titleId = useId()
  const pkg = result.package
  return (
    <section aria-labelledby={titleId} className="space-y-4" data-package-view>
      <PackageHeader result={result} headRevision={headRevision} titleId={titleId} />
      <BlockedNotice pkg={pkg} lookup={lookup} renderSplitAction={renderSplitAction} />
      {children}
      <MandatorySections pkg={pkg} lookup={lookup} />
      <OptionalItems pkg={pkg} lookup={lookup} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Omissions pkg={pkg} lookup={lookup} />
        <RetrievalHints pkg={pkg} />
      </div>
    </section>
  )
}
