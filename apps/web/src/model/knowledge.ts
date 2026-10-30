import type {
  AssessmentResult,
  ConditionTest,
  ExplanationStep,
  KnowledgeView,
  ReadAs,
  Verdict,
} from '@kalyth/contracts'
import type { Tone } from './semantics.ts'

/**
 * How the knowledge explorer says things (K5). Verdicts are reported as what they are, declared
 * conditions holding or not, and never as advice: no label says "recommended", "applies" or
 * "use this".
 */
export const VERDICT_META: Record<Verdict, { label: string; tone: Tone; description: string }> = {
  conditionsMet: {
    label: 'Declared conditions met',
    tone: 'success',
    description:
      'Every condition the library declares holds for these values. Not a recommendation: trade-offs, undeclared considerations and alternatives remain to weigh.',
  },
  conditionsNotMet: {
    label: 'Declared conditions not met',
    tone: 'danger',
    description: 'A declared condition rules this item out for these values.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'warning',
    description:
      'A value is missing, unknown, contradictory or straddles a threshold, or the item declares nothing that must hold.',
  },
  excepted: {
    label: 'Excepted',
    tone: 'neutral',
    description: 'A declared exception of the principle holds.',
  },
  conflicting: {
    label: 'Libraries disagree',
    tone: 'danger',
    description:
      'Libraries give opposing verdicts and no accepted decision has chosen between them.',
  },
  notAssessed: {
    label: 'Not assessed',
    tone: 'neutral',
    description: 'A hypothesis never decides a verdict.',
  },
}

export const MATURITY_META: Record<string, { label: string; tone: Tone; description: string }> = {
  hypothesis: {
    label: 'Hypothesis',
    tone: 'neutral',
    description: 'A new idea, never used to decide a verdict.',
  },
  proposed: {
    label: 'Proposed',
    tone: 'warning',
    description: 'Committed with sources; its support is not fully reviewed or verified.',
  },
  established: {
    label: 'Established',
    tone: 'success',
    description:
      'Every support group reviewed and every source verified. Reviewed, not proven; still open to challenge.',
  },
  deprecated: {
    label: 'Deprecated',
    tone: 'neutral',
    description: 'Withdrawn or superseded; kept for history.',
  },
}

export const NATURES = ['current', 'expected', 'target', 'limit'] as const
export type Nature = (typeof NATURES)[number]
export const NATURE_HELP: Record<Nature, string> = {
  current: 'What the system has today',
  expected: 'What the scenario expects',
  target: 'What the design aims for',
  limit: 'A bound the system must stay within',
}

const OPS: Record<string, string> = { lt: '<', le: '≤', gt: '>', ge: '≥', eq: '=', ne: '≠' }

/** A condition's test in words, such as "≤ 8" or "is true". */
export function testText(test: ConditionTest | undefined): string {
  if (!test) return ''
  switch (test.op) {
    case 'is':
      return `is ${test.value ? 'true' : 'false'}`
    case 'in':
      return `is one of ${test.values.join(', ')}`
    case 'between':
      return `between ${test.min} and ${test.max} ${unitText(test.unit)}`.trim()
    default:
      return `${OPS[test.op] ?? test.op} ${test.value} ${unitText(test.unit)}`.trim()
  }
}
const unitText = (unit: string) => (unit === '1' ? '' : unit)

export const RESULT_META: Record<string, { label: string; tone: Tone }> = {
  true: { label: 'holds', tone: 'success' },
  false: { label: 'does not hold', tone: 'danger' },
  unknown: { label: 'unknown', tone: 'warning' },
}

export const REASON_TEXT: Record<string, string> = {
  missing: 'no value stated for this nature',
  'declared-unknown': 'someone stated that the value is unknown',
  straddles: 'the stated range straddles the threshold',
  contradictory: 'two values of this nature conflict',
  'no-correspondence':
    'a value exists for another library’s concept, with no stated correspondence',
  incompatible: 'units or dimensions do not match',
  notAssessed: 'a required item could not be assessed',
}

/** How one step reads in the applicability table. */
export function stepSummary(step: ExplanationStep): string {
  const result = RESULT_META[step.result]?.label ?? step.result
  const reason = step.reason ? `: ${REASON_TEXT[step.reason] ?? step.reason}` : ''
  return `${result}${reason}`
}

