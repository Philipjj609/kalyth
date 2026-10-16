import type { ObjectVersion, RelationVersion } from '@kalyth/contracts'
import { shortId } from './format.ts'

type Attributes = Record<string, unknown>

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

/**
 * The human label of an object, from its attributes. Works for unknown types by trying the common
 * naming attributes in order and falling back to the short id.
 */
export function objectLabel(object: Pick<ObjectVersion, 'id' | 'type' | 'attributes'>): string {
  const a = object.attributes as Attributes
  if (object.type === 'software.Endpoint') {
    const method = str(a.method)
    const path = str(a.path)
    if (path) return method ? `${method} ${path}` : path
  }
  const text =
    str(a.name) ??
    str(a.title) ??
    str(a.path) ??
    str(a.text) ??
    str(a.statement) ??
    str(a.summary) ??
    str(a.label)
  return text ? truncate(text, 120) : shortId(object.id)
}

/**
 * A compact label for graph nodes: the file name for paths, otherwise the full label.
 * Returns the directory separately so it can be shown muted.
 */
export function objectShortLabel(object: Pick<ObjectVersion, 'id' | 'type' | 'attributes'>): {
  label: string
  context?: string
} {
  const a = object.attributes as Attributes
  const path = object.type === 'software.Endpoint' ? undefined : str(a.path)
  if (path && str(a.name) === undefined && str(a.title) === undefined) {
    const slash = path.lastIndexOf('/')
    if (slash > 0) return { label: path.slice(slash + 1), context: path.slice(0, slash) }
  }
  return { label: objectLabel(object) }
}

/** One secondary line for an object: technology, language, storage, version or ecosystem. */
export function objectDetail(
  object: Pick<ObjectVersion, 'type' | 'attributes'>,
): string | undefined {
  const a = object.attributes as Attributes
  return (
    str(a.technology) ??
    str(a.language) ??
    str(a.storage) ??
    (str(a.version) ? `${str(a.ecosystem) ?? 'v'} ${str(a.version)}`.trim() : undefined) ??
    str(a.handler) ??
    str(a.status)
  )
}

export function relationLabel(
  relation: Pick<RelationVersion, 'from' | 'to' | 'type'>,
  nameOf: (id: string) => string,
): string {
  return `${nameOf(relation.from)} → ${nameOf(relation.to)}`
}
