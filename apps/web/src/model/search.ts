import type { ObjectVersion } from '@kalyth/contracts'
import { objectLabel } from './labels.ts'
import { compareTypes } from './semantics.ts'

/** The last path segment without its extension: `backend/app/models.py` reads as `models`. */
const stem = (label: string) => (label.split('/').at(-1) ?? label).replace(/\.[^.]+$/, '')

/**
 * How closely a label answers a query, lower first: the whole name, then the file name, then
 * a prefix of either, then anywhere in the label. A data entity called `User` therefore comes
 * before `backend/app/api/routes/users.py`, however many modules mention the word.
 */
function closeness(label: string, q: string): number {
  const l = label.toLowerCase()
  const s = stem(l)
  if (l === q) return 0
  if (s === q) return 1
  if (l.startsWith(q) || s.startsWith(q)) return 2
  if (l.includes(q)) return 3
  return 4
}

/**
 * Elements matching a search, best first, at most `limit`. Matches by label, or by id for a
 * pasted id; ties go to the more important type, then the shorter label.
 */
export function searchObjects(
  objects: readonly ObjectVersion[],
  query: string,
  limit: number,
  exclude?: ReadonlySet<string>,
): ObjectVersion[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return objects
    .filter((o) => !exclude?.has(o.id))
    .map((o) => {
      const label = objectLabel(o)
      return { o, label, score: o.id.includes(q) ? 0 : closeness(label, q) }
    })
    .filter((m) => m.score < 4)
    .sort(
      (a, b) =>
        a.score - b.score ||
        compareTypes(a.o.type, b.o.type) ||
        a.label.length - b.label.length ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit)
    .map((m) => m.o)
}
