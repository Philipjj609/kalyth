import { sha256Hex } from '@kalyth/core'
import type { ContextEvidence } from './context.ts'
import type { Citation } from './schemas.ts'

/** Quotes shorter than this many non-space characters could match almost anywhere. */
export const MIN_QUOTE_CHARS = 12

/** The original comparison (ADR 0010): runs of whitespace count as one space. */
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/** What the bounded second pass may forgive (ADR 0017). */
export type NormalizedDifference = 'typographic quotes' | 'layout' | 'python string delimiters'

export interface GroundingOptions {
  /**
   * Narrow fallback for Python files only: a string literal written with the other ASCII
   * delimiter counts as the same literal when its content has no quotes, backslashes or line
   * breaks. Off unless enabled (ADR 0017).
   */
  pythonStringDelimiters?: boolean
}

export interface CitationOutcome {
  ref: string
  /** The model's quote, verbatim. */
  quote: string
  match: 'exact' | 'normalized' | 'rejected'
  reason?: string
  /** For a normalised match: the source text it located, verbatim from the pinned excerpt. */
  source?: string
  differences?: NormalizedDifference[]
}

export interface CitationCheck {
  /** Evidence ids of the accepted citations, in order, without duplicates. */
  evidenceIds: string[]
  /** Accepted citations: exact plus normalised. */
  valid: number
  /** Accepted by the original comparison; the benchmark metric. */
  exact: number
  /** Accepted only by the bounded second pass. */
  normalized: number
  invalid: { ref: string; reason: string }[]
  outcomes: CitationOutcome[]
}

/**
 * The grounding validator (ADR 0010, ADR 0017). A citation holds only when its reference was in
 * the model's context, the excerpt still hashes to its pinned span, and the quote occurs in that
 * excerpt. Two passes:
 *
 * 1. Exact: the quote occurs in the excerpt, with runs of whitespace counted as one space. This
 *    is the original rule and the metric reported as "exact".
 * 2. Bounded normalisation, only when the first pass fails: typographic quotes read as their
 *    ASCII form, and layout (whitespace between code tokens, line breaks) is ignored. Code tokens
 *    themselves (identifiers, numbers, operators, punctuation, ASCII quote characters) must match
 *    one for one, so no token is ever removed, merged or changed. The match must be unique in the
 *    excerpt. Optionally, Python string delimiters (see GroundingOptions).
 *
 * A normalised match establishes where the quoted text is, not that the model's reading of it is
 * right. Deterministic; nothing is repaired.
 */
export function checkCitations(
  citations: readonly Citation[],
  evidence: ReadonlyMap<string, ContextEvidence>,
  options: GroundingOptions = {},
): CitationCheck {
  const check: CitationCheck = {
    evidenceIds: [],
    valid: 0,
    exact: 0,
    normalized: 0,
    invalid: [],
    outcomes: [],
  }
  for (const c of citations) {
    const outcome = checkOne(c, evidence, options)
    check.outcomes.push(outcome)
    if (outcome.match === 'rejected') {
      check.invalid.push({ ref: c.ref, reason: outcome.reason ?? 'rejected' })
      continue
    }
    check.valid++
    if (outcome.match === 'exact') check.exact++
    else check.normalized++
    const id = evidence.get(c.ref)?.id
    if (id && !check.evidenceIds.includes(id)) check.evidenceIds.push(id)
  }
  return check
}

function checkOne(
  c: Citation,
  evidence: ReadonlyMap<string, ContextEvidence>,
  options: GroundingOptions,
): CitationOutcome {
  const base = { ref: c.ref, quote: c.quote }
  const reject = (reason: string): CitationOutcome => ({ ...base, match: 'rejected', reason })
  const item = evidence.get(c.ref)
  if (!item) return reject('cites evidence that was not provided')
  if (item.sha256 !== undefined && sha256Hex(item.excerpt) !== item.sha256) {
    return reject('the excerpt no longer matches its pinned source')
  }
  if (c.quote.replace(/\s/g, '').length < MIN_QUOTE_CHARS) {
    return reject(`quote shorter than ${MIN_QUOTE_CHARS} characters`)
  }
  if (collapse(item.excerpt).includes(collapse(c.quote))) return { ...base, match: 'exact' }

  const python = options.pythonStringDelimiters === true && /\.pyi?$/i.test(item.path)
  const source = lex(item.excerpt, python)
  const quoted = lex(c.quote, python)
  const starts = occurrences(source, quoted)
  if (starts.length === 0) return reject('quote does not occur in the cited source text')
  if (starts.length > 1) {
    return reject('quote matches more than one place in the excerpt after normalisation')
  }
  const at = starts[0] as number
  const first = source[at] as Token
  const last = source[at + quoted.length - 1] as Token
  const located = item.excerpt.slice(first.start, last.end)
  const differences: NormalizedDifference[] = []
  const pairs = quoted.map((q, i) => [q, source[at + i] as Token] as const)
  if (pairs.some(([q, s]) => q.raw === s.raw && q.original !== s.original)) {
    differences.push('typographic quotes')
  }
  if (pairs.some(([q, s]) => q.raw !== s.raw)) differences.push('python string delimiters')
  const spaced = (tokens: readonly Token[], i: number) =>
    (tokens[i] as Token).start > (tokens[i - 1] as Token).end
  if (pairs.some((_, i) => i > 0 && spaced(quoted, i) !== spaced(source, at + i))) {
    differences.push('layout')
  }
  return { ...base, match: 'normalized', source: located, differences }
}

interface Token {
  /** What is compared: the token itself, or a Python string literal's content. */
  value: string
  /** The token with typographic quotes read as ASCII. */
  raw: string
  /** The token exactly as written. */
  original: string
  start: number
  end: number
}

const ascii = (text: string) => text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')

/**
 * Code tokens: runs of letters, digits and underscores, and every other non-space character on
 * its own. Whitespace only separates tokens, so "return x" and "returnx" never match.
 */
const PLAIN = /[\p{L}\p{N}_]+|\S/gu
const WITH_PYTHON_STRINGS = /'[^'"\\\r\n]*'|"[^'"\\\r\n]*"|[\p{L}\p{N}_]+|\S/gu

/** ascii() maps one character to one character, so offsets in its output hold for the input. */
function lex(text: string, python: boolean): Token[] {
  const pattern = python ? WITH_PYTHON_STRINGS : PLAIN
  const tokens: Token[] = []
  for (const m of ascii(text).matchAll(pattern)) {
    const raw = m[0]
    const start = m.index ?? 0
    const isString = python && raw.length >= 2 && (raw[0] === "'" || raw[0] === '"')
    tokens.push({
      value: isString ? `\u0000str:${raw.slice(1, -1)}` : raw,
      raw,
      original: text.slice(start, start + raw.length),
      start,
      end: start + raw.length,
    })
  }
  return tokens
}

function occurrences(source: readonly Token[], quoted: readonly Token[]): number[] {
  const found: number[] = []
  if (quoted.length === 0) return found
  for (let i = 0; i + quoted.length <= source.length; i++) {
    let same = true
    for (let j = 0; j < quoted.length; j++) {
      if (source[i + j]?.value !== quoted[j]?.value) {
        same = false
        break
      }
    }
    if (same) found.push(i)
  }
  return found
}
