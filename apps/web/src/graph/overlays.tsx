import type { ObjectVersion } from '@kalyth/contracts'
import type { ReactNode } from 'react'
import type { Lens } from '../app/location.ts'
import { cn } from '../lib/cn.ts'
import { shortSha } from '../model/format.ts'
import { withoutHandles } from '../views/shared.tsx'
import { relationColor } from './edges.tsx'
import type { DecisionMarks } from './lens.ts'

/**
 * What sits on the sheet besides the drawing: a caption that says what the lens shows, a compact
 * legend for the current lens, and a title block (project, source, revision, lens, stale count),
 * as on an engineering drawing. Overlays sit outside the React Flow application region, so
 * screen readers read them as ordinary page content.
 */

export function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="pointer-events-auto max-w-full truncate bg-[color-mix(in_oklab,var(--k-canvas)_88%,transparent)] px-1 text-[12.5px] text-fg-muted">
      {children}
    </p>
  )
}

function Swatch({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn('mt-0.5 inline-block h-3 w-[22px] shrink-0', className)}
      style={style}
    />
  )
}

function LineSwatch({
  dash,
  color = 'var(--k-fg)',
  mark,
}: {
  dash?: string
  color?: string
  mark?: boolean
}) {
  return (
    <svg aria-hidden width="22" height="12" className="mt-0.5 shrink-0 overflow-visible">
      <line
        x1="0"
        y1="6"
        x2="22"
        y2="6"
        style={{ stroke: color }}
        strokeWidth="1.5"
        strokeDasharray={dash}
      />
      {mark && (
        <rect
          x="7.5"
          y="2.5"
          width="7"
          height="7"
          transform="rotate(45 11 6)"
          style={{ fill: 'var(--k-surface)', stroke: 'var(--k-accent)' }}
          strokeWidth="1.5"
        />
      )}
    </svg>
  )
}

function Entry({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {swatch}
      <span className="min-w-0">{children}</span>
    </li>
  )
}

const HATCH_IMPACT =
  'repeating-linear-gradient(135deg, var(--k-impact-soft) 0 2px, transparent 2px 7px), var(--k-surface)'
const HATCH_REVISION =
  'repeating-linear-gradient(135deg, var(--k-revision-soft) 0 2px, transparent 2px 7px), var(--k-surface)'

