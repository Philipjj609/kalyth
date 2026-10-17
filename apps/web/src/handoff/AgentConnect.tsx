import type { AgentTokenSummary, IssuedAgentToken } from '@kalyth/contracts'
import { Ban, KeyRound, Plug, ShieldAlert } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useAgentTokens, useRevokeAgentToken } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { StatusBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, CopyButton, EmptyState, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, relativeTime } from '../model/format.ts'
import {
  CODEX_TOKEN_ENV,
  claudeCodeCommand,
  codexConfig,
  codexEnvCommands,
  mcpUrl,
  TOKEN_DAYS,
  TOKEN_LABEL_MAX,
  TOKEN_STATE_META,
  tokenState,
} from '../model/handoff.ts'
import { ErrorNotice } from '../views/shared.tsx'
import { useAgentTokenIssuer } from './issue-token.ts'

// ---------- presentational ----------

/**
 * A labelled, copyable block of text. Commands wrap (breaking a long token only where it must);
 * configuration keeps its lines intact and scrolls sideways instead.
 */
export function Snippet({
  title,
  text,
  copyLabel,
  wrap = true,
  children,
}: {
  title: string
  text: string
  copyLabel: string
  wrap?: boolean
  children?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="font-medium text-xs">{title}</h4>
        <span className="ml-auto">
          <CopyButton text={text} label={copyLabel} />
        </span>
      </div>
      {children}
      <pre
        className={cn(
          'overflow-x-auto rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-fg leading-relaxed scrollbar-thin',
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre',
        )}
      >
        {text}
      </pre>
    </div>
  )
}

/**
 * Setup for Claude Code and Codex. With a token, the commands carry it; without one they show a
 * placeholder to replace.
 */
export function SetupSnippets({ origin, token }: { origin: string; token: string | null }) {
  const env = codexEnvCommands(token)
  return (
    <div className="space-y-3">
      <Snippet
        title="Claude Code"
        text={claudeCodeCommand(origin, token)}
        copyLabel="Copy the Claude Code command"
      >
        <p className="mb-1 text-fg-muted text-xs">Run once in a terminal:</p>
      </Snippet>
      <Snippet
        title="Codex, in ~/.codex/config.toml"
        text={codexConfig(origin)}
        copyLabel="Copy the Codex configuration"
        wrap={false}
      >
        <p className="mb-1 text-fg-muted text-xs">
          Add this to the configuration, then set{' '}
          <code className="font-mono">{CODEX_TOKEN_ENV}</code> to the token in the shell that runs
          Codex:
        </p>
      </Snippet>
      <Snippet
        title={`${CODEX_TOKEN_ENV} in bash or zsh`}
        text={env.posix}
        copyLabel={`Copy the command that sets ${CODEX_TOKEN_ENV} in bash or zsh`}
      />
      <Snippet
        title={`${CODEX_TOKEN_ENV} in PowerShell`}
        text={env.powershell}
        copyLabel={`Copy the command that sets ${CODEX_TOKEN_ENV} in PowerShell`}
      />
    </div>
  )
}

/** The token right after it was issued: shown once, with copy buttons and the setup. */
export function IssuedTokenView({
  issued,
  origin,
  onDone,
}: {
  issued: IssuedAgentToken
  origin: string
  onDone?: () => void
}) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="tone-warning space-y-3 rounded-lg border border-tone-bd bg-tone-bg p-3"
    >
      <div className="flex items-start gap-2 text-tone-fg">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-semibold text-sm">
            Token for “{issued.summary.label}”: shown once
          </h3>
          <p className="mt-0.5 text-fg text-xs">
            Copy it now. Kalyth stores only its hash and cannot show it again, and this page forgets
            it when you leave this panel. It expires{' '}
            <time
              dateTime={issued.summary.expiresAt}
              title={absoluteTime(issued.summary.expiresAt)}
            >
              {relativeTime(issued.summary.expiresAt)}
            </time>
            . Anyone with it can read this project and propose changes.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 rounded-md border border-tone-bd bg-surface px-2.5 py-1.5">
        <span className="sr-only">Agent token: </span>
        <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
          {issued.token}
        </code>
        <CopyButton text={issued.token} label="Copy the agent token" />
      </div>
      <div className="rounded-md border border-border bg-surface p-3">
        <SetupSnippets origin={origin} token={issued.token} />
      </div>
      {onDone && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={onDone}>
            I have copied it
          </Button>
        </div>
      )}
    </section>
  )
}

