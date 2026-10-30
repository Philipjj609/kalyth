import { z } from 'zod'
import { ContentId, EvidenceId, PrincipalId } from './ids.ts'
import { SourceMeta } from './knowledge.ts'

const gitSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-hex git sha')

export const LineSpan = z
  .object({ startLine: z.int().min(1), endLine: z.int().min(1) })
  .refine((s) => s.endLine >= s.startLine, 'endLine must be >= startLine')

/** Where a piece of evidence points. Source spans are pinned to a commit and a git blob (ADR 0005). */
export const EvidenceSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sourceSpan'),
    repo: z.string().min(1).max(500),
    commit: gitSha,
    path: z.string().min(1).max(1000),
    blobSha: gitSha,
    span: LineSpan,
    /** SHA-256 of the exact text of the span, so a moved span can be recognised. */
    spanSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    symbol: z.string().min(1).max(500).optional(),
  }),
  z.object({
    kind: z.literal('document'),
    uri: z.string().min(1).max(2000),
    version: z.string().max(200).optional(),
    locator: z.string().max(500).optional(),
    /** Attribution, licence and quote policy; required in libraries (ADR 0026 §7). */
    meta: SourceMeta.optional(),
  }),
  z.object({
    kind: z.literal('external'),
    uri: z.url(),
    retrievedAt: z.iso.datetime(),
    meta: SourceMeta.optional(),
  }),
  z.object({
    kind: z.literal('statement'),
    statedBy: PrincipalId,
  }),
])
export type EvidenceSource = z.infer<typeof EvidenceSource>

export const Collector = z.object({
  tool: z.string().min(1).max(200),
  toolVersion: z.string().min(1).max(100),
})

/** Evidence as submitted in a proposal. The excerpt is stored in the redactable content store. */
export const EvidenceInput = z.object({
  source: EvidenceSource,
  excerpt: z.string().max(8000).optional(),
  collectedBy: Collector,
})
export type EvidenceInput = z.input<typeof EvidenceInput>

/** A content reference: events and proposals carry this, never the raw text (R3). */
export const ContentRef = z.object({
  contentId: ContentId,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type ContentRef = z.infer<typeof ContentRef>

export const EvidenceRecord = z.object({
  id: EvidenceId,
  source: EvidenceSource,
  excerpt: ContentRef.nullable(),
  collectedBy: Collector,
  collectedAt: z.iso.datetime(),
})
export type EvidenceRecord = z.infer<typeof EvidenceRecord>

export const EvidenceView = EvidenceRecord.extend({
  revision: z.int(),
  excerptText: z.string().nullable(),
  excerptRedacted: z.boolean(),
})
export type EvidenceView = z.infer<typeof EvidenceView>
