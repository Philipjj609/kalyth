/**
 * Acceptance criteria as a person edits them: a short ordered list of sentences. Shared by the
 * Handoff draft (a context package's task) and the task form (core.Task), which have the same
 * limits in the contracts: at most 20 criteria of at most 1,000 characters each.
 */

export const MAX_CRITERIA = 20
export const MAX_CRITERION = 1_000

export type CriterionAction =
  | { type: 'addCriterion'; text: string }
  | { type: 'editCriterion'; index: number; text: string }
  | { type: 'removeCriterion'; index: number }
  | { type: 'moveCriterion'; index: number; by: -1 | 1 }

/** Applies one edit. Added criteria are trimmed; empty ones and any past the limit are ignored. */
export function criteriaReducer(criteria: readonly string[], action: CriterionAction): string[] {
  switch (action.type) {
    case 'addCriterion': {
      const text = action.text.trim()
      if (!text || criteria.length >= MAX_CRITERIA) return [...criteria]
      return [...criteria, text.slice(0, MAX_CRITERION)]
    }
    case 'editCriterion':
      return criteria.map((c, i) => (i === action.index ? action.text : c))
    case 'removeCriterion':
      return criteria.filter((_, i) => i !== action.index)
    case 'moveCriterion': {
      const to = action.index + action.by
      if (to < 0 || to >= criteria.length) return [...criteria]
      const next = [...criteria]
      const [moved] = next.splice(action.index, 1)
      next.splice(to, 0, moved as string)
      return next
    }
  }
}

export const isCriterionAction = (action: { type: string }): action is CriterionAction =>
  action.type === 'addCriterion' ||
  action.type === 'editCriterion' ||
  action.type === 'removeCriterion' ||
  action.type === 'moveCriterion'

/** The criteria to send: trimmed, without blank ones. */
export const filledCriteria = (criteria: readonly string[]): string[] =>
  criteria.map((c) => c.trim()).filter((c) => c !== '')
