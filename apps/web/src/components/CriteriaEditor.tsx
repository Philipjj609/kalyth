import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { type Dispatch, useId, useState } from 'react'
import { type CriterionAction, MAX_CRITERIA, MAX_CRITERION } from '../model/criteria.ts'
import { Button } from './ui.tsx'

/**
 * Edits acceptance criteria: change, reorder, remove and add, by keyboard alone. Used by the
 * Handoff draft and the task form; each passes its own reducer's dispatch.
 */
export function CriteriaEditor({
  criteria,
  dispatch,
  disabled,
  placeholder = 'For example: every query filters by tenant',
}: {
  criteria: readonly string[]
  dispatch: Dispatch<CriterionAction>
  disabled?: boolean
  placeholder?: string
}) {
  const [next, setNext] = useState('')
  const newId = useId()
  const full = criteria.length >= MAX_CRITERIA
  const add = () => {
    if (!next.trim() || full) return
    dispatch({ type: 'addCriterion', text: next })
    setNext('')
  }
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="font-medium text-xs">
        Acceptance criteria{' '}
        <span className="font-normal text-fg-muted">
          (optional, {criteria.length} of {MAX_CRITERIA})
        </span>
      </legend>
      {criteria.length > 0 && (
        <ol className="space-y-1.5">
          {criteria.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: criteria are edited in place; the position is their identity
            <li key={i} className="flex items-center gap-1">
              <span className="w-5 shrink-0 text-right font-mono text-2xs text-fg-subtle">
                {i + 1}.
              </span>
              <input
                aria-label={`Acceptance criterion ${i + 1}`}
                value={c}
                maxLength={MAX_CRITERION}
                onChange={(e) =>
                  dispatch({ type: 'editCriterion', index: i, text: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault()
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 text-sm"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Move criterion ${i + 1} up`}
                disabled={i === 0}
                onClick={() => dispatch({ type: 'moveCriterion', index: i, by: -1 })}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Move criterion ${i + 1} down`}
                disabled={i === criteria.length - 1}
                onClick={() => dispatch({ type: 'moveCriterion', index: i, by: 1 })}
              >
                <ArrowDown aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove criterion ${i + 1}`}
                onClick={() => dispatch({ type: 'removeCriterion', index: i })}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-1.5">
        <label htmlFor={newId} className="sr-only">
          New acceptance criterion
        </label>
        <input
          id={newId}
          value={next}
          maxLength={MAX_CRITERION}
          disabled={full}
          placeholder={full ? `At most ${MAX_CRITERIA} criteria` : placeholder}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the criterion; it never submits the form by accident.
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 text-sm placeholder:text-fg-subtle disabled:bg-surface-2"
        />
        <Button size="sm" onClick={add} disabled={!next.trim() || full}>
          <Plus aria-hidden />
          Add
        </Button>
      </div>
    </fieldset>
  )
}
