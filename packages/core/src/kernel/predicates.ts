import type { PredicateQuery } from '@kalyth/contracts'
import { hashCanonical } from '../util.ts'
import type { StateView } from './state.ts'

/**
 * Fingerprint of a predicate query's result: the matching ids and the revision of each match.
 * Taken at the base revision and re-taken at head when the head moved (R1).
 */
export function predicateFingerprint(state: StateView, query: PredicateQuery): string {
  const rows =
    query.kind === 'objects'
      ? state.listObjects({ types: query.types, attributeEquals: query.attributeEquals })
      : state.listRelations({ types: query.types, from: query.from, to: query.to })
  return hashCanonical(rows.map((r) => [r.id, r.revision]).sort())
}
