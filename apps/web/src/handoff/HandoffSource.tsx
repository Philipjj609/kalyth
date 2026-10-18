import type { ContextPackageResult, DecisionSummary } from '@kalyth/contracts'
import { Gavel, PackageOpen } from 'lucide-react'
import { useId, useReducer } from 'react'
import { useAcceptedDecisions, useCompileContext } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { BasisBadge } from '../components/badges.tsx'
import { CriteriaEditor } from '../components/CriteriaEditor.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, EmptyState, Panel, Segmented, Skeleton, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural } from '../model/format.ts'
import {
  acceptedAlternatives,
  approxTokens,
  compileBody,
  draftProblems,
  draftReducer,
  EMPTY_DRAFT,
  type FocusMode,
  MAX_CHARS,
  MAX_FOCUS,
  MAX_TITLE,
} from '../model/handoff.ts'
import { ElementPicker } from '../navigator/ElementPicker.tsx'
import { ErrorNotice } from '../views/shared.tsx'

// ---------- presentational ----------

/**
 * Accepted decisions as a radio group: each with its accepted alternative and that alternative's
 * direct changes. Native radios give arrow-key selection.
 */
export function DecisionChoiceList({
  decisions,
  value,
  onChoose,
  disabled,
}: {
  decisions: readonly DecisionSummary[]
  value: string | null
  onChoose: (decision: DecisionSummary) => void
  disabled?: boolean
}) {
  const name = useId()
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">Accepted decisions</legend>
      <ul className="max-h-[360px] space-y-2 overflow-auto pr-1 scrollbar-thin">
        {decisions.map((d) => {
          const accepted = acceptedAlternatives(d)
          const checked = d.id === value
          return (
            <li key={d.id}>
              <label
                className={cn(
                  'flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                  checked ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={d.id}
                  checked={checked}
                  onChange={() => onChoose(d)}
                  className="mt-1 shrink-0 self-start accent-accent"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="break-words font-medium text-sm">{d.title}</span>
                    <BasisBadge basis={d.basis} size="sm" />
                  </span>
                  {d.question && (
                    <span className="block break-words text-fg-muted text-xs">{d.question}</span>
                  )}
                  {accepted.length === 0 ? (
                    <span className="block text-fg-subtle text-xs">
                      No accepted alternative recorded.
                    </span>
                  ) : (
                    accepted.map((a) => (
                      <span key={a.id} className="block space-y-0.5 border-border border-l pl-2.5">
                        <span className="block text-xs">
                          <span className="text-fg-muted">Accepted: </span>
                          <span className="font-medium">{a.title}</span>
                        </span>
                        {a.summary && (
                          <span className="line-clamp-2 block break-words text-fg-muted text-xs">
                            {a.summary}
                          </span>
                        )}
                        <span className="block text-fg-muted text-xs">
                          {plural(a.directChanges.length, 'direct change')}
                          {a.directChanges.length > 0 && ':'}
                        </span>
                        {a.directChanges.length > 0 && (
                          <span className="block space-y-0.5">
                            {a.directChanges.map((c) => (
                              <span key={c.relationId} className="block break-words text-xs">
                                <span className="font-medium">{c.label}</span>
                                {c.change && <span className="text-fg-muted">: {c.change}</span>}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    ))
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

// ---------- container ----------

const MODES: readonly { value: FocusMode; label: string }[] = [
  { value: 'decision', label: 'Accepted decision' },
  { value: 'elements', label: 'Elements' },
]

/**
 * Chooses what to hand off: an accepted decision or elements, a task with acceptance criteria and
 * a size limit. Compiles at the head and reports the new package.
 */
export function HandoffSource({
  onCompiled,
}: {
  onCompiled: (result: ContextPackageResult) => void
}) {
  const wb = useWorkbench()
  const decisions = useAcceptedDecisions(wb.projectId)
  const compile = useCompileContext(wb.projectId)
  const notify = useToast()
  const [draft, dispatch] = useReducer(draftReducer, EMPTY_DRAFT)
  const titleId = useId()
  const sizeId = useId()
  const sizeHintId = useId()
  const pickerHintId = useId()
  const problemsId = useId()
  const problems = draftProblems(draft)
  const busy = compile.isPending

  return (
    <Panel
      title="Choose what to hand off"
      aside={
        <span className="text-fg-subtle text-xs">
          compiled at the head, <span className="font-mono">r{wb.headRevision}</span>
        </span>
      }
    >
      <form
        className="space-y-4 p-4"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault()
          if (problems.length > 0 || busy) return
          compile.mutate(compileBody(draft), {
            onSuccess: (result) => {
              onCompiled(result)
              notify({
                tone: result.package.status === 'blocked' ? 'danger' : 'success',
                title:
                  result.package.status === 'blocked'
                    ? 'Package blocked: the mandatory part exceeds the limit'
                    : 'Context package compiled',
                body: result.package.task?.title ?? result.package.id,
              })
            },
          })
        }}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-xs">Focus</span>
            <Segmented
              label="Focus on"
              value={draft.mode}
              options={MODES}
              onChange={(mode) => dispatch({ type: 'mode', mode })}
            />
          </div>
          {draft.mode === 'decision' ? (
            decisions.error ? (
              <ErrorNotice error={decisions.error} title="Decisions could not be loaded" />
            ) : decisions.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : decisions.data === null ? (
              <p className="rounded-md border border-border border-dashed px-3 py-2 text-fg-muted text-xs">
                This server has no decisions route. Pick elements instead, or update and restart the
                Kalyth server.
              </p>
            ) : (decisions.data?.decisions.length ?? 0) === 0 ? (
              <div className="rounded-md border border-border border-dashed">
                <EmptyState icon={<Gavel />} title="No accepted decisions yet" className="py-6">
                  Accept an alternative in the Navigator, or pick elements instead.
                </EmptyState>
              </div>
            ) : (
              <DecisionChoiceList
                decisions={decisions.data?.decisions ?? []}
                value={draft.decisionId}
                disabled={busy}
                onChoose={(decision) => dispatch({ type: 'chooseDecision', decision })}
              />
            )
          ) : (
            <div className="space-y-1">
              <p id={pickerHintId} className="text-fg-muted text-xs">
                Elements the task is about, up to {MAX_FOCUS}. Their constraints, accepted
                decisions, impact and dependencies come with them.
              </p>
              <ElementPicker
                value={draft.elements}
                onChange={(elements) => dispatch({ type: 'elements', elements })}
                max={MAX_FOCUS}
                disabled={busy}
                describedBy={pickerHintId}
              />
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor={titleId} className="block font-medium text-xs">
            Task title{' '}
            <span className="font-normal text-fg-muted">
              {draft.mode === 'decision' ? '(from the decision; edit freely)' : '(optional)'}
            </span>
          </label>
          <input
            id={titleId}
            value={draft.title}
            maxLength={MAX_TITLE}
            disabled={busy}
            onChange={(e) => dispatch({ type: 'title', title: e.target.value })}
            placeholder="What the agent should do"
            className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-sm placeholder:text-fg-subtle disabled:bg-surface-2"
          />
        </div>

        <CriteriaEditor criteria={draft.criteria} dispatch={dispatch} disabled={busy} />

        <div className="space-y-1">
          <label htmlFor={sizeId} className="block font-medium text-xs">
            Size limit
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={sizeId}
              type="number"
              inputMode="numeric"
              min={MAX_CHARS.min}
              max={MAX_CHARS.max}
              step={MAX_CHARS.step}
              aria-describedby={sizeHintId}
              value={Number.isNaN(draft.maxChars) ? '' : draft.maxChars}
              disabled={busy}
              onChange={(e) =>
                dispatch({
                  type: 'maxChars',
                  value: e.target.value === '' ? Number.NaN : Number(e.target.value),
                })
              }
              className="h-8 w-32 rounded-md border border-border-strong bg-surface px-2 text-sm tabular-nums disabled:bg-surface-2"
            />
            <span className="text-fg-muted text-sm">characters</span>
            <span className="text-fg-muted text-sm tabular-nums">
              ≈{' '}
              {Number.isFinite(draft.maxChars)
                ? approxTokens(draft.maxChars).toLocaleString('en')
                : '—'}{' '}
              tokens
            </span>
          </div>
          <p id={sizeHintId} className="text-fg-subtle text-xs">
            Of the whole package as JSON, about four characters per token. Mandatory content is
            never cut; optional items are cut nearest-last, and the package lists what was left out.
          </p>
        </div>

        {wb.isHistorical && (
          <p className="tone-warning rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs">
            You are viewing r{wb.revision}. Packages are always compiled at the head, r
            {wb.headRevision}, so agents propose against the current model.
          </p>
        )}
        {compile.isError && (
          <ErrorNotice
            error={compile.error}
            title="The package was not compiled"
            resolveName={(id) => wb.model?.nameOf(id)}
            onSelect={wb.select}
          />
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {problems.length > 0 && (
            <p id={problemsId} className="mr-auto text-fg-muted text-xs">
              {problems.join(' ')}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={problems.length > 0 || busy}
            aria-describedby={problems.length > 0 ? problemsId : undefined}
          >
            {busy ? (
              <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Compiling" />
            ) : (
              <PackageOpen aria-hidden />
            )}
            Compile context package
          </Button>
        </div>
      </form>
    </Panel>
  )
}
