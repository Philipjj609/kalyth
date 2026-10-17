import type { ContextPackageSummary } from '@kalyth/contracts'
import { StatusBadge } from '../components/badges.tsx'
import { Panel } from '../components/ui.tsx'
import { absoluteTime, plural, relativeTime, shortId } from '../model/format.ts'
import { AppLink } from '../views/shared.tsx'

/** Packages compiled for the project, newest first, each a link to open it (ADR 0011). */
export function RecentPackages({
  packages,
  openId,
}: {
  packages: readonly ContextPackageSummary[]
  openId: string | undefined
}) {
  if (packages.length === 0) return null
  return (
    <Panel
      title="Recent packages"
      aside={<span className="text-fg-subtle text-xs">{plural(packages.length, 'package')}</span>}
    >
      <ul className="divide-y divide-border">
        {packages.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm"
            aria-current={p.id === openId ? 'true' : undefined}
          >
            <AppLink to={{ package: p.id }} className="min-w-0 flex-1 truncate font-medium">
              {p.taskTitle ?? `Focus on ${plural(p.focus.length, 'element')}`}
            </AppLink>
            {p.status === 'blocked' && (
              <StatusBadge
                tone="warning"
                label="Blocked"
                description="Its mandatory part exceeds the limit"
                size="sm"
              />
            )}
            {p.id === openId && <StatusBadge tone="accent" label="Open" size="sm" />}
            <span className="font-mono text-fg-muted text-xs">r{p.revision}</span>
            <span className="text-fg-muted text-xs">
              {plural(p.items, 'item')} · {p.chars.toLocaleString('en')} chars
            </span>
            <span className="font-mono text-fg-subtle text-xs" title={p.id}>
              {shortId(p.id)}
            </span>
            <time
              className="text-fg-subtle text-xs"
              dateTime={p.firstCompiledAt}
              title={absoluteTime(p.firstCompiledAt)}
            >
              {relativeTime(p.firstCompiledAt)}
            </time>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
