import type { ContextEvidence } from './context.ts'
import type { Citation } from './schemas.ts'

/** Quotes shorter than this many non-space characters could match almost anywhere. */
export const MIN_QUOTE_CHARS = 12

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim()

export interface CitationCheck {
  /** Evidence ids of the valid citations, in order, without duplicates. */
  evidenceIds: string[]
  valid: number
  invalid: { ref: string; reason: string }[]
}

/**
 * The grounding validator (ADR 0010). A citation is valid only when its reference was in the
 * model's context and its quote occurs in that excerpt. Context excerpts were already checked
 * against the evidence's pinned span hash when the context was built, so a valid quote is text
 * of the pinned source. Deterministic; nothing is repaired.
 */
export function checkCitations(
  citations: readonly Citation[],
  evidence: ReadonlyMap<string, ContextEvidence>,
): CitationCheck {
  const evidenceIds: string[] = []
  const invalid: CitationCheck['invalid'] = []
  let valid = 0
  for (const c of citations) {
    const item = evidence.get(c.ref)
    if (!item) {
      invalid.push({ ref: c.ref, reason: 'cites evidence that was not provided' })
      continue
    }
    const quote = normalise(c.quote)
    if (quote.replace(/\s/g, '').length < MIN_QUOTE_CHARS) {
      invalid.push({ ref: c.ref, reason: `quote shorter than ${MIN_QUOTE_CHARS} characters` })
      continue
    }
    if (!normalise(item.excerpt).includes(quote)) {
      invalid.push({ ref: c.ref, reason: 'quote does not occur in the cited source text' })
      continue
    }
    valid++
    if (!evidenceIds.includes(item.id)) evidenceIds.push(item.id)
  }
  return { evidenceIds, valid, invalid }
}
