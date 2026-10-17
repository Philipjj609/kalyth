import type { GroundingReport, ModelCallRecord, NavigatorRun } from '@kalyth/contracts'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { CallOutcomeBadge } from '../components/badges.tsx'
import { Panel } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural } from '../model/format.ts'
import {
  callTokens,
  exactMicroUsd,
  formatLatency,
  formatMicroUsd,
  outputCounts,
} from '../model/navigator.ts'

/**
 * Presentational pieces of a run report. They take plain data and render it as text, so they can
 * be rendered and tested without the workbench around them.
 */

/** A USD amount from micro-dollars, four decimals, with the exact amount in the title. */
export function Usd({ micro, className }: { micro: number; className?: string }) {
  return (
    <span className={cn('font-mono tabular-nums', className)} title={exactMicroUsd(micro)}>
      {formatMicroUsd(micro)}
    </span>
  )
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'success' | 'caution' | 'danger' | undefined
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 rounded-md border px-3 py-2',
        tone ? `tone-${tone} border-tone-bd bg-tone-bg` : 'border-border',
      )}
    >
      <dt className="text-fg-muted text-xs">{label}</dt>
      <dd
        className={cn(
          'font-semibold text-[20px] leading-7 tabular-nums tracking-tight',
          tone && 'text-tone-fg',
        )}
      >
        {value}
      </dd>
      {hint && <dd className="text-fg-subtle text-xs">{hint}</dd>}
    </div>
  )
}

/**
 * What the grounding validator checked (ADR 0010). Rejections are the point: each one is an item
 * the model wrote that Kalyth refused to propose because a citation did not hold.
 */
