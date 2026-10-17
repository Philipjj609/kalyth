import { CircleX, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { type ApiErrorBody, isApiError } from '../api/client.ts'
import { type AppLocation, formatLocation, useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { cn } from '../lib/cn.ts'
import { shortId } from '../model/format.ts'

const CODE_TITLES: Record<string, string> = {
  stale: 'Stale: the model changed since this proposal’s base revision',
  conflicting: 'Conflicting: it violates an invariant at the current head',
  invalid: 'Invalid request',
  unauthorized: 'Not allowed',
  unauthenticated: 'Session expired',
  not_found: 'Not found',
  budget_exceeded: 'Budget exceeded',
  retryable: 'Temporarily unavailable',
}

const CODE_HINTS: Record<string, string> = {
  stale: 'Re-read the current state and propose again. Nothing was changed.',
  conflicting: 'Nothing was changed. Resolve the conflict and propose again.',
  unauthorized: 'This action needs a person acting directly, or a scope the session lacks.',
  retryable: 'Try again in a moment.',
}

export function errorBody(error: unknown): ApiErrorBody {
  if (isApiError(error)) return error.body
  return {
    code: 'error',
    message: error instanceof Error ? error.message : String(error),
    issues: [],
  }
}

/**
 * Renders the API error envelope in full: code, message, current revision, the references that
 * changed (resolved to names when the model knows them) and every issue.
 */
export function ErrorNotice({
  error,
  title,
  className,
  resolveName,
  onSelect,
}: {
  error: unknown
  title?: string
  className?: string
  resolveName?: (id: string) => string | undefined
  onSelect?: (id: string) => void
}) {
  const body = errorBody(error)
  const Icon = body.code === 'stale' || body.code === 'conflicting' ? TriangleAlert : OctagonAlert
  const tone = body.code === 'stale' ? 'caution' : 'danger'
  // Stale issues repeat the changed references listed above; show each reference once.
  const issues = body.changedRefs?.length
    ? body.issues.filter((i) => i.code !== 'stale.changed')
    : body.issues
  return (
    <div
      role="alert"
      className={cn(
        `tone-${tone}`,
        'rounded-md border border-tone-bd bg-tone-bg p-3 text-sm',
        className,
      )}
    >
      <div className="flex items-start gap-2 text-tone-fg">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title ?? CODE_TITLES[body.code] ?? 'Request failed'}</p>
          <p className="mt-0.5 break-words text-fg">{body.message}</p>
          {CODE_HINTS[body.code] && (
            <p className="mt-1 text-fg-muted text-xs">{CODE_HINTS[body.code]}</p>
          )}
        </div>
        <code className="shrink-0 rounded bg-surface/60 px-1.5 py-0.5 font-mono text-2xs">
          {body.code}
        </code>
      </div>
      {(body.currentRevision !== undefined || (body.changedRefs?.length ?? 0) > 0) && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pl-6 text-xs">
          {body.currentRevision !== undefined && (
            <>
              <dt className="text-fg-muted">Current revision</dt>
              <dd className="font-mono">r{body.currentRevision}</dd>
            </>
          )}
          {body.changedRefs && body.changedRefs.length > 0 && (
            <>
              <dt className="text-fg-muted">Changed</dt>
              <dd>
                <ul className="flex flex-wrap gap-1">
                  {body.changedRefs.map((ref) => (
                    <li key={ref}>
                      <RefChip id={ref} name={resolveName?.(ref)} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      )}
      {issues.length > 0 && (
        <IssueList
          issues={issues}
          className="mt-2 pl-6"
          resolveName={resolveName}
          onSelect={onSelect}
        />
      )}
    </div>
  )
}

const RECORD_ID = /^(obj|rel|evd)_[0-9a-f]{32}$/

export function IssueList({
  issues,
  className,
  resolveName,
  onSelect,
}: {
  issues: ApiErrorBody['issues']
  className?: string
  resolveName?: ((id: string) => string | undefined) | undefined
  onSelect?: ((id: string) => void) | undefined
}) {
  return (
    <ul className={cn('space-y-1 text-xs', className)}>
      {issues.map((issue, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: issues are an immutable, ordered list without ids
        <li key={i} className="flex items-start gap-1.5">
          <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tone-fg" />
          <span className="min-w-0">
            <code className="font-mono text-fg">{issue.code}</code>
            {issue.op !== undefined && <span className="text-fg-muted"> · op #{issue.op + 1}</span>}
            {issue.path && issue.path.length > 0 && (
              <span className="font-mono text-fg-muted"> · {issue.path.join('.')}</span>
            )}
            {RECORD_ID.test(issue.message) ? (
              <span className="mt-0.5 block">
                <RefChip
                  id={issue.message}
                  name={resolveName?.(issue.message)}
                  onSelect={onSelect}
                />
              </span>
            ) : (
              <span className="block break-words text-fg-muted">{issue.message}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A reference to a record: its name when known, a button that selects it when possible. */
export function RefChip({
  id,
  name,
  onSelect,
}: {
  id: string
  name?: string | undefined
  onSelect?: ((id: string) => void) | undefined
}) {
  const content = (
    <>
      <span className="truncate">{name ?? shortId(id)}</span>
      {name && <span className="font-mono text-2xs text-fg-subtle">{shortId(id)}</span>}
    </>
  )
  const canSelect = onSelect && (id.startsWith('obj_') || id.startsWith('rel_'))
  const cls =
    'inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-0.5 text-xs'
  if (!canSelect) return <span className={cls}>{content}</span>
  return (
    <button
      type="button"
      className={cn(cls, 'hover:border-border-strong hover:bg-surface-2')}
      onClick={() => onSelect(id)}
    >
      {content}
    </button>
  )
}

/** A link-styled button that selects a record into the Inspector. */
export function RecordLink({ id, children }: { id: string; children?: ReactNode }) {
  const wb = useWorkbench()
  const name = wb.model?.nameOf(id)
  return (
    <button
      type="button"
      onClick={() => wb.select(id)}
      className="max-w-full truncate rounded-sm text-left text-accent underline-offset-2 hover:underline"
      title={id}
    >
      {children ?? name ?? shortId(id)}
    </button>
  )
}

/**
 * A link to a place in the workbench. It has a real href, so it can be copied or opened elsewhere;
 * a plain click navigates in place without reloading.
 */
export function AppLink({
  to,
  className,
  children,
  ...rest
}: {
  to: Partial<AppLocation>
  className?: string
  children: ReactNode
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'className'>) {
  const [loc, navigate] = useAppLocation()
  const href = formatLocation({ ...loc, ...to }) || '?'
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(to)
      }}
      className={cn('rounded-sm text-accent underline-offset-2 hover:underline', className)}
      {...rest}
    >
      {children}
    </a>
  )
}

export function ViewHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-semibold text-[17px] text-fg tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-fg-muted text-sm">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}
