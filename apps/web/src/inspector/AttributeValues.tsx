import { cn } from '../lib/cn.ts'
import { humanize } from '../model/format.ts'

type Item = Record<string, unknown> & { name: string }

/** A list of named records with plain values, such as an entity's fields or a route's parameters. */
function isNamedList(v: unknown): v is Item[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        !Array.isArray(x) &&
        typeof (x as Record<string, unknown>).name === 'string' &&
        Object.values(x).every((y) => ['string', 'number', 'boolean'].includes(typeof y)),
    )
  )
}

/** How a detail of a named record reads after its name and type. */
const DETAIL: Record<string, (v: string) => string> = {
  references: (v) => `references ${v}`,
  relationship: (v) => `relationship to ${v}`,
  inheritedFrom: (v) => `inherited from ${v}`,
  in: (v) => `in ${v}`,
}

/** Each record on its own line: name and type, then its other details in words. */
function NamedList({ items }: { items: Item[] }) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => {
        const { name, type, ...rest } = item
        const details = Object.entries(rest).map(([k, v]) =>
          (DETAIL[k] ?? ((s: string) => `${humanize(k).toLowerCase()} ${s}`))(String(v)),
        )
        return (
          // A name can repeat (a field redeclared with another type), so the details count too.
          <li key={JSON.stringify(item)} className="px-2.5 py-1.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium font-mono text-xs">{name}</span>
              {type !== undefined && (
                <span className="break-all font-mono text-fg-muted text-xs">{String(type)}</span>
              )}
            </p>
            {details.length > 0 && <p className="text-fg-muted text-xs">{details.join(' · ')}</p>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * An element's attributes for a person: text as text, lists of named records (fields, parameters)
 * one per line, and anything else as compact JSON.
 */
export function AttributeValues({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return <p className="text-fg-muted text-xs">None.</p>
  return (
    <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
      {entries.map(([k, v]) => {
        const list = isNamedList(v)
        return (
          <div key={k} className="contents">
            <dt className="truncate font-mono text-fg-muted text-xs leading-5" title={k}>
              {k}
              {list && ` (${v.length})`}
            </dt>
            {/* A list takes the whole width, under its name. */}
            <dd className={cn('min-w-0 break-words', list && 'col-span-2')}>
              {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? (
                String(v)
              ) : list ? (
                <NamedList items={v} />
              ) : (
                <code className="font-mono text-xs">{JSON.stringify(v)}</code>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
