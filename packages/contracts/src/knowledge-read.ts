import { z } from 'zod'
import { AssessmentFreshness, Explanation, ParameterNature, Verdict } from './assessment.ts'
import { ObjectId, ProjectId } from './ids.ts'
import { Dispute, KnowledgeItemStatus, Maturity, SourceMeta } from './knowledge.ts'

/**
 * Read-only access to knowledge and assessments for agents and other clients (K4, ADR 0031). One
 * contract per operation, shared by MCP and HTTP. Nothing here writes.
 */

const revision = z.int().min(0).optional()
const ItemId = z.string().regex(/^(obj|rel)_[0-9a-f]{32}$/, 'expected an object or relation id')

/**
 * How to read a result, in fields an agent can act on without parsing prose. `recommendation`
 * is always false: Kalyth reports declared conditions and their evidence, never advice.
 */
export const ReadAs = z.object({
  recommendation: z.literal(false),
  /** False when the result describes an earlier state than the one it would have now. */
  current: z.boolean(),
  /** False when no support group still counts, or the item declares nothing that must hold. */
  supported: z.boolean(),
  /** False when a pin or reference could not be resolved to verified content. */
  resolved: z.boolean(),
  note: z.string(),
})
export type ReadAs = z.infer<typeof ReadAs>

export const KnowledgeSearchInput = z.object({
  /** A library, searched at its head, or a project, whose used libraries are searched at the revisions it uses. */
  projectId: ProjectId,
  text: z.string().min(1).max(200),
  types: z
    .array(z.string().regex(/^knowledge\.[A-Z]\w*$/))
    .max(5)
    .optional(),
  limit: z.int().min(1).max(100).default(20),
})
export type KnowledgeSearchInput = z.input<typeof KnowledgeSearchInput>

export const KnowledgeHit = z.object({
  library: ProjectId,
  libraryName: z.string(),
  revision: z.int().min(0),
  id: z.string(),
  type: z.string(),
  name: z.string(),
  maturity: Maturity,
  disputed: z.boolean(),
  matchedOn: z.enum(['name', 'alias', 'text']),
})

export const KnowledgeSearchResult = z.object({
  projectId: ProjectId,
  /** The libraries searched, and those skipped because the caller cannot read them. */
  libraries: z.array(
    z.object({
      library: ProjectId,
      revision: z.int().min(0),
      searched: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  hits: z.array(KnowledgeHit),
  truncated: z.boolean(),
})
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>

export const GetKnowledgeInput = z.object({
  library: ProjectId,
  id: ItemId,
  /** Default: the library's head. */
  revision,
})
export type GetKnowledgeInput = z.input<typeof GetKnowledgeInput>

/** One cited source with its provenance, never with a claim that its wording was matched. */
export const KnowledgeSource = z.object({
  evidence: z.string(),
  kind: z.string(),
  uri: z.string().optional(),
  locator: z.string().optional(),
  meta: SourceMeta.optional(),
  statedBy: z.string().optional(),
})

export const KnowledgeView = z.object({
  library: ProjectId,
  libraryName: z.string(),
  revision: z.int().min(0),
  headRevision: z.int().min(0),
  id: z.string(),
  target: z.enum(['object', 'relation']),
  type: z.string(),
  /** The version's canonical form v1 and its hash, as a pin of it would record (ADR 0027). */
  versionSha256: z.string(),
  content: z.unknown(),
  maturity: Maturity.optional(),
  dispute: Dispute.optional(),
  support: KnowledgeItemStatus.shape.groups.optional(),
  sources: z.array(KnowledgeSource),
  relations: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      direction: z.enum(['out', 'in']),
      other: z.object({ id: z.string(), type: z.string(), name: z.string() }),
      properties: z.record(z.string(), z.unknown()),
    }),
  ),
  /** Relations beyond the bound are counted, not listed. */
  relationsOmitted: z.int().min(0),
  readAs: ReadAs,
})
export type KnowledgeView = z.infer<typeof KnowledgeView>

export const LibraryUsesInput = z.object({ projectId: ProjectId, revision })
export type LibraryUsesInput = z.input<typeof LibraryUsesInput>

export const LibraryUsesResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  uses: z.array(
    z.object({
      id: ObjectId,
      library: ProjectId,
      label: z.string(),
      role: z.string(),
      revision: z.int().min(0),
      present: z.boolean(),
      libraryName: z.string().optional(),
      headRevision: z.int().min(0).optional(),
      /** How many revisions the library has moved on since the one used. */
      behind: z.int().min(0).optional(),
    }),
  ),
})
export type LibraryUsesResult = z.infer<typeof LibraryUsesResult>

export const AssessmentSummary = z.object({
  id: ObjectId,
  item: z.object({ library: ProjectId, id: z.string(), name: z.string() }),
  scenario: ObjectId,
  element: ObjectId.optional(),
  nature: ParameterNature,
  verdict: Verdict,
  specification: z.enum(['sufficient', 'underspecified']),
  conflict: z.enum(['none', 'unsettled', 'settled']),
  freshness: AssessmentFreshness,
  readAs: ReadAs,
})

export const ListAssessmentsInput = z.object({ projectId: ProjectId, revision })
export const ListAssessmentsResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  assessments: z.array(AssessmentSummary),
})
export type ListAssessmentsResult = z.infer<typeof ListAssessmentsResult>

export const GetAssessmentInput = z.object({ projectId: ProjectId, id: ObjectId, revision })

export const PinnedKnowledgeInput = z.object({
  projectId: ProjectId,
  /** One pin; default: every pin of the project. */
  evidence: z
    .string()
    .regex(/^evd_[0-9a-f]{32}$/)
    .optional(),
  revision,
})

/**
 * A pinned version as the project embeds it (ADR 0032): the exact canonical content and the
 * evidence records it cites, from the project's own copies. Never read from the library, so it
 * never shows a later revision or anything the project did not pin.
 */
export const PinnedKnowledge = z.object({
  evidence: z.string(),
  library: ProjectId,
  target: z.enum(['object', 'relation']),
  id: z.string(),
  revision: z.int().min(0),
  versionSha256: z.string(),
  state: z.enum(['embedded', 'notEmbedded', 'hashMismatch']),
  content: z.unknown().optional(),
  cites: z.array(
    z.object({ evidence: z.string(), evidenceSha256: z.string(), source: z.unknown().optional() }),
  ),
})
export const PinnedKnowledgeResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  pins: z.array(PinnedKnowledge),
})
export type PinnedKnowledgeResult = z.infer<typeof PinnedKnowledgeResult>
export const AssessmentView = AssessmentSummary.extend({
  explanation: Explanation,
  inputs: z.unknown(),
})
export type AssessmentView = z.infer<typeof AssessmentView>
