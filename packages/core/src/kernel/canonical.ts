import type { EvidenceRecord, ObjectVersion, RelationVersion } from '@kalyth/contracts'
import { sha256Hex } from '../util.ts'

/** Content that canonical form v1 cannot write: a lone surrogate or an unsafe number. */
export class NotCanonical extends Error {}

/**
 * Canonical form v1 (ADR 0027 §2a, frozen): RFC 8785 ordering and string escaping, keys sorted by
 * UTF-16 code units, every string and key in NFC, JSON numbers only for safe integers. Absent
 * members are omitted; `null` and `false` are written. Decimals are already canonical strings.
 */
export function canonicalV1(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new NotCanonical(`${value} is not a safe integer`)
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(nfc(value))
  if (Array.isArray(value)) return `[${value.map(canonicalV1).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [nfc(k), v] as const)
    // Default string comparison is by UTF-16 code units, as RFC 8785 requires.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalV1(v)}`).join(',')}}`
  }
  throw new NotCanonical(`${typeof value} cannot be written`)
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function nfc(text: string): string {
  if (LONE_SURROGATE.test(text)) throw new NotCanonical('a string holds an unpaired surrogate')
  return text.normalize('NFC')
}

/** Every string and key normalised to NFC, for knowledge written to a library (ADR 0027). */
export function normalizeStrings<T>(value: T): T {
  if (typeof value === 'string') return nfc(value) as T
  if (Array.isArray(value)) return value.map(normalizeStrings) as T
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [nfc(k), normalizeStrings(v)]),
    ) as T
  return value
}

export const canonicalSha256 = (value: unknown): string => sha256Hex(canonicalV1(value))

/** The hash of an evidence record's immutable source, SourceMeta included (vector V6). */
export const evidenceSha256 = (record: EvidenceRecord): string => canonicalSha256(record.source)

export interface KnowledgeVersion {
  /** The canonical text: what is embedded, and what `versionSha256` hashes. */
  text: string
  sha256: string
  /** The evidence the version cites, each with the hash of its record. */
  cites: { evidence: string; evidenceSha256: string }[]
}

/**
 * Canonical form v1 of one object or relation version (ADR 0027 §2a): for objects `type`,
 * `typeVersion`, `maturity`, `attributes` and `claim`; for relations `type`, `typeVersion`,
 * `from`, `to`, `properties` and `claim`. The claim holds `basis` and `supports`; each group cites
 * its evidence by `{ evidence, evidenceSha256 }` and carries its review (`unreviewed` when none)
 * and verifications. Computed values and other timestamps are left out.
 */
export function knowledgeVersion(
  record: ObjectVersion | RelationVersion,
  evidence: (id: string) => EvidenceRecord | undefined,
): KnowledgeVersion {
  const cites = new Map<string, string>()
  const cite = (id: string) => {
    const e = evidence(id)
    if (!e) throw new NotCanonical(`evidence ${id} is missing`)
    const sha = evidenceSha256(e)
    cites.set(id, sha)
    return { evidence: id, evidenceSha256: sha }
  }
  const claim = {
    basis: record.claim.basis,
    supports: record.claim.supports.map((g) => ({
      allOf: g.allOf.map(cite),
      review: g.review ?? { verdict: 'unreviewed' },
      ...(g.verifications ? { verifications: g.verifications } : {}),
    })),
  }
  const content =
    'from' in record
      ? {
          type: record.type,
          typeVersion: record.typeVersion,
          from: record.from,
          to: record.to,
          properties: record.properties,
          claim,
        }
      : (() => {
          const { maturity, ...attributes } = record.attributes
          return {
            type: record.type,
            typeVersion: record.typeVersion,
            ...(maturity === undefined ? {} : { maturity }),
            attributes,
            claim,
          }
        })()
  const text = canonicalV1(content)
  return {
    text,
    sha256: sha256Hex(text),
    cites: [...cites]
      .map(([e, sha]) => ({ evidence: e, evidenceSha256: sha }))
      .sort((a, b) => (a.evidence < b.evidence ? -1 : 1)),
  }
}
