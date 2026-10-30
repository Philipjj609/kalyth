import { z } from 'zod'
import { EvidenceId, ObjectId, PrincipalId, ProjectId } from './ids.ts'

/**
 * Contracts of knowledge libraries (ADRs 0026 and 0030). A library is a project of kind
 * `library`: it holds reusable engineering knowledge with its sources, curated by people.
 */
export const ProjectKind = z.enum(['project', 'library'])
export type ProjectKind = z.infer<typeof ProjectKind>

/** The lifecycle a curator sets, stored (ADR 0026 §4). Dispute is computed on read, never stored. */
export const Maturity = z.enum(['hypothesis', 'proposed', 'established', 'deprecated'])
export type Maturity = z.infer<typeof Maturity>

/** What a knowledge item may start as: never established (ADR 0030, I3). */
export const INITIAL_MATURITIES: readonly Maturity[] = ['hypothesis', 'proposed']

/** The moves `setMaturity` allows (ADR 0030 §3). Deprecated is final. */
export const MATURITY_TRANSITIONS: Readonly<Record<Maturity, readonly Maturity[]>> = {
  hypothesis: ['proposed', 'deprecated'],
  proposed: ['established', 'deprecated'],
  established: ['proposed', 'deprecated'],
  deprecated: [],
}

export const Licence = z.enum([
  'public-domain',
  'cc-by',
  'cc-by-sa',
  'permissive',
  'proprietary',
  'unknown',
])
export type Licence = z.infer<typeof Licence>

/** How much of a source may be stored (ADR 0026 §7). */
export const QuotePolicy = z.enum(['full', 'excerpt', 'none'])
export type QuotePolicy = z.infer<typeof QuotePolicy>

/** Limits for `excerpt`: per quote, and quotes per source in one claim. */
export const EXCERPT_LIMITS = { maxChars: 600, maxPerSourcePerClaim: 3 } as const

/**
 * Attribution and licence of a document or external source, carried in its `meta` (ADR 0030 A5).
 * A document's own `version` and `locator` are not repeated here.
 */
export const SourceMeta = z.object({
  title: z.string().min(1).max(500),
  authors: z.array(z.string().min(1).max(200)).min(1).max(50),
  publisher: z.string().min(1).max(300).optional(),
  edition: z.string().min(1).max(100).optional(),
  version: z.string().min(1).max(200).optional(),
  /** Year, year-month or date of publication. */
  published: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD')
    .optional(),
  locator: z.string().min(1).max(500).optional(),
  licence: Licence,
  quotePolicy: QuotePolicy,
})
export type SourceMeta = z.infer<typeof SourceMeta>

/**
 * A support group's key (ADR 0030 A1): `sg_` and the first 32 hex digits of the SHA-256 of the
 * canonical JSON of its sorted, de-duplicated evidence ids. Computed, never stored.
 */
export const SupportGroupKey = z.string().regex(/^sg_[0-9a-f]{32}$/, 'expected a support group key')
export type SupportGroupKey = z.infer<typeof SupportGroupKey>

/** A person's judgement that a group's evidence backs the claim (ADR 0026 §6.3). */
export const SupportVerdict = z.enum(['supports', 'partly', 'doesNotSupport', 'unreviewed'])
export type SupportVerdict = z.infer<typeof SupportVerdict>

/** The verdicts `reviewSupport` records. `unreviewed` is the absence of a review. */
export const ReviewVerdict = z.enum(['supports', 'partly', 'doesNotSupport'])
export type ReviewVerdict = z.infer<typeof ReviewVerdict>

export const SupportReview = z.object({
  verdict: SupportVerdict,
  reviewer: PrincipalId,
  reviewedAt: z.iso.datetime(),
  note: z.string().min(1).max(2000),
  scopeLimit: z.string().min(1).max(500).optional(),
})
export type SupportReview = z.infer<typeof SupportReview>

export const VerificationStatus = z.enum(['verified', 'failed', 'unverified'])
export type VerificationStatus = z.infer<typeof VerificationStatus>

export const VerificationMethod = z.enum(['retrievedHash', 'manual'])
export type VerificationMethod = z.infer<typeof VerificationMethod>

/**
 * That a cited source exists at the stated version and the locator points to the passage relied
 * on (ADR 0026 §6.2). Recorded in the citing claim's support group, since evidence is immutable
 * (ADR 0030 C1). An absent record means `unverified` (A3).
 */
export const SourceVerification = z.object({
  status: VerificationStatus,
  method: VerificationMethod,
  by: PrincipalId,
  at: z.iso.datetime(),
  retrievedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** The curator's confirmed licence for this citation; the evidence's own stays unchanged. */
  licence: Licence.optional(),
  note: z.string().min(1).max(2000),
})
export type SourceVerification = z.infer<typeof SourceVerification>

/**
 * Moves `verifySource` allows from each status (ADR 0030 A3). A missing record is `unverified`,
 * and withdrawing a verification nobody recorded is refused.
 */
