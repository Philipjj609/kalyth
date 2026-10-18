import type {
  DecisionSummary,
  ImpactResult,
  ObjectVersion,
  RelationVersion,
} from '@kalyth/contracts'

/**
 * Comparing a decision's alternatives (Tier B): each alternative's own text and claim, a matrix of
 * the elements they change (which change is shared, which is unique), the questions about each,
 * and what each reaches through impact that the others do not.
 */

export interface ComparedQuestion {
  id: string
  text: string
  inquiryRole: string
  status: string
}

export interface ComparedAlternative {
  id: string
  title: string
  summary: string
  status: string
  tradeoffs: string | null
  basis: string | null
  confidence: { level: 'low' | 'medium' | 'high'; rationale: string } | null
  /** Ids of the elements it changes directly; the seeds of its impact. */
  targets: string[]
  questions: ComparedQuestion[]
}

export interface ChangeRow {
  target: string
  label: string
  /** The change each alternative makes to the element, in alternative order; null for none. */
  cells: (string | null)[]
  /** Every alternative changes it. */
  shared: boolean
}

export interface Comparison {
  alternatives: ComparedAlternative[]
  changes: ChangeRow[]
  /** Questions about the decision itself. */
  questions: ComparedQuestion[]
}

export interface ModelLookup {
  objectById: ReadonlyMap<string, ObjectVersion>
  relations: readonly RelationVersion[]
}

export function compareAlternatives(decision: DecisionSummary, model: ModelLookup): Comparison {
  const questionsAbout = (id: string): ComparedQuestion[] =>
    model.relations
      .filter((r) => r.type === 'concerns' && r.to === id && r.lifecycle === 'active')
      .flatMap((r) => {
        const q = model.objectById.get(r.from)
        if (q?.type !== 'core.Question' || q.lifecycle !== 'active') return []
        const a = q.attributes as Record<string, unknown>
        return [
          {
            id: q.id,
            text: String(a.text ?? ''),
            inquiryRole: String(a.inquiryRole ?? 'exploratory'),
            status: String(a.status ?? 'open'),
          },
        ]
      })
      .sort((x, y) => (x.id < y.id ? -1 : 1))

  const alternatives = decision.alternatives.map((alt): ComparedAlternative => {
    const object = model.objectById.get(alt.id)
    const a = (object?.attributes ?? {}) as Record<string, unknown>
    const confidence = object?.claim.confidence
    return {
      id: alt.id,
      title: alt.title,
      summary: alt.summary,
      status: alt.status,
      tradeoffs: typeof a.tradeoffs === 'string' && a.tradeoffs ? a.tradeoffs : null,
      basis: object?.claim.basis ?? null,
      confidence: confidence ? { level: confidence.level, rationale: confidence.rationale } : null,
      targets: [...new Set(alt.directChanges.map((c) => c.target))],
      questions: questionsAbout(alt.id),
    }
  })

  const rows = new Map<string, ChangeRow>()
  decision.alternatives.forEach((alt, i) => {
    for (const c of alt.directChanges) {
      const row = rows.get(c.target) ?? {
        target: c.target,
        label: c.label,
        cells: decision.alternatives.map(() => null),
        shared: false,
      }
      const before = row.cells[i]
      row.cells[i] = before ? `${before}\n${c.change}` : c.change
      rows.set(c.target, row)
    }
  })
  const changes = [...rows.values()]
    .map((row) => ({ ...row, shared: row.cells.every((c) => c !== null) }))
    .sort(
      (x, y) =>
        touched(y) - touched(x) || x.label.localeCompare(y.label) || (x.target < y.target ? -1 : 1),
    )

  return { alternatives, changes, questions: questionsAbout(decision.id) }
}

const touched = (row: ChangeRow) => row.cells.filter((c) => c !== null).length

export interface Reach {
  /** Elements reached, the alternative's own direct changes included. */
  total: number
  /** Elements only this alternative reaches. */
  only: { id: string; label: string; type: string }[]
  truncated: boolean
}

/**
 * What each alternative reaches through impact. `results` are in alternative order; an entry is
 * undefined while its traversal loads, and so is the alternative's reach.
 */
export function compareReach(
  results: readonly (ImpactResult | undefined)[],
): (Reach | undefined)[] {
  const reached = results.map((r) => (r ? new Map(r.elements.map((e) => [e.id, e])) : undefined))
  return reached.map((mine, i) => {
    if (!mine) return undefined
    const others = reached.filter((_, j) => j !== i)
    const only = [...mine.values()]
      .filter((e) => others.every((o) => o !== undefined && !o.has(e.id)))
      .map((e) => ({ id: e.id, label: e.label, type: e.type }))
      .sort((x, y) => x.label.localeCompare(y.label) || (x.id < y.id ? -1 : 1))
    return {
      total: mine.size,
      // Until every other traversal has loaded, nothing can be called unique.
      only: others.every((o) => o !== undefined) ? only : [],
      truncated: results[i]?.truncated ?? false,
    }
  })
}
