import { z } from 'zod'
import { Principal } from './auth.ts'
import { KalythEvent } from './events.ts'
import { ContentId, EvidenceId, PrincipalId, ProjectId } from './ids.ts'
import { ProjectSummary } from './queries.ts'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

/** A content body the project's evidence refers to; redacted bodies travel as null. */
export const ExportedContent = z.object({
  id: ContentId,
  sha256,
  mediaType: z.string(),
  body: z.string().nullable(),
  redactedAt: z.iso.datetime().nullable(),
  redactionReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type ExportedContent = z.infer<typeof ExportedContent>

/**
 * One pinned version a project carries (ADR 0027 §6): the pin, its hash, and the evidence records
 * the version cites, each embedded in `content` under its own hash. Attribution travels with it.
 */
export const ExportedPin = z.object({
  evidence: EvidenceId,
  library: ProjectId,
  target: z.enum(['object', 'relation']),
  id: z.string(),
  revision: z.int().min(0),
  versionSha256: sha256,
  cites: z.array(z.object({ evidence: EvidenceId, evidenceSha256: sha256 })),
})
export type ExportedPin = z.infer<typeof ExportedPin>

/**
 * A whole project as one file (ADR 0014): its event log, which rebuilds every revision (R3), the
 * content bodies its evidence refers to, and the principals named in its history. `stateSha256`
 * is the hash of the revisioned state the events must rebuild; an import that does not reproduce
 * it is refused. The bundle is not signed: import only bundles you trust.
 */
export const ProjectExport = z.object({
  format: z.literal('kalyth.project-export'),
  /** 2 adds `knowledge` (ADR 0027 §6). Format 1 still imports; its projects have no pins. */
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.iso.datetime(),
  exportedBy: PrincipalId,
  source: z.object({ contractsVersion: z.string(), schemaVersion: z.int().min(1) }),
  project: ProjectSummary,
  principals: z.array(Principal),
  events: z.array(KalythEvent),
  content: z.array(ExportedContent),
  knowledge: z.array(ExportedPin).default([]),
  stateSha256: sha256,
})
export type ProjectExport = z.infer<typeof ProjectExport>

export const ExportProjectInput = z.object({ projectId: ProjectId })
export type ExportProjectInput = z.input<typeof ExportProjectInput>

export const ImportSummary = z.object({
  projectId: ProjectId,
  name: z.string(),
  headRevision: z.int().min(0),
  events: z.int().min(0),
  content: z.int().min(0),
  principalsAdded: z.int().min(0),
  stateSha256: sha256,
})
export type ImportSummary = z.infer<typeof ImportSummary>
