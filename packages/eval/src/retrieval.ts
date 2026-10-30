import type { GitRepository } from '@kalyth/analyzer'
import { Bm25 } from '@kalyth/core'

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

// BM25 and its tokenizer live in core, so method selection ranks exactly as retrieval does
// (ADR 0029 §4.1).
export { Bm25, tokenize } from '@kalyth/core'

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
