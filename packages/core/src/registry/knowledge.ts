import { ConditionTest, Dimension, Maturity, TypeName } from '@kalyth/contracts'
import { z } from 'zod'
import type { ObjectTypeDef, RelationTypeDef } from './types.ts'

// ---------- knowledge pack: reusable engineering knowledge (ADR 0026) ----------

const name = z.string().min(1).max(300)
const text = z.string().min(1).max(8000)
const aliases = z.array(z.string().min(1).max(300)).max(20).default([])

/** Every knowledge item carries a maturity, changed only by setMaturity (ADR 0030 C7). */
const maturity = {
  maturity: Maturity.default('proposed'),
  maturityReason: z.string().min(1).max(2000).optional(),
}
const curated = {
  reserved: { maturity: 'proposed', maturityReason: null },
  initial: { maturity: ['hypothesis', 'proposed'] },
  reservedBy: 'setMaturity',
} as const

export const knowledgePack: ObjectTypeDef[] = [
  {
    type: 'knowledge.Concept',
    version: 1,
    pack: 'knowledge',
    description: 'A term, quantity, property or quality that knowledge is stated in.',
    attributes: z
      .strictObject({
        name,
        aliases,
        definition: text,
        kind: z.enum(['term', 'quantity', 'property', 'quality']),
        dimension: Dimension.optional(),
        /** The allowed values of a category concept (ADR 0030 A6). */
        values: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
        /** Project element types it describes, used by method selection (ADR 0029). */
        projectTypes: z.array(TypeName).max(20).optional(),
        ...maturity,
      })
      .superRefine((c, ctx) => {
        const issue = (message: string, path: string) =>
          ctx.addIssue({ code: 'custom', message, path: [path] })
        if (
          c.kind === 'quantity' &&
          (!c.dimension || ['boolean', 'category'].includes(c.dimension))
        )
          issue('a quantity has a numeric dimension', 'dimension')
        if (c.kind === 'property' && c.dimension && !['boolean', 'category'].includes(c.dimension))
          issue('a property is boolean or a category; use a quantity for numbers', 'dimension')
        if ((c.kind === 'term' || c.kind === 'quality') && c.dimension)
          issue(`a ${c.kind} has no dimension`, 'dimension')
        if ((c.dimension === 'category') !== (c.values !== undefined))
          issue('a category concept lists its values, and only a category does', 'values')
      }),
    ...curated,
  },
  {
    type: 'knowledge.Principle',
    version: 1,
    pack: 'knowledge',
    description:
      'A normative rule: what to prefer or avoid, why, and where it holds. Names no structure.',
    attributes: z.strictObject({
      statement: text,
      rationale: text,
      scope: text,
      exceptions: z.array(text).max(20).default([]),
      ...maturity,
    }),
    ...curated,
  },
  {
    type: 'knowledge.Pattern',
    version: 1,
    pack: 'knowledge',
    description: 'A reusable structure: components, interactions and the forces it balances.',
    attributes: z.strictObject({
      name,
      aliases,
      problem: text,
      solution: text,
      structure: text,
      consequences: text,
      ...maturity,
    }),
    ...curated,
  },
  {
    type: 'knowledge.Condition',
    version: 1,
    pack: 'knowledge',
    description: 'A test on a quantity or property concept, used by appliesWhen and its kin.',
    attributes: z.strictObject({
      /** A Concept of this library; the pinned form arrives with K2 (ADR 0030 A6). */
      subject: z.string().min(1),
      test: ConditionTest,
      text,
      ...maturity,
    }),
    references: ['subject'],
    ...curated,
  },
  {
    type: 'knowledge.Method',
    version: 1,
    pack: 'knowledge',
    description: 'A repeatable way of assessing or designing, with steps and checks (ADR 0029).',
    attributes: z.strictObject({
      name,
      purpose: text,
      appliesTo: z.strictObject({
        elementTypes: z.array(TypeName).max(20),
        needsScenarios: z.boolean(),
      }),
      needs: z.array(z.string().min(1)).max(50).default([]),
      steps: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z][\w-]{0,63}$/),
            title: name,
            uses: z.array(z.string().min(1)).max(20).default([]),
            reads: z.array(z.string().min(1)).max(20).default([]),
            mode: z.enum(['deterministic', 'model', 'person']),
            produces: z
              .array(z.enum(['assessment', 'question', 'alternative', 'hypothesis']))
              .max(4),
          }),
        )
        .min(1)
        .max(30),
      checks: z
        .array(
          z.enum([
            'alternatives-cite-assessments',
            'no-reliance-on-ruled-out',
            'disputed-flagged',
            'hypotheses-labelled',
            'worsens-disclosed',
            'unknowns-asked',
          ]),
        )
        .max(20)
        .default([]),
      ...maturity,
    }),
    ...curated,
  },
]

export const KNOWLEDGE_TYPES = knowledgePack.map((t) => t.type)

const base = { version: 1, acyclic: false, symmetric: false, temporal: false } as const
const P = 'knowledge.Pattern'
const R = 'knowledge.Principle'
const C = 'knowledge.Concept'
const K = 'knowledge.Condition'

/** Relations of the knowledge pack (ADR 0026 §5). None propagates project impact. */
export const knowledgeRelations: RelationTypeDef[] = [
  {
    ...base,
    type: 'isA',
    pack: 'knowledge',
    description: 'The concept is a kind of the target concept.',
    from: [C],
    to: [C],
    acyclic: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'refines',
    pack: 'knowledge',
    description: 'The pattern is a more specific form of the target pattern.',
    from: [P],
    to: [P],
    acyclic: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'addresses',
    pack: 'knowledge',
    description: 'The item is concerned with a quality or property.',
    from: [P, R],
    to: [C],
    impact: 'none',
  },
  {
    ...base,
    type: 'affects',
    pack: 'knowledge',
    description: 'A trade-off: the pattern improves, worsens or mixes a quality.',
    from: [P],
    to: [C],
    impact: 'none',
  },
  {
    ...base,
    type: 'appliesWhen',
    pack: 'knowledge',
    description: 'A condition the item needs; all of them are jointly required.',
    from: [P, R],
    to: [K],
    impact: 'none',
  },
  {
    ...base,
    type: 'unsuitableWhen',
    pack: 'knowledge',
    description: 'A condition that rules the pattern out.',
    from: [P],
    to: [K],
    impact: 'none',
  },
  {
    ...base,
    type: 'exceptWhen',
    pack: 'knowledge',
    description: 'A condition under which the principle does not hold.',
    from: [R],
    to: [K],
    impact: 'none',
  },
  {
    ...base,
    type: 'competesWith',
    pack: 'knowledge',
    description: 'The patterns answer the same problem in different ways.',
    from: [P],
    to: [P],
    symmetric: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'realizesPrinciple',
    pack: 'knowledge',
    description: 'The pattern is one way to follow the principle.',
    from: [P],
    to: [R],
    impact: 'none',
  },
  {
    ...base,
    type: 'uses',
    pack: 'knowledge',
    description: 'The method relies on the concept, pattern or principle.',
    from: ['knowledge.Method'],
    to: [C, P, R],
    impact: 'none',
  },
]

/** Properties of an `affects` relation (ADR 0026 §5). */
export const AffectsProperties = z.strictObject({
  effect: z.enum(['improves', 'worsens', 'mixed']),
  note: z.string().min(1).max(2000),
  conditions: z.array(z.string()).max(20).optional(),
})
