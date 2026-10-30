import { type ConditionTest, CURRENCY, type Dimension, UNITS } from '@kalyth/contracts'

/** An exact rational, denominator positive. */
export interface Rational {
  n: bigint
  d: bigint
}

export function parseDecimal(text: string): Rational {
  const negative = text.startsWith('-')
  const [whole = '0', fraction = ''] = text.replace(/^[+-]/, '').split('.')
  const d = 10n ** BigInt(fraction.length)
  const n = BigInt(whole + fraction)
  return { n: negative ? -n : n, d }
}

export const compare = (a: Rational, b: Rational): number => {
  const diff = a.n * b.d - b.n * a.d
  return diff < 0n ? -1 : diff > 0n ? 1 : 0
}

const NUMERIC = new Set<Dimension>(['time', 'dataSize', 'dataRate', 'frequency', 'count', 'ratio'])

export const isNumericDimension = (d: Dimension): boolean => NUMERIC.has(d) || d === 'money'

/**
 * Converts a value to the dimension's base unit exactly (ADR 0028 §1). Money stays in its own
 * currency: the result carries it, and values in different currencies never compare.
 */
export function toBase(
  value: string,
  unit: string,
  dimension: Dimension,
): { value: Rational; currency?: string } | { error: string } {
  if (dimension === 'money') {
    if (!CURRENCY.test(unit)) return { error: `${unit} is not a currency code` }
    return { value: parseDecimal(value), currency: unit }
  }
  if (!NUMERIC.has(dimension)) return { error: `${dimension} has no units` }
  const factor = UNITS[dimension as keyof typeof UNITS][unit]
  if (!factor) return { error: `${unit} is not a unit of ${dimension}` }
  const v = parseDecimal(value)
  if (dimension === 'count' && v.d !== 1n && v.n % v.d !== 0n)
    return { error: 'counts are whole numbers' }
  return { value: { n: v.n * factor[0], d: v.d * factor[1] } }
}

interface Bound {
  at: Rational
  inclusive: boolean
}

/** A set of numbers: an interval, minus some excluded points. */
interface NumberSet {
  min?: Bound | undefined
  max?: Bound | undefined
  excluded: Rational[]
}

function intervalOf(test: ConditionTest, base: (v: string) => Rational): NumberSet | undefined {
  switch (test.op) {
    case 'lt':
      return { max: { at: base(test.value), inclusive: false }, excluded: [] }
    case 'le':
      return { max: { at: base(test.value), inclusive: true }, excluded: [] }
    case 'gt':
      return { min: { at: base(test.value), inclusive: false }, excluded: [] }
    case 'ge':
      return { min: { at: base(test.value), inclusive: true }, excluded: [] }
    case 'eq': {
      const at = base(test.value)
      return { min: { at, inclusive: true }, max: { at, inclusive: true }, excluded: [] }
    }
    case 'ne':
      return { excluded: [base(test.value)] }
    case 'between':
      return {
        min: { at: base(test.min), inclusive: true },
        max: { at: base(test.max), inclusive: true },
        excluded: [],
      }
    default:
      return undefined
  }
}

const tighter = (a: Bound | undefined, b: Bound | undefined, side: 'min' | 'max') => {
  if (!a) return b
  if (!b) return a
  const c = compare(a.at, b.at)
  if (c === 0) return { at: a.at, inclusive: a.inclusive && b.inclusive }
  return (side === 'min' ? c > 0 : c < 0) ? a : b
}

/**
 * Whether conditions that must all hold on one concept can hold together (ADR 0028 §7). Tests are
 * in one dimension; numeric values are compared in the base unit.
 */
export function jointlySatisfiable(
  tests: readonly ConditionTest[],
  base: (value: string, unit: string) => Rational,
): boolean {
  const booleans = new Set(tests.flatMap((t) => (t.op === 'is' ? [t.value] : [])))
  if (booleans.size > 1) return false
  const categories = tests.flatMap((t) => (t.op === 'in' ? [new Set(t.values)] : []))
  if (categories.length > 0) {
    const [first, ...rest] = categories
    const common = [...(first ?? [])].filter((v) => rest.every((s) => s.has(v)))
    if (common.length === 0) return false
  }
  let set: NumberSet = { excluded: [] }
  for (const test of tests) {
    const unit = 'unit' in test ? test.unit : ''
    const next = intervalOf(test, (v) => base(v, unit))
    if (!next) continue
    set = {
      min: tighter(set.min, next.min, 'min'),
      max: tighter(set.max, next.max, 'max'),
      excluded: [...set.excluded, ...next.excluded],
    }
  }
  const { min, max } = set
  if (min && max) {
    const c = compare(min.at, max.at)
    if (c > 0 || (c === 0 && !(min.inclusive && max.inclusive))) return false
    // A single remaining point is ruled out if a test excludes it.
    if (c === 0 && set.excluded.some((x) => compare(x, min.at) === 0)) return false
  }
  return true
}

/** The values of one interval: unbounded where an end is absent. */
export interface Interval {
  min?: Bound | undefined
  max?: Bound | undefined
}

const lowerFits = (outer: Bound | undefined, inner: Bound | undefined) => {
  if (!outer) return true
  if (!inner) return false
  const c = compare(outer.at, inner.at)
  return c < 0 || (c === 0 && (outer.inclusive || !inner.inclusive))
}
const upperFits = (outer: Bound | undefined, inner: Bound | undefined) => {
  if (!outer) return true
  if (!inner) return false
  const c = compare(outer.at, inner.at)
  return c > 0 || (c === 0 && (outer.inclusive || !inner.inclusive))
}

export function containsPoint(i: Interval, x: Rational): boolean {
  const above =
    !i.min || compare(x, i.min.at) > 0 || (compare(x, i.min.at) === 0 && i.min.inclusive)
  const below =
    !i.max || compare(x, i.max.at) < 0 || (compare(x, i.max.at) === 0 && i.max.inclusive)
  return above && below
}

/**
 * How the values of `p` relate to the values a test accepts (ADR 0028 §4): `all` when every value
 * of `p` passes, `none` when none does, `some` otherwise, which reads as unknown, `straddles`.
 */
export function relateToTest(
  p: Interval,
  test: ConditionTest,
  base: (v: string) => Rational,
): 'all' | 'none' | 'some' {
  const set = intervalOf(test, base)
  if (!set) return 'some'
  const excludedInside = set.excluded.filter((x) => containsPoint(p, x))
  const subset =
    lowerFits(set.min, p.min) && upperFits(set.max, p.max) && excludedInside.length === 0
  if (subset) return 'all'
  const min = tighter(set.min, p.min, 'min')
  const max = tighter(set.max, p.max, 'max')
  if (min && max) {
    const c = compare(min.at, max.at)
    if (c > 0 || (c === 0 && !(min.inclusive && max.inclusive))) return 'none'
    if (c === 0 && set.excluded.some((x) => compare(x, min.at) === 0)) return 'none'
  }
  return 'some'
}
