import type { Claim, EvidenceView, ObjectVersion, RelationVersion } from '@kalyth/contracts'
import { ArrowRight, EyeOff, MousePointerClick, X } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import type { ClaimFreshness } from '../api/freshness.ts'
import { useEvidence, useTypes } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  BasisBadge,
  ConfidenceBadge,
  DecisionStatusBadge,
  EdgeSample,
  FreshnessBadge,
  LifecycleBadge,
  MockBadge,
  StanceBadge,
  TypeLabel,
} from '../components/badges.tsx'
import { Button, CopyButton, EmptyState, SectionTitle, Skeleton, Tip } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, humanize, plural, shortId, shortSha } from '../model/format.ts'
import { objectLabel } from '../model/labels.ts'
import { isMockClaim } from '../model/navigator.ts'
import { evidenceLocation } from '../model/ops.ts'
import { basisMeta, relationMeta } from '../model/semantics.ts'
import { SummariseAction } from '../navigator/NavigatorActions.tsx'
import { ErrorNotice, RecordLink } from '../views/shared.tsx'

export function Inspector({ onClose }: { onClose: () => void }) {
  const wb = useWorkbench()
  const id = wb.selection
  const object = id ? wb.model?.objectById.get(id) : undefined
  const relation = id ? wb.model?.relationById.get(id) : undefined

  let body: ReactNode
  if (wb.group) {
    body = <RelationGroup />
  } else if (!id) {
    body = (
      <EmptyState icon={<MousePointerClick />} title="Nothing selected" className="py-16">
        Select a node, edge or record to see its claim, evidence and provenance.
      </EmptyState>
    )
  } else if (!wb.model) {
    body = (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-20" />
        <Skeleton className="h-32" />
      </div>
    )
  } else if (object) {
    body = <ObjectDetails object={object} />
  } else if (relation) {
    body = <RelationDetails relation={relation} />
  } else {
    body = (
      <EmptyState icon={<EyeOff />} title={`Not present at r${wb.revision}`} className="py-16">
        <span className="font-mono text-xs">{shortId(id)}</span> does not exist or is retired at
        this revision.
      </EmptyState>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3">
        <h2 className="font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
          Inspector
        </h2>
        <Tip label="Close (i)">
          <Button variant="ghost" size="icon-sm" aria-label="Close Inspector" onClick={onClose}>
            <X aria-hidden />
          </Button>
        </Tip>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin">{body}</div>
    </div>
  )
}

// ---------- objects and relations ----------

function Header({
  kicker,
  title,
  id,
  mono,
}: {
  kicker: ReactNode
  title: string
  id: string
  mono?: boolean
}) {
  return (
    <div className="space-y-1 border-border border-b px-4 pt-3 pb-3">
      <div className="text-fg-muted text-xs">{kicker}</div>
      <h3
        className={cn(
          'break-words font-semibold text-[15px] text-fg leading-snug',
          mono && 'font-mono text-sm',
        )}
      >
        {title}
      </h3>
      <div className="flex items-center gap-1 text-fg-subtle">
        <code className="truncate font-mono text-2xs">{id}</code>
        <CopyButton text={id} label="Copy id" />
      </div>
    </div>
  )
}

function ObjectDetails({ object }: { object: ObjectVersion }) {
  const wb = useWorkbench()
  const types = useTypes()
  const description = types.data?.objectTypes.find((t) => t.type === object.type)?.description
  const freshness = wb.freshness.index.get(object.id)
  const attributes = object.attributes as Record<string, unknown>
  const decisionStatus =
    (object.type === 'core.Decision' || object.type === 'core.Alternative') &&
    typeof attributes.status === 'string'
      ? attributes.status
      : undefined
  const { outgoing, incoming } = useMemo(() => {
    const rels = wb.model?.relations ?? []
    return {
      outgoing: rels.filter((r) => r.from === object.id),
      incoming: rels.filter((r) => r.to === object.id),
    }
  }, [wb.model, object.id])

  return (
    <div>
      <Header
        kicker={
          <span className="flex items-center gap-2">
            <TypeLabel type={object.type} showPack />
          </span>
        }
        title={objectLabel(object)}
        id={object.id}
        mono={object.type === 'software.Module'}
      />
      <Facets
        claim={object.claim}
        stance={<StanceBadge stance={object.stance} />}
        lifecycle={<LifecycleBadge lifecycle={object.lifecycle} />}
        freshness={freshness}
        extra={decisionStatus ? <DecisionStatusBadge status={decisionStatus} /> : null}
      />
      {description && (
        <p className="border-border border-b px-4 py-2 text-fg-muted text-xs">{description}</p>
      )}
      {object.type.startsWith('software.') && object.lifecycle === 'active' && (
        <SummariseAction key={object.id} object={object} />
      )}
      <ClaimSection claim={object.claim} freshness={freshness} selfId={object.id} />
      <Section title="Attributes">
        <KeyValues values={attributes} />
      </Section>
      <Section
        title="Relations"
        aside={<span className="text-fg-subtle text-xs">{outgoing.length + incoming.length}</span>}
      >
        <RelationList direction="out" relations={outgoing} />
        <RelationList direction="in" relations={incoming} />
        {outgoing.length + incoming.length === 0 && (
          <p className="text-fg-muted text-xs">No active relations.</p>
        )}
      </Section>
      <VersionFooter revision={object.revision} retiredReason={object.retiredReason} />
    </div>
  )
}

function RelationDetails({ relation }: { relation: RelationVersion }) {
  const wb = useWorkbench()
  const types = useTypes()
  const description =
    types.data?.relationTypes.find((t) => t.type === relation.type)?.description ??
    relationMeta(relation.type).description
  const freshness = wb.freshness.index.get(relation.id)
  const meta = relationMeta(relation.type)
  return (
    <div>
      <Header
        kicker={
          <span className="flex items-center gap-2">
            <EdgeSample color={meta.color} dash={basisMeta(relation.claim.basis).dash} width={22} />
            <span className="font-mono">{relation.type}</span>
            <span className="text-fg-subtle">relation</span>
          </span>
        }
        title={`${wb.model?.nameOf(relation.from) ?? shortId(relation.from)} → ${wb.model?.nameOf(relation.to) ?? shortId(relation.to)}`}
        id={relation.id}
      />
      <Facets
        claim={relation.claim}
        stance={<StanceBadge stance={relation.stance} />}
        lifecycle={<LifecycleBadge lifecycle={relation.lifecycle} />}
        freshness={freshness}
      />
      <p className="border-border border-b px-4 py-2 text-fg-muted text-xs">{description}</p>
      <Section title="Endpoints">
        <dl className="grid grid-cols-[52px_1fr] gap-x-2 gap-y-1.5 text-sm">
          <dt className="text-fg-muted text-xs leading-5">From</dt>
          <dd className="min-w-0">
            <EndpointLink id={relation.from} />
          </dd>
          <dt className="text-fg-muted text-xs leading-5">To</dt>
          <dd className="min-w-0">
            <EndpointLink id={relation.to} />
          </dd>
        </dl>
      </Section>
      <ClaimSection claim={relation.claim} freshness={freshness} selfId={relation.id} />
      {Object.keys(relation.properties).length > 0 && (
        <Section title="Properties">
          <KeyValues values={relation.properties as Record<string, unknown>} />
        </Section>
      )}
      <VersionFooter revision={relation.revision} retiredReason={relation.retiredReason} />
    </div>
  )
}

function EndpointLink({ id }: { id: string }) {
  const wb = useWorkbench()
  const object = wb.model?.objectById.get(id)
  return (
    <span className="flex min-w-0 items-center gap-2">
      {object && <TypeLabel type={object.type} className="shrink-0 text-fg-muted text-xs" />}
      <RecordLink id={id} />
    </span>
  )
}

function Facets({
  claim,
  stance,
  lifecycle,
  freshness,
  extra,
}: {
  claim: Claim
  stance: ReactNode
  lifecycle: ReactNode
  freshness: ClaimFreshness | undefined
  extra?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-border border-b px-4 py-2.5">
      {isMockClaim(claim) && <MockBadge />}
      <BasisBadge basis={claim.basis} />
      {claim.confidence && <ConfidenceBadge level={claim.confidence.level} />}
      {freshness && <FreshnessBadge status={freshness.status} />}
      {stance}
      {lifecycle}
      {extra}
    </div>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-border border-b px-4 py-3">
      <SectionTitle aside={aside}>{title}</SectionTitle>
      {children}
    </section>
  )
}

function ClaimSection({
  claim,
  freshness,
  selfId,
}: {
  claim: Claim
  freshness: ClaimFreshness | undefined
  selfId: string
}) {
  const meta = basisMeta(claim.basis)
  const stale = new Set(freshness?.staleEvidence ?? [])
  return (
    <>
      <Section title="Claim">
        <p className="text-fg-muted text-xs">{meta.description}</p>
        <dl className="mt-2 space-y-2 text-sm">
          {claim.confidence && (
            <Fact label="Confidence">
              <span className="font-medium">{humanize(claim.confidence.level)}</span>
              <span className="block text-fg-muted text-xs">{claim.confidence.rationale}</span>
            </Fact>
          )}
          {claim.observation && (
            <Fact label="Observed by">
              <span className="font-mono text-xs">
                {claim.observation.tool} {claim.observation.toolVersion}
              </span>
              <span className="mt-1 block text-xs">
                <span className="text-fg-muted">Coverage: </span>
                {claim.observation.coverage}
              </span>
              {claim.observation.limitations && (
                <span className="mt-1 block text-xs">
                  <span className="text-fg-muted">Limitations: </span>
                  {claim.observation.limitations}
                </span>
              )}
            </Fact>
          )}
          {claim.method && (
            <Fact label="Method">
              <span className="font-mono text-xs">{claim.method}</span>
            </Fact>
          )}
          {claim.model && (
            <Fact label="Model">
              <span className="font-mono text-xs">
                {claim.model.provider} / {claim.model.model}
              </span>
            </Fact>
          )}
          {freshness && (
            <Fact label="Freshness">
              <FreshnessBadge status={freshness.status} size="sm" />
              {freshness.reason && (
                <span className="mt-1 block text-fg-muted text-xs">{freshness.reason}</span>
              )}
            </Fact>
          )}
        </dl>
      </Section>
      <EvidenceSection claim={claim} stale={stale} />
      {claim.derivedFrom.length > 0 && (
        <Section
          title="Derived from"
          aside={<span className="text-fg-subtle text-xs">{claim.derivedFrom.length}</span>}
        >
          <p className="mb-1.5 text-fg-muted text-xs">
            Claims this one builds on. Derived claims are not independent corroboration.
          </p>
          <ul className="space-y-1">
            {claim.derivedFrom
              .filter((d) => d !== selfId)
              .map((d) => (
                <li key={d} className="flex min-w-0 items-center gap-1.5 text-sm">
                  <ArrowRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
                  <RecordLink id={d} />
                </li>
              ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2">
      <dt className="pt-0.5 text-fg-muted text-xs">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function EvidenceSection({ claim, stale }: { claim: Claim; stale: ReadonlySet<string> }) {
  const wb = useWorkbench()
  const ids = useMemo(
    () => [...claim.supports.flatMap((g) => g.allOf), ...claim.contradictedBy],
    [claim],
  )
  const evidence = useEvidence(wb.projectId, ids)
  const byId = useMemo(() => new Map((evidence.data ?? []).map((e) => [e.id, e])), [evidence.data])
  const count = new Set(ids).size
  return (
    <Section title="Evidence" aside={<span className="text-fg-subtle text-xs">{count}</span>}>
      {count === 0 ? (
        <p className="text-fg-muted text-xs">
          No evidence cited.{' '}
          {claim.basis === 'stated' ? 'Stated claims rest on the principal who stated them.' : ''}
        </p>
      ) : evidence.error ? (
        <ErrorNotice error={evidence.error} title="Evidence could not be loaded" />
      ) : evidence.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="space-y-2">
          {claim.supports.length > 1 && (
            <p className="text-fg-muted text-xs">
              {claim.supports.length} alternative groups. Every item in a group is required; any one
              complete group supports the claim.
            </p>
          )}
          {claim.supports.map((group, i) => (
            <div key={group.allOf.join(',')}>
              {i > 0 && (
                <div className="my-2 flex items-center gap-2 text-2xs text-fg-subtle uppercase tracking-[0.06em]">
                  <span className="h-px flex-1 bg-border" /> or{' '}
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              {claim.supports.length > 1 && (
                <p className="mb-1 font-medium text-fg-muted text-xs">
                  Group {i + 1} ·{' '}
                  {group.allOf.length > 1 ? `all ${group.allOf.length} required` : '1 item'}
                </p>
              )}
              <ul className="space-y-1.5">
                {group.allOf.map((evidenceId) => (
                  <li key={evidenceId}>
                    <EvidenceCard
                      id={evidenceId}
                      evidence={byId.get(evidenceId)}
                      stale={stale.has(evidenceId)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {claim.contradictedBy.length > 0 && (
            <div className="pt-1">
              <p className="tone-danger mb-1 font-medium text-tone-fg text-xs">
                Contradicted by {plural(claim.contradictedBy.length, 'item')}
              </p>
              <ul className="space-y-1.5">
                {claim.contradictedBy.map((evidenceId) => (
                  <li key={evidenceId}>
                    <EvidenceCard
                      id={evidenceId}
                      evidence={byId.get(evidenceId)}
                      stale={false}
                      contradicting
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function EvidenceCard({
  id,
  evidence,
  stale,
  contradicting,
}: {
  id: string
  evidence: EvidenceView | undefined
  stale: boolean
  contradicting?: boolean
}) {
  if (!evidence) {
    return (
      <div className="rounded-md border border-border border-dashed px-2.5 py-2 text-fg-muted text-xs">
        <span className="font-mono">{shortId(id)}</span> was not returned by the server.
      </div>
    )
  }
  const where = evidenceLocation(evidence.source)
  const source = evidence.source
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border bg-surface',
        contradicting ? 'tone-danger border-tone-bd' : 'border-border',
      )}
    >
      <div className="flex items-start gap-2 px-2.5 pt-2 pb-1.5">
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-fg text-xs" title={where.primary}>
            {where.primary}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-fg-subtle">
            {source.kind === 'sourceSpan' ? (
              <>
                <span className="truncate">{source.repo}</span>
                <span className="font-mono" title={source.commit}>
                  @{shortSha(source.commit)}
                </span>
                {source.symbol && <span className="font-mono">{source.symbol}</span>}
              </>
            ) : (
              <span>{where.secondary}</span>
            )}
          </p>
        </div>
        {stale && (
          <span className="tone-danger shrink-0 rounded border border-tone-bd bg-tone-bg px-1 font-medium text-2xs text-tone-fg">
            Changed
          </span>
        )}
      </div>
      {evidence.excerptRedacted ? (
        <p className="tone-warning flex items-center gap-1.5 border-tone-bd border-t bg-tone-bg px-2.5 py-1.5 text-tone-fg text-xs">
          <EyeOff aria-hidden className="size-3.5" />
          <span>
            <strong className="font-semibold">Redacted</strong>: the excerpt matched a secret
            pattern and was not stored. Only its hash is kept.
          </span>
        </p>
      ) : evidence.excerptText !== null ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-border border-t bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-fg leading-relaxed scrollbar-thin">
          {evidence.excerptText}
        </pre>
      ) : (
        <p className="border-border border-t px-2.5 py-1.5 text-fg-subtle text-xs">
          No excerpt recorded.
        </p>
      )}
      <p className="border-border border-t px-2.5 py-1 text-2xs text-fg-subtle">
        Collected by{' '}
        <span className="font-mono">
          {evidence.collectedBy.tool} {evidence.collectedBy.toolVersion}
        </span>{' '}
        <time dateTime={evidence.collectedAt} title={absoluteTime(evidence.collectedAt)}>
          · r{evidence.revision}
        </time>
      </p>
    </div>
  )
}

function KeyValues({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return <p className="text-fg-muted text-xs">None.</p>
  return (
    <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate font-mono text-fg-muted text-xs leading-5" title={k}>
            {k}
          </dt>
          <dd className="min-w-0 break-words">
            {typeof v === 'string' ? (
              v
            ) : (
              <code className="font-mono text-xs">{JSON.stringify(v)}</code>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const LIST_LIMIT = 12

function RelationList({
  direction,
  relations,
}: {
  direction: 'in' | 'out'
  relations: RelationVersion[]
}) {
  const wb = useWorkbench()
  if (relations.length === 0) return null
  const byType = new Map<string, RelationVersion[]>()
  for (const r of relations) byType.set(r.type, [...(byType.get(r.type) ?? []), r])
  return (
    <div className="mb-2 space-y-2">
      <p className="text-2xs text-fg-subtle">{direction === 'out' ? 'Outgoing' : 'Incoming'}</p>
      {[...byType.entries()].map(([type, list]) => (
        <div key={type}>
          <p className="mb-0.5 flex items-center gap-1.5 font-mono text-fg-muted text-xs">
            <EdgeSample color={relationMeta(type).color} dash={undefined} width={14} />
            {direction === 'in' ? `← ${type}` : `${type} →`}
            <span className="text-fg-subtle">{list.length}</span>
          </p>
          <ul className="space-y-0.5 pl-5">
            {list.slice(0, LIST_LIMIT).map((r) => {
              const other = direction === 'out' ? r.to : r.from
              return (
                <li key={r.id} className="flex min-w-0 items-center gap-1.5 text-sm">
                  <RecordLink id={other} />
                  <button
                    type="button"
                    onClick={() => wb.select(r.id)}
                    className="shrink-0 rounded px-1 text-2xs text-fg-subtle hover:bg-surface-2 hover:text-fg"
                    aria-label={`Inspect the ${type} relation`}
                  >
                    {basisMeta(r.claim.basis).short}
                  </button>
                </li>
              )
            })}
            {list.length > LIST_LIMIT && (
              <li className="text-fg-subtle text-xs">and {list.length - LIST_LIMIT} more</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  )
}

function VersionFooter({
  revision,
  retiredReason,
}: {
  revision: number
  retiredReason: string | null
}) {
  const wb = useWorkbench()
  return (
    <div className="space-y-1 px-4 py-3 text-fg-muted text-xs">
      <p>
        This version became current at <span className="font-mono text-fg">r{revision}</span>
        {wb.isHistorical ? (
          <>
            ; you are viewing <span className="font-mono text-fg">r{wb.revision}</span>.
          </>
        ) : (
          '.'
        )}
      </p>
      {retiredReason && (
        <p>
          <span className="font-medium text-fg">Retired:</span> {retiredReason}
        </p>
      )}
    </div>
  )
}

// ---------- aggregated edges ----------

function RelationGroup() {
  const wb = useWorkbench()
  const group = wb.group
  if (!group) return null
  const relations = group.relationIds
    .map((id) => wb.model?.relationById.get(id))
    .filter((r): r is RelationVersion => r !== undefined)
  return (
    <div>
      <div className="space-y-1 border-border border-b px-4 pt-3 pb-3">
        <p className="text-fg-muted text-xs">Aggregated edge</p>
        <h3 className="break-words font-semibold text-[15px] leading-snug">{group.title}</h3>
        <p className="text-fg-muted text-xs">
          {plural(relations.length, 'relation')} between members of collapsed groups. Expand the
          groups in the graph to see each one, or pick one below.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {relations.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => wb.select(r.id)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {wb.model?.nameOf(r.from) ?? shortId(r.from)}
                </span>
                <span className="block truncate text-fg-muted text-xs">
                  {r.type} → {wb.model?.nameOf(r.to) ?? shortId(r.to)}
                </span>
              </span>
              <BasisBadge basis={r.claim.basis} size="sm" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