export type RelationGroupKey = 'tradeoffs' | 'conditions' | 'structure' | 'other'

const GROUP_OF: Record<string, RelationGroupKey> = {
  affects: 'tradeoffs',
  addresses: 'tradeoffs',
  appliesWhen: 'conditions',
  unsuitableWhen: 'conditions',
  exceptWhen: 'conditions',
  requires: 'conditions',
  refines: 'structure',
  isA: 'structure',
  competesWith: 'structure',
  realizesPrinciple: 'structure',
  supersedes: 'structure',
  contradicts: 'structure',
  uses: 'structure',
}

export const RELATION_TEXT: Record<string, [string, string]> = {
  affects: ['affects', 'is affected by'],
  addresses: ['addresses', 'is addressed by'],
  appliesWhen: ['needs', 'is needed by'],
  unsuitableWhen: ['is ruled out when', 'rules out'],
  exceptWhen: ['does not hold when', 'is an exception to'],
  requires: ['requires', 'is required by'],
  refines: ['refines', 'is refined by'],
  isA: ['is a kind of', 'has the kind'],
  competesWith: ['competes with', 'competes with'],
  realizesPrinciple: ['realises', 'is realised by'],
  supersedes: ['supersedes', 'is superseded by'],
  contradicts: ['contradicts', 'is contradicted by'],
  uses: ['uses', 'is used by'],
  concerns: ['concerns', 'is the subject of'],
}

export function groupRelations(relations: KnowledgeView['relations']) {
  const groups: Record<RelationGroupKey, KnowledgeView['relations']> = {
    tradeoffs: [],
    conditions: [],
    structure: [],
    other: [],
  }
  for (const r of relations) {
    const group = GROUP_OF[r.type] ?? 'other'
    // Only the item's own conditions are its conditions; being required by another item is structure.
    groups[group === 'conditions' && r.direction === 'in' ? 'structure' : group].push(r)
  }
  return groups
}

export const EFFECT_META: Record<string, { label: string; tone: Tone }> = {
  improves: { label: 'improves', tone: 'success' },
  worsens: { label: 'worsens', tone: 'danger' },
  mixed: { label: 'mixed', tone: 'warning' },
}

/** The short statement a reader needs first: what kind of result this is, and what it is not. */
export function readAsLines(readAs: ReadAs): { tone: Tone; text: string }[] {
  const lines: { tone: Tone; text: string }[] = []
  if (!readAs.current)
    lines.push({ tone: 'warning', text: 'Stale: this result describes an earlier state.' })
  if (!readAs.supported)
    lines.push({
      tone: 'warning',
      text: 'Not established: nothing it declares has to hold, or no support still counts.',
    })
  if (!readAs.resolved)
    lines.push({ tone: 'warning', text: 'Unresolved: a value could not be used across libraries.' })
  lines.push({
    tone: 'neutral',
    text: 'Not a recommendation. It reports declared conditions and their evidence.',
  })
  return lines
}

/** Whether an assessment needs the reader's attention before anything else. */
export function attention(result: Pick<AssessmentResult, 'verdict' | 'explanation'>): string[] {
  const e = result.explanation
  return [
    e.specification === 'underspecified'
      ? 'The library declares nothing that must hold for this item.'
      : undefined,
    e.missing.length > 0
      ? `${e.missing.length} value(s) missing for ${e.nature} values.`
      : undefined,
    e.conflict?.state === 'unsettled'
      ? 'Libraries disagree, and no decision has chosen between them.'
      : undefined,
    e.conflict?.state === 'settled'
      ? 'Libraries disagree; an accepted decision chose which guidance to follow. The disagreement remains.'
      : undefined,
    e.knowledge.disputed ? 'This knowledge is disputed.' : undefined,
    e.knowledge.maturity !== 'established'
      ? `This knowledge is ${e.knowledge.maturity}, not established.`
      : undefined,
    e.scenario.status !== 'committed'
      ? `The scenario is ${e.scenario.status}: ${e.scenario.rationale}`
      : undefined,
  ].filter((x): x is string => Boolean(x))
}
