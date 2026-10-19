import { z } from 'zod'

/**
 * Output contracts for the model (ADR 0010). Every field is required and objects are strict, so
 * the JSON Schema works with strict structured output, and the model cannot add operations,
 * statuses or anything else the Navigator does not map deliberately.
 */
/** E refs are source excerpts; S refs are what a person said (ADR 0022). */
export const Citation = z.strictObject({
  ref: z.string().regex(/^[ES]\d{1,4}$/),
  quote: z.string().min(1).max(400),
})
export type Citation = z.infer<typeof Citation>

const Confidence = z.enum(['low', 'medium', 'high'])

export const SummaryOutput = z.strictObject({
  statements: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(600),
        citations: z.array(Citation).min(1).max(6),
        confidence: Confidence,
        rationale: z.string().min(1).max(400),
      }),
    )
    .min(1)
    .max(8),
})
export type SummaryOutput = z.infer<typeof SummaryOutput>

/** Alternatives are numbered A1, A2, ... in order; a hybrid names the earlier ones it combines. */
const AlternativeHandle = z.string().regex(/^A\d{1,2}$/)

/** Element types the Navigator may propose as new, to-be elements (ADR 0022). */
export const PROPOSABLE_TYPES = [
  'software.Container',
  'software.Component',
  'software.DataEntity',
  'software.Endpoint',
] as const

/**
 * A new element that does not exist yet, numbered P1, P2, ... (ADR 0022). An endpoint's name is
 * "METHOD /path". `within` is the N or earlier P ref of the container it belongs in, or empty.
 */
const NewElement = z.strictObject({
  ref: z.string().regex(/^P\d{1,2}$/),
  type: z.enum(PROPOSABLE_TYPES),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  within: z.string().regex(/^(|N\d{1,4}|P\d{1,2})$/),
  confidence: Confidence,
  citations: z.array(Citation).max(4),
})
export type NewElement = z.infer<typeof NewElement>

const AlternativeItem = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1500),
  tradeoffs: z.string().min(1).max(1500),
  confidence: Confidence,
  rationale: z.string().min(1).max(600),
  /** For a hybrid, the earlier alternatives it combines; empty otherwise. */
  combines: z.array(AlternativeHandle).max(3),
  directChanges: z
    .array(
      z.strictObject({
        element: z.string().regex(/^(N\d{1,4}|P\d{1,2})$/),
        change: z.string().min(1).max(400),
        citations: z.array(Citation).max(4),
      }),
    )
    .min(1)
    .max(8),
})

const Questions = z
  .array(
    z.strictObject({
      text: z.string().min(1).max(600),
      inquiryRole: z.enum(['blocking', 'decision-sensitive', 'model-sensitive', 'exploratory']),
      options: z.array(z.string().min(1).max(200)).max(4),
    }),
  )
  .max(3)

export const AlternativesOutput = z.strictObject({
  decision: z.strictObject({
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(600),
  }),
  newElements: z.array(NewElement).max(8),
  alternatives: z.array(AlternativeItem).min(2).max(5),
  questions: Questions,
})
export type AlternativesOutput = z.infer<typeof AlternativesOutput>

/** Exploring an open decision again: new alternatives and questions for the same decision. */
export const RefineOutput = z.strictObject({
  newElements: z.array(NewElement).max(8),
  alternatives: z.array(AlternativeItem).min(1).max(4),
  questions: Questions,
})
export type RefineOutput = z.infer<typeof RefineOutput>
