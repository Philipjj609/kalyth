import { z } from 'zod'

/**
 * Output contracts for the model (ADR 0010). Every field is required and objects are strict, so
 * the JSON Schema works with strict structured output, and the model cannot add operations,
 * statuses or anything else the Navigator does not map deliberately.
 */
export const Citation = z.strictObject({
  ref: z.string().regex(/^E\d{1,4}$/),
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

export const AlternativesOutput = z.strictObject({
  decision: z.strictObject({
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(600),
  }),
  alternatives: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(1500),
        tradeoffs: z.string().min(1).max(1500),
        confidence: Confidence,
        rationale: z.string().min(1).max(600),
        directChanges: z
          .array(
            z.strictObject({
              element: z.string().regex(/^N\d{1,4}$/),
              change: z.string().min(1).max(400),
              citations: z.array(Citation).max(4),
            }),
          )
          .min(1)
          .max(15),
      }),
    )
    .min(2)
    .max(4),
  questions: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(600),
        inquiryRole: z.enum(['blocking', 'decision-sensitive', 'model-sensitive', 'exploratory']),
        options: z.array(z.string().min(1).max(200)).max(4),
      }),
    )
    .max(3),
})
export type AlternativesOutput = z.infer<typeof AlternativesOutput>