/**
 * Agent tokens, newest first: label and status, when each was created and expires or was revoked.
 * Only summaries; secrets are never listed. A list rather than a table, so it reads in a narrow
 * column.
 */
export function TokenList({
  tokens,
  now,
  renderAction,
}: {
  tokens: readonly AgentTokenSummary[]
  now?: number
  renderAction?: (token: AgentTokenSummary) => ReactNode
}) {
  const sorted = [...tokens].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )
  const when = (iso: string) => (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  )
  return (
    <ul aria-label="Agent tokens, newest first" className="divide-y divide-border">
      {sorted.map((t) => {
        const state = tokenState(t, now)
        const meta = TOKEN_STATE_META[state]
        return (
          <li key={t.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'break-words font-medium text-sm',
                    state !== 'active' && 'text-fg-muted',
                  )}
                >
                  {t.label}
                </span>
                <StatusBadge
                  size="sm"
                  tone={meta.tone}
                  label={meta.label}
                  description={meta.description}
                  prefix="Token status:"
                />
              </p>
              <p className="mt-0.5 text-fg-muted text-xs">
                Created {when(t.createdAt)} ·{' '}
                {t.revokedAt ? (
                  <>Revoked {when(t.revokedAt)}</>
                ) : (
                  <>
                    {state === 'expired' ? 'Expired' : 'Expires'} {when(t.expiresAt)}
                  </>
                )}
              </p>
            </div>
            {renderAction && state === 'active' && (
              <div className="ml-auto shrink-0">{renderAction(t)}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------- containers ----------

/** Revoke with an inline confirmation; revoking cannot be undone. */
function RevokeAction({
  token,
  onRevoked,
}: {
  token: AgentTokenSummary
  onRevoked: (id: string) => void
}) {
  const wb = useWorkbench()
  const revoke = useRevokeAgentToken(wb.projectId)
  const notify = useToast()
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Revoke ${token.label}`}
        onClick={() => setConfirming(true)}
      >
        <Ban aria-hidden />
        Revoke…
      </Button>
    )
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
        <span className="text-fg-muted text-xs">Agents using it stop at once.</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={revoke.isPending}
          aria-label={`Confirm revoking ${token.label}`}
          onClick={() =>
            revoke.mutate(token.id, {
              onSuccess: (summary) => {
                onRevoked(summary.id)
                notify({ tone: 'neutral', title: 'Agent token revoked', body: summary.label })
              },
            })
          }
        >
          {revoke.isPending ? <Spinner label="Revoking" /> : <Ban aria-hidden />}
          Revoke
        </Button>
      </span>
      {revoke.isError && <ErrorNotice error={revoke.error} className="text-left" />}
    </span>
  )
}

function IssueForm({
  pending,
  error,
  onIssue,
}: {
  pending: boolean
  error: unknown
  onIssue: (input: { label: string; expiresInDays: number }) => void
}) {
  const [label, setLabel] = useState('')
  const [days, setDays] = useState<number>(TOKEN_DAYS.default)
  const labelId = useId()
  const daysId = useId()
  const hintId = useId()
  const trimmed = label.trim()
  const daysValid = Number.isInteger(days) && days >= TOKEN_DAYS.min && days <= TOKEN_DAYS.max
  const valid = trimmed.length > 0 && trimmed.length <= TOKEN_LABEL_MAX && daysValid
  return (
    <form
      className="space-y-2"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid || pending) return
        onIssue({ label: trimmed, expiresInDays: days })
        setLabel('')
      }}
    >
      <h3 className="font-medium text-xs">New agent token</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1 space-y-1">
          <label htmlFor={labelId} className="block text-fg-muted text-xs">
            Label
          </label>
          <input
            id={labelId}
            value={label}
            maxLength={TOKEN_LABEL_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="For example: Claude Code on my laptop"
            className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-sm placeholder:text-fg-subtle disabled:bg-surface-2"
          />
        </div>
        <div className="w-28 space-y-1">
          <label htmlFor={daysId} className="block text-fg-muted text-xs">
            Expires in days
          </label>
          <input
            id={daysId}
            type="number"
            inputMode="numeric"
            min={TOKEN_DAYS.min}
            max={TOKEN_DAYS.max}
            step={1}
            aria-describedby={hintId}
            value={Number.isNaN(days) ? '' : days}
            disabled={pending}
            onChange={(e) => setDays(e.target.value === '' ? Number.NaN : Number(e.target.value))}
            className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-sm tabular-nums disabled:bg-surface-2"
          />
        </div>
        <Button type="submit" variant="primary" disabled={!valid || pending}>
          {pending ? (
            <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Issuing" />
          ) : (
            <KeyRound aria-hidden />
          )}
          Issue token
        </Button>
      </div>
      <p
        id={hintId}
        className={cn('text-xs', daysValid ? 'text-fg-subtle' : 'text-tone-fg tone-danger')}
      >
        From {TOKEN_DAYS.min} to {TOKEN_DAYS.max} days. The token can read this project and propose
        changes; it cannot commit or decide.
      </p>
      {error ? <ErrorNotice error={error} title="The token was not issued" /> : null}
    </form>
  )
}

/**
 * Connect an agent: the MCP endpoint, the project's agent tokens, issuing a new one and the setup
 * for Claude Code and Codex. The issued secret lives only in this component's state.
 */
export function AgentConnect() {
  const wb = useWorkbench()
  const tokens = useAgentTokens(wb.projectId)
  const issuer = useAgentTokenIssuer(wb.projectId)
  const origin = window.location.origin
  const list = tokens.data?.tokens
  return (
    <Panel
      title="Connect an agent"
      aside={<span className="text-fg-subtle text-xs">MCP over Streamable HTTP</span>}
    >
      <div className="space-y-4 p-4">
        <div className="space-y-1">
          <p className="text-fg-muted text-xs">
            Agents connect to this endpoint with an agent token in an{' '}
            <code className="font-mono">Authorization: Bearer</code> header. Your session token is
            not accepted there.
          </p>
          <p className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2.5 py-1">
            <Plug aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{mcpUrl(origin)}</code>
            <CopyButton text={mcpUrl(origin)} label="Copy the MCP endpoint" />
          </p>
        </div>

        {tokens.data === null ? (
          <p className="rounded-md border border-border border-dashed px-3 py-2 text-fg-muted text-xs">
            This server has no agent token routes. Update and restart the Kalyth server to connect
            agents.
          </p>
        ) : (
          <>
            {issuer.issued ? (
              <IssuedTokenView issued={issuer.issued} origin={origin} onDone={issuer.clear} />
            ) : (
              <IssueForm
                pending={issuer.pending}
                error={issuer.error}
                onIssue={(input) => void issuer.issue(input)}
              />
            )}
            <div>
              <h3 className="mb-1.5 font-medium text-xs">Agent tokens</h3>
              {tokens.error ? (
                <ErrorNotice error={tokens.error} title="Agent tokens could not be loaded" />
              ) : tokens.isLoading || !list ? (
                <Skeleton className="h-16" />
              ) : list.length === 0 ? (
                <div className="rounded-md border border-border border-dashed">
                  <EmptyState icon={<KeyRound />} title="No agent tokens yet" className="py-6">
                    Issue one above for each agent you connect.
                  </EmptyState>
                </div>
              ) : (
                <div className="max-h-[260px] overflow-auto rounded-md border border-border scrollbar-thin">
                  <TokenList
                    tokens={list}
                    renderAction={(t) => (
                      <RevokeAction
                        token={t}
                        onRevoked={(id) => {
                          if (issuer.issued?.summary.id === id) issuer.clear()
                        }}
                      />
                    )}
                  />
                </div>
              )}
            </div>
            {!issuer.issued && (
              <details className="group rounded-md border border-border">
                <summary className="cursor-pointer select-none rounded-md px-3 py-2 font-medium text-xs hover:bg-surface-2">
                  Setup for Claude Code and Codex
                </summary>
                <div className="border-border border-t p-3">
                  <p className="mb-3 text-fg-muted text-xs">
                    Replace <code className="font-mono">&lt;agent token&gt;</code> with a token. A
                    new token comes with these filled in.
                  </p>
                  <SetupSnippets origin={origin} token={null} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}
