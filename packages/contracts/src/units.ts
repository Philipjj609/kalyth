import { z } from 'zod'

/**
 * Dimensions and units (ADR 0028 §1). Units convert within a dimension by exact rational factors,
 * without offsets. The catalogue is versioned on its own: adding a unit changes evaluation.
 */
export const UNIT_CATALOGUE_VERSION = 1

export const Dimension = z.enum([
  'time',
  'dataSize',
  'dataRate',
  'frequency',
  'count',
  'ratio',
  'money',
  'boolean',
  'category',
])
export type Dimension = z.infer<typeof Dimension>

/** A factor to the base unit, as numerator and denominator. */
export type UnitFactor = readonly [bigint, bigint]

const p10 = (n: number) => 10n ** BigInt(n)
const p2 = (n: number) => 2n ** BigInt(n)

/** Numeric dimensions with a fixed unit list. Money takes ISO 4217 codes, never converted. */
export const UNITS: Readonly<
  Record<
    'time' | 'dataSize' | 'dataRate' | 'frequency' | 'count' | 'ratio',
    Readonly<Record<string, UnitFactor>>
  >
> = {
  time: {
    ns: [1n, p10(9)],
    µs: [1n, p10(6)],
    ms: [1n, p10(3)],
    s: [1n, 1n],
    min: [60n, 1n],
    h: [3600n, 1n],
    d: [86400n, 1n],
  },
  dataSize: {
    B: [1n, 1n],
    kB: [p10(3), 1n],
    MB: [p10(6), 1n],
    GB: [p10(9), 1n],
    TB: [p10(12), 1n],
    KiB: [p2(10), 1n],
    MiB: [p2(20), 1n],
    GiB: [p2(30), 1n],
    TiB: [p2(40), 1n],
  },
  dataRate: {
    'bit/s': [1n, 8n],
    'kbit/s': [p10(3), 8n],
    'Mbit/s': [p10(6), 8n],
    'Gbit/s': [p10(9), 8n],
    'B/s': [1n, 1n],
    'kB/s': [p10(3), 1n],
    'MB/s': [p10(6), 1n],
    'GB/s': [p10(9), 1n],
  },
  frequency: {
    Hz: [1n, 1n],
    '1/s': [1n, 1n],
    '1/min': [1n, 60n],
    '1/h': [1n, 3600n],
    '1/d': [1n, 86400n],
  },
  count: { '1': [1n, 1n] },
  ratio: { '1': [1n, 1n], '%': [1n, 100n] },
}

export const CURRENCY = /^[A-Z]{3}$/

/**
 * A canonical decimal string (ADR 0027 §2a): no sign for positive values, no leading zeros, no
 * trailing zeros after the point, no exponent, and `-0` written as `0`. Input in the looser form
 * `[+-]digits[.digits]` is normalised at write.
 */
export const Decimal = z
  .string()
  .regex(/^[+-]?\d{1,30}(\.\d{1,30})?$/, 'expected a decimal number such as 12.5')
  .transform(canonicalDecimal)

export function canonicalDecimal(text: string): string {
  const negative = text.startsWith('-')
  const unsigned = text.replace(/^[+-]/, '')
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const int = whole.replace(/^0+(?=\d)/, '')
  const frac = fraction.replace(/0+$/, '')
  const body = frac ? `${int}.${frac}` : int
  return negative && /[1-9]/.test(body) ? `-${body}` : body
}

/** A test a Condition applies to its subject concept (ADR 0028 §4). */
export const ConditionTest = z.union([
  z.object({ op: z.enum(['lt', 'le', 'gt', 'ge', 'eq', 'ne']), value: Decimal, unit: z.string() }),
  z.object({ op: z.literal('between'), min: Decimal, max: Decimal, unit: z.string() }),
  z.object({ op: z.literal('is'), value: z.boolean() }),
  z.object({ op: z.literal('in'), values: z.array(z.string().min(1).max(200)).min(1).max(100) }),
])
export type ConditionTest = z.infer<typeof ConditionTest>
