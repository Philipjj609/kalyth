import type { GitRepository } from '@kalyth/analyzer'

/** A span of one file at the pinned commit. */
export interface Chunk {
  path: string
  startLine: number
  endLine: number
  text: string
}

const EXCLUDED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|bun\.lockb?)$|\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|eot|pdf|zip|gz|lock)$/i

/**
 * Splits every text file at the commit into fixed-size line chunks (ADR 0012). Reads git objects
 * only. Lockfiles, binaries and files over the size limit are left out.
 */
export function chunkRepository(
  git: GitRepository,
  commit: string,
  options: { linesPerChunk?: number; maxFileBytes?: number } = {},
): Chunk[] {
  const linesPerChunk = options.linesPerChunk ?? 60
  const maxFileBytes = options.maxFileBytes ?? 200_000
  const entries = git
    .listTree(commit)
    .filter((e) => e.type === 'blob' && e.size <= maxFileBytes && !EXCLUDED.test(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const blobs = git.readBlobs(entries.map((e) => e.sha))
  const chunks: Chunk[] = []
  for (const entry of entries) {
    const blob = blobs.get(entry.sha)
    if (!blob || blob.subarray(0, 8000).includes(0)) continue
    const lines = blob.toString('utf8').split(/\r?\n/)
    for (let start = 0; start < lines.length; start += linesPerChunk) {
      const slice = lines.slice(start, start + linesPerChunk)
      if (slice.every((l) => l.trim() === '')) continue
      chunks.push({
        path: entry.path,
        startLine: start + 1,
        endLine: start + slice.length,
        text: slice.join('\n'),
      })
    }
  }
  return chunks
}

/** Lower-cased terms, with camelCase and snake_case split and the whole identifier kept too. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2)
    if (parts.length > 1 && word.length >= 2) out.push(word.toLowerCase())
    out.push(...parts)
  }
  return out
}

/** Okapi BM25 over chunks. Deterministic: ties keep the chunk order. */
export class Bm25 {
  readonly #docs: Map<string, number>[]
  readonly #lengths: number[]
  readonly #avg: number
  readonly #df = new Map<string, number>()
  readonly #k1: number
  readonly #b: number

  constructor(texts: readonly string[], k1 = 1.2, b = 0.75) {
    this.#k1 = k1
    this.#b = b
    this.#docs = texts.map((t) => {
      const tf = new Map<string, number>()
      for (const term of tokenize(t)) tf.set(term, (tf.get(term) ?? 0) + 1)
      for (const term of tf.keys()) this.#df.set(term, (this.#df.get(term) ?? 0) + 1)
      return tf
    })
    this.#lengths = this.#docs.map((d) => [...d.values()].reduce((a, n) => a + n, 0))
    this.#avg = this.#lengths.reduce((a, n) => a + n, 0) / Math.max(this.#lengths.length, 1)
  }

  /** Document indexes with scores, best first; documents scoring 0 are left out. */
  rank(query: string): { index: number; score: number }[] {
    const terms = [...new Set(tokenize(query))]
    const n = this.#docs.length
    const scored: { index: number; score: number }[] = []
    this.#docs.forEach((tf, index) => {
      let score = 0
      for (const term of terms) {
        const f = tf.get(term)
        if (!f) continue
        const df = this.#df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        const length = this.#lengths[index] ?? 0
        score +=
          (idf * (f * (this.#k1 + 1))) /
          (f + this.#k1 * (1 - this.#b + (this.#b * length) / this.#avg))
      }
      if (score > 0) scored.push({ index, score })
    })
    return scored.sort((a, b) => b.score - a.score || a.index - b.index)
  }
}

/** Retrieved chunks, best first, rendered within the character budget. */
export function retrieve(chunks: readonly Chunk[], query: string, maxChars: number) {
  const ranked = new Bm25(chunks.map((c) => `${c.path}\n${c.text}`)).rank(query)
  const parts: string[] = []
  const used: Chunk[] = []
  let size = 0
  for (const { index } of ranked) {
    const c = chunks[index] as Chunk
    const part = `<file path="${c.path}" lines="${c.startLine}-${c.endLine}">\n${c.text.replace(/<\/file/gi, '<\\/file')}\n</file>`
    if (size + part.length + 1 > maxChars) continue
    parts.push(part)
    used.push(c)
    size += part.length + 1
  }
  return { text: parts.join('\n'), chunks: used, chars: size, candidates: ranked.length }
}