export const VERIFICATION_TRANSITIONS: Readonly<
  Record<VerificationStatus, readonly VerificationStatus[]>
> = {
  unverified: ['verified', 'failed'],
  verified: ['verified', 'failed', 'unverified'],
  failed: ['verified', 'failed', 'unverified'],
}

/** Whether an item is in dispute, computed on read (ADR 0026 §4 and ADR 0030 C4). */
export const Dispute = z.object({
  status: z.enum(['none', 'disputed']),
  /** Knowledge items whose committed `contradicts` points at this one. */
  by: z.array(z.string()),
  /** The claim's own `contradictedBy` evidence. */
  contradictedBy: z.array(z.string()),
})
export type Dispute = z.infer<typeof Dispute>

/**
 * Kalyth comparing a stored quote with stored source content (ADR 0030 A9). K1 stores no source
 * content, so a stored quote is `unchecked`; `matched` and `mismatch` wait for it.
 */
export const QuoteMatch = z.enum(['notApplicable', 'unchecked', 'matched', 'mismatch'])
export type QuoteMatch = z.infer<typeof QuoteMatch>

/**
 * How a knowledge item stands, computed on read: maturity as stored, dispute, and each support
 * group's review and sources. Quote match, verification and review are reported separately and
 * never combined into "true" (ADR 0026 §6).
 */
export const KnowledgeItemStatus = z.object({
  id: ObjectId,
  type: z.string(),
  maturity: Maturity,
  dispute: Dispute,
  /** At least one group still counts as support (ADR 0030 A3). */
  supported: z.boolean(),
  /** What ADR 0026 I3 still needs before the item may be established; empty when it holds. */
  establishedGaps: z.array(z.string()),
  groups: z.array(
    z.object({
      key: SupportGroupKey,
      allOf: z.array(EvidenceId),
      review: SupportVerdict,
      scopeLimit: z.string().optional(),
      sources: z.array(
        z.object({
          evidence: EvidenceId,
          kind: z.string(),
          /** Whether a quote is stored, or the citation is a paraphrase with a locator. */
          quote: z.enum(['none', 'stored']),
          quoteMatch: QuoteMatch,
          /**
           * Whether a person found the source and the passage at the locator (ADR 0030 A9). It
           * never says that a stored quote is verbatim. Null for statements, which are not
           * verified this way.
           */
          locatorVerification: VerificationStatus.nullable(),
        }),
      ),
      counts: z.boolean(),
    }),
  ),
})
export type KnowledgeItemStatus = z.infer<typeof KnowledgeItemStatus>

export const KnowledgeStatusQuery = z.object({
  projectId: ProjectId,
  revision: z.int().min(0).optional(),
  ids: z.array(ObjectId).min(1).max(1000).optional(),
})
export type KnowledgeStatusQuery = z.input<typeof KnowledgeStatusQuery>

export const KnowledgeStatusResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  items: z.array(KnowledgeItemStatus),
})
export type KnowledgeStatusResult = z.infer<typeof KnowledgeStatusResult>

/** How a pin resolved (ADR 0027 §5a): never to a different version, and never silently. */
export const PinResolution = z.union([
  z.object({
    state: z.literal('resolved'),
    from: z.enum(['embedded', 'library']),
    content: z.unknown(),
  }),
  z.object({
    state: z.literal('unresolved'),
    reason: z.enum(['unknown-library', 'unknown-revision', 'unknown-target', 'hash-mismatch']),
    detail: z.string(),
  }),
])
export type PinResolution = z.infer<typeof PinResolution>

/**
 * A pin against the library revision its project uses (ADR 0027 §4): `current` at that revision,
 * `unchanged` when older but identical, `changed` or `removed` when the used revision differs,
 * `noLibraryUse` or `libraryNotPresent` when it cannot be compared.
 */
export const PinFreshness = z.enum([
  'current',
  'unchanged',
  'changed',
  'removed',
  'noLibraryUse',
  'libraryNotPresent',
])
export type PinFreshness = z.infer<typeof PinFreshness>

export const PinStatus = z.object({
  evidence: EvidenceId,
  library: ProjectId,
  target: z.enum(['object', 'relation']),
  id: z.string(),
  revision: z.int().min(0),
  versionSha256: z.string(),
  resolution: PinResolution,
  /** The revision compared against: the LibraryUse's, or the one previewed. */
  comparedWith: z.int().min(0).nullable(),
  freshness: PinFreshness,
})
export type PinStatus = z.infer<typeof PinStatus>

export const PinStatusQuery = z.object({
  projectId: ProjectId,
  revision: z.int().min(0).optional(),
  /** Library revisions to compare with instead of the LibraryUse's: a preview of moving it. */
  preview: z.record(ProjectId, z.int().min(0)).optional(),
})
export type PinStatusQuery = z.input<typeof PinStatusQuery>

export const PinStatusResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  pins: z.array(PinStatus),
})
export type PinStatusResult = z.infer<typeof PinStatusResult>
