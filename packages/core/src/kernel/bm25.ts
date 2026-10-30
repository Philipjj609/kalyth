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