export function Legend({
  lens,
  relationTypes,
  decisions,
  altKey,
}: {
  lens: Lens
  relationTypes: readonly string[]
  decisions: DecisionMarks['legend']
  altKey: string | undefined
}) {
  return (
    <section
      aria-label="Legend"
      className="pointer-events-auto w-[212px] border border-border bg-surface px-2.5 py-2 text-[11.5px] text-fg leading-[15px]"
    >
      <h2 className="mb-1.5 font-mono text-[10px] text-fg-subtle uppercase tracking-[0.08em]">
        Legend · {lens === 'basis' ? 'claim basis' : lens}
      </h2>
      <ul className="space-y-1.5">
        {lens === 'basis' && (
          <>
            <Entry swatch={<LineSwatch />}>Observed: a tool read it in the source</Entry>
            <Entry swatch={<LineSwatch dash="6 4" color="var(--k-tone-inferred-bd)" />}>
              Inferred: proposed by a model or heuristic
            </Entry>
            <Entry swatch={<LineSwatch mark />}>Stated: what a person said</Entry>
          </>
        )}
        {lens === 'freshness' && (
          <>
            <Entry
              swatch={
                <Swatch
                  style={{ border: '1.5px solid var(--k-revision)', background: HATCH_REVISION }}
                />
              }
            >
              Revision mark: claims that no longer match the source; the triangle counts them
            </Entry>
            <Entry swatch={<Swatch style={{ border: '1px solid var(--k-fg)' }} />}>
              Current: evidence matches the source
            </Entry>
          </>
        )}
        {lens === 'impact' && (
          <>
            <Entry
              swatch={
                <Swatch
                  style={{ border: '1.5px solid var(--k-accent)', background: HATCH_IMPACT }}
                />
              }
            >
              Changed directly{altKey ? ` by ${altKey}` : ''}; the balloon numbers the change
            </Entry>
            <Entry swatch={<Swatch style={{ border: '1.5px dashed var(--k-accent)' }} />}>
              New element the alternative proposes
            </Entry>
            <Entry swatch={<Swatch style={{ border: '1px solid var(--k-accent)' }} />}>
              Reached only through propagated impact
            </Entry>
          </>
        )}
        {lens === 'decisions' &&
          (decisions.length === 0 ? (
            <li className="text-fg-muted">No open or accepted decision changes the model yet.</li>
          ) : (
            decisions.map((d) => (
              <Entry
                key={d.id}
                swatch={
                  <span
                    aria-hidden
                    className="mt-px shrink-0 bg-accent px-1 font-mono font-semibold text-[9px] text-accent-fg leading-[14px]"
                  >
                    {d.key}
                  </span>
                }
              >
                <span className="line-clamp-2">{withoutHandles(d.title)}</span>
                <span className="text-fg-subtle"> · {d.status}</span>
              </Entry>
            ))
          ))}
        {lens !== 'decisions' && (
          <Entry swatch={<Swatch style={{ border: '1.5px dashed var(--k-fg-subtle)' }} />}>
            Proposed (to-be) element, not built yet
          </Entry>
        )}
      </ul>
      {lens === 'basis' && relationTypes.length > 0 && (
        <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 border-border border-t pt-1.5">
          {relationTypes.map((t) => (
            <li key={t} className="flex min-w-0 items-center gap-1.5">
              <LineSwatch color={relationColor(t)} />
              <span className="truncate font-mono text-[10.5px]">{t}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface TitleBlockData {
  project: string
  source: string
  revision: string
  lens: string
  stale: string
  shown: string
}

export function TitleBlock({ data, compact }: { data: TitleBlockData; compact: boolean }) {
  const rows: [string, string][] = compact
    ? [
        ['Revision', data.revision],
        ['Lens', data.lens],
        ['Stale', data.stale],
      ]
    : [
        ['Project', data.project],
        ['Source', data.source],
        ['Revision', data.revision],
        ['Lens', data.lens],
        ['Stale', data.stale],
        ['Shown', data.shown],
      ]
  return (
    <section
      aria-label="Title block"
      className="pointer-events-auto w-[212px] border border-fg bg-surface font-mono text-[10px] leading-[13px]"
    >
      <dl className="grid grid-cols-[auto_1fr]">
        {rows.map(([k, v], i) => (
          <div key={k} className="contents">
            <dt
              className={cn(
                'border-border border-r px-1.5 py-[3px] text-fg-subtle uppercase tracking-[0.07em]',
                i < rows.length - 1 && 'border-b',
              )}
            >
              {k}
            </dt>
            <dd
              className={cn(
                'min-w-0 break-words px-1.5 py-[3px] text-fg',
                i < rows.length - 1 && 'border-border border-b',
              )}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** "github.com/x/y @ 0.12.0 · 84c5a9e" for the source snapshots in the model. */
export function sourceLine(objects: readonly ObjectVersion[]): string {
  const snapshots = objects.filter(
    (o) => o.type === 'core.SourceSnapshot' && o.lifecycle === 'active',
  )
  if (snapshots.length === 0) return 'no source snapshot'
  const describe = (o: ObjectVersion) => {
    const a = o.attributes as Record<string, unknown>
    const repo = typeof a.repo === 'string' ? a.repo.replace(/^github\.com\//, '') : 'repository'
    const commit = typeof a.commit === 'string' ? shortSha(a.commit).slice(0, 7) : ''
    const ref =
      typeof a.ref === 'string' && a.ref !== 'HEAD' && !/^[0-9a-f]{7,40}$/.test(a.ref) ? a.ref : ''
    return `${repo} @ ${[ref, commit].filter(Boolean).join(' · ')}`
  }
  const first = describe(snapshots[0] as ObjectVersion)
  return snapshots.length === 1 ? first : `${first} +${snapshots.length - 1} more`
}