export function GroundingReportPanel({
  grounding,
  status,
}: {
  grounding: GroundingReport | null
  status: NavigatorRun['status']
}) {
  const headingId = useId()
  if (!grounding) {
    return (
      <Panel title="Grounding">
        <p className="p-4 text-fg-muted text-sm">
          {status === 'running'
            ? 'Citations are checked when the model has answered.'
            : 'No grounding report: the run ended before any output was checked.'}
        </p>
      </Panel>
    )
  }
  const rejected = grounding.itemsRejected
  const allValid = grounding.validCitations === grounding.citations
  return (
    <Panel
      title="Grounding"
      aside={<span className="text-fg-subtle text-xs">checked against pinned evidence</span>}
    >
      <dl className="grid grid-cols-3 gap-3 p-4">
        <Figure
          label="Valid citations"
          value={
            <>
              {grounding.validCitations.toLocaleString('en')}
              <span className="font-normal text-[15px] text-fg-muted">
                {' '}
                of {grounding.citations.toLocaleString('en')}
              </span>
            </>
          }
          hint={grounding.citations === 0 ? 'nothing was cited' : 'quote found in a pinned excerpt'}
          tone={grounding.citations > 0 && !allValid ? 'caution' : undefined}
        />
        <Figure label="Items kept" value={grounding.itemsKept.toLocaleString('en')} />
        <Figure
          label="Items rejected"
          value={rejected.length.toLocaleString('en')}
          tone={rejected.length > 0 ? 'danger' : undefined}
        />
      </dl>
      {rejected.length > 0 ? (
        <section
          aria-labelledby={headingId}
          className="tone-danger mx-4 mb-4 overflow-hidden rounded-md border border-tone-bd bg-tone-bg"
        >
          <h4
            id={headingId}
            className="flex items-center gap-2 px-3 pt-2.5 font-semibold text-sm text-tone-fg"
          >
            <ShieldX aria-hidden className="size-4 shrink-0" />
            {plural(rejected.length, 'item')} rejected and not proposed
          </h4>
          <p className="px-3 pt-0.5 pb-2.5 text-fg-muted text-xs">
            An item with any invalid citation is dropped, never repaired. A citation holds only when
            its excerpt was in the model’s context, the quote occurs in it, and the excerpt still
            matches its pinned hash.
          </p>
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Rejected items with their reason and reference</caption>
            <thead className="text-left text-tone-fg text-xs">
              <tr>
                <th scope="col" className="border-tone-bd border-t px-3 py-1.5 font-medium">
                  Item
                </th>
                <th scope="col" className="border-tone-bd border-t px-3 py-1.5 font-medium">
                  Reason
                </th>
                <th scope="col" className="border-tone-bd border-t px-3 py-1.5 font-medium">
                  Ref
                </th>
              </tr>
            </thead>
            <tbody>
              {rejected.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the report is immutable and ordered
                <tr key={i} className="bg-surface/60 align-top">
                  <td className="border-tone-bd border-t px-3 py-2 font-medium text-fg">
                    {r.item}
                  </td>
                  <td className="break-words border-tone-bd border-t px-3 py-2 text-fg">
                    {r.reason}
                  </td>
                  <td className="border-tone-bd border-t px-3 py-2">
                    {r.ref ? (
                      <code className="break-all font-mono text-fg text-xs">{r.ref}</code>
                    ) : (
                      <span className="text-fg-subtle text-xs">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="tone-success mx-4 mb-4 flex items-center gap-2 rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-sm text-tone-fg">
          <ShieldCheck aria-hidden className="size-4 shrink-0" />
          No item was rejected.
        </p>
      )}
    </Panel>
  )
}

export function OutputCountsPanel({ output }: { output: NavigatorRun['output'] }) {
  const counts = outputCounts(output)
  return (
    <Panel title="Output">
      {counts.length === 0 ? (
        <p className="p-4 text-fg-muted text-sm">Nothing produced yet.</p>
      ) : (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
          {counts.map(([label, n]) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className={cn('text-right font-mono tabular-nums', n === 0 && 'text-fg-subtle')}>
                {n.toLocaleString('en')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  )
}

export function ModelCallsPanel({
  calls,
  totalMicroUsd,
}: {
  calls: readonly ModelCallRecord[]
  totalMicroUsd: number
}) {
  const head = 'border-border border-b px-3 py-2 font-medium'
  const cell = 'border-border border-b px-3 py-2 align-top'
  return (
    <Panel
      title="Model calls"
      aside={
        <span className="text-fg-subtle text-xs">
          {plural(calls.length, 'call')} · <Usd micro={totalMicroUsd} /> total
        </span>
      }
    >
      {calls.length === 0 ? (
        <p className="p-4 text-fg-muted text-sm">No model call was made.</p>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">
              Model calls in order, with outcome, usage and cost
            </caption>
            <thead className="bg-surface-2 text-left text-fg-muted text-xs">
              <tr>
                <th scope="col" className={head}>
                  Purpose
                </th>
                <th scope="col" className={head}>
                  Model
                </th>
                <th scope="col" className={cn(head, 'text-right')}>
                  Attempt
                </th>
                <th scope="col" className={head}>
                  Outcome
                </th>
                <th scope="col" className={cn(head, 'text-right')}>
                  Tokens
                </th>
                <th scope="col" className={cn(head, 'text-right')}>
                  Cost
                </th>
                <th scope="col" className={cn(head, 'text-right')}>
                  Latency
                </th>
                <th scope="col" className={head}>
                  Issues
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: call records are immutable and ordered
                <tr key={i}>
                  <td className={cn(cell, 'font-mono text-xs')}>{c.purpose}</td>
                  <td className={cn(cell, 'font-mono text-xs')}>
                    <span className="block">{c.model}</span>
                    <span className="block text-fg-subtle">{c.provider}</span>
                  </td>
                  <td className={cn(cell, 'text-right font-mono text-xs tabular-nums')}>
                    {c.attempt}
                  </td>
                  <td className={cell}>
                    <CallOutcomeBadge outcome={c.outcome} size="sm" />
                  </td>
                  <td className={cn(cell, 'whitespace-nowrap text-right font-mono text-xs')}>
                    {callTokens(c)}
                  </td>
                  <td className={cn(cell, 'whitespace-nowrap text-right text-xs')}>
                    <Usd micro={c.costMicroUsd} />
                    <span className="block text-fg-subtle">
                      reserved <Usd micro={c.reservedMicroUsd} />
                    </span>
                  </td>
                  <td className={cn(cell, 'whitespace-nowrap text-right font-mono text-xs')}>
                    {formatLatency(c.latencyMs)}
                  </td>
                  <td className={cn(cell, 'min-w-[200px] text-xs')}>
                    {c.issues.length === 0 ? (
                      <span className="text-fg-subtle">none</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {c.issues.map((issue, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: issues are an immutable list
                          <li key={j} className="break-words text-fg-muted">
                            {issue}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
