/** Normalises a path a model wrote: slashes, leading ./ and surrounding quotes or spaces. */
export function normalisePath(path: string): string {
  return path
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
}

export interface Score {
  predicted: number
  truePositives: string[]
  falsePositives: string[]
  missed: string[]
  /** Paths that do not exist at the commit; reported, never scored. */
  unsupported: string[]
  recall: number
  precision: number
  f1: number
}

/**
 * File-level recall and precision against the frozen truth (ADR 0012). Only paths that exist at
 * the commit are scored; invented paths are counted separately as unsupported.
 */
export function scoreFiles(
  predictedRaw: readonly string[],
  truth: readonly string[],
  existing: ReadonlySet<string>,
): Score {
  const predicted = [...new Set(predictedRaw.map(normalisePath))]
  const unsupported = predicted.filter((p) => !existing.has(p))
  const scored = predicted.filter((p) => existing.has(p))
  const expected = new Set(truth.map(normalisePath))
  const truePositives = scored.filter((p) => expected.has(p))
  const falsePositives = scored.filter((p) => !expected.has(p))
  const missed = [...expected].filter((p) => !truePositives.includes(p))
  const recall = expected.size === 0 ? 0 : truePositives.length / expected.size
  const precision = scored.length === 0 ? 0 : truePositives.length / scored.length
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision)
  return {
    predicted: predicted.length,
    truePositives,
    falsePositives,
    missed,
    unsupported,
    recall,
    precision,
    f1,
  }
}
