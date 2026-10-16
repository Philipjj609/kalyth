import { createHash } from 'node:crypto'
import type { JsonValue } from '@kalyth/contracts'

export const ANALYZER = { tool: 'kalyth-analyzer', toolVersion: '0.1.0' } as const

/** One piece of source evidence: a line span of one file at one blob. */
export interface EvidenceSpan {
  /** Stable identity of the span: path, lines and blob. */
  key: string
  path: string
  blobSha: string
  startLine: number
  endLine: number
  spanSha256: string
  symbol?: string
  excerpt?: string
}

/** An observed fact. Each support group is jointly required; groups are alternatives (R2). */
export interface ObjectFact {
  key: string
  type: string
  attributes: Record<string, JsonValue>
  supports: EvidenceSpan[][]
}

export interface RelationFact {
  key: string
  type: string
  from: string
  to: string
  supports: EvidenceSpan[][]
}

const MAX_GROUPS = 8
const MAX_EXCERPT = 4000

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Collects facts and builds evidence spans from file contents at one commit. */
export class FactBuilder {
  readonly objects = new Map<string, ObjectFact>()
  readonly relations = new Map<string, RelationFact>()
  readonly #files: ReadonlyMap<string, { blobSha: string; lines: string[] }>

  constructor(files: ReadonlyMap<string, { blobSha: string; text: string }>) {
    this.#files = new Map(
      [...files].map(([path, f]) => [path, { blobSha: f.blobSha, lines: f.text.split(/\r?\n/) }]),
    )
  }

  /** A span of lines (1-based, inclusive). Whole-file spans carry no excerpt. */
  span(
    path: string,
    startLine: number,
    endLine: number,
    options: { symbol?: string; excerpt?: boolean } = {},
  ): EvidenceSpan {
    const file = this.#files.get(path)
    if (!file) throw new Error(`no content for ${path}`)
    const end = Math.min(Math.max(endLine, startLine), Math.max(file.lines.length, 1))
    const text = file.lines.slice(startLine - 1, end).join('\n')
    return {
      key: `${path}:${startLine}-${end}@${file.blobSha}`,
      path,
      blobSha: file.blobSha,
      startLine,
      endLine: end,
      spanSha256: sha256(text),
      ...(options.symbol ? { symbol: options.symbol } : {}),
      ...(options.excerpt
        ? { excerpt: text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}\n…` : text }
        : {}),
    }
  }

  wholeFile(path: string): EvidenceSpan {
    const file = this.#files.get(path)
    return this.span(path, 1, file ? Math.max(file.lines.length, 1) : 1)
  }

  object(
    key: string,
    type: string,
    attributes: Record<string, JsonValue>,
    group: EvidenceSpan[],
  ): void {
    const existing = this.objects.get(key)
    if (existing) addGroup(existing.supports, group)
    else this.objects.set(key, { key, type, attributes, supports: [group] })
  }

  relation(type: string, from: string, to: string, group: EvidenceSpan[]): void {
    if (from === to) return
    const key = `${type}|${from}|${to}`
    const existing = this.relations.get(key)
    if (existing) addGroup(existing.supports, group)
    else this.relations.set(key, { key, type, from, to, supports: [group] })
  }
}

function addGroup(groups: EvidenceSpan[][], group: EvidenceSpan[]): void {
  if (groups.length >= MAX_GROUPS) return
  const signature = group.map((s) => s.key).join('|')
  if (!groups.some((g) => g.map((s) => s.key).join('|') === signature)) groups.push(group)
}
