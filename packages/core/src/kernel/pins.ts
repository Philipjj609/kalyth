import type { EvidenceSource, PinResolution } from '@kalyth/contracts'
import type { SqliteStore } from '../store/sqlite-store.ts'
import { sha256Hex } from '../util.ts'
import { canonicalV1, type KnowledgeVersion, knowledgeVersion, NotCanonical } from './canonical.ts'

export type PinSource = Extract<EvidenceSource, { kind: 'knowledge' }>

/** Embedded content is keyed like every content record: by its hash (ADR 0030 C8). */
export const contentIdOf = (sha256: string): string => `cnt_${sha256.slice(0, 32)}`

export const KNOWLEDGE_MEDIA_TYPE = 'application/vnd.kalyth.knowledge+json; version=1'
export const EVIDENCE_MEDIA_TYPE = 'application/vnd.kalyth.evidence+json; version=1'

export type VersionLookup =
  | ({ ok: true } & KnowledgeVersion)
  | { ok: false; reason: 'unknown-library' | 'unknown-revision' | 'unknown-target'; detail: string }

/**
 * One item of a library at a revision, in canonical form v1, from the local store: the logical
 * kernel's only resolver in K2 (ADR 0027 §1, "local"). History is kept, so any revision up to the
 * library's head resolves to what the item was then.
 */
export function versionAt(
  store: SqliteStore,
  pin: Pick<PinSource, 'library' | 'target' | 'id' | 'revision'>,
): VersionLookup {
  const library = store.getProject(pin.library)
  if (library?.kind !== 'library')
    return { ok: false, reason: 'unknown-library', detail: `${pin.library} is not a library here` }
  if (pin.revision > library.headRevision)
    return {
      ok: false,
      reason: 'unknown-revision',
      detail: `${pin.library} is at revision ${library.headRevision}, not ${pin.revision}`,
    }
  const view = store.view(pin.library, pin.revision)
  const record = pin.target === 'object' ? view.getObject(pin.id) : view.getRelation(pin.id)
  if (record?.lifecycle !== 'active')
    return {
      ok: false,
      reason: 'unknown-target',
      detail: `${pin.id} is not an active ${pin.target} of ${pin.library} at revision ${pin.revision}`,
    }
  try {
    return { ok: true, ...knowledgeVersion(record, (id) => view.getEvidence(id)) }
  } catch (error) {
    if (error instanceof NotCanonical)
      return { ok: false, reason: 'unknown-target', detail: error.message }
    throw error
  }
}

/**
 * Resolves a pin (ADR 0027 §1, §5a): the project's embedded copy first, then the local library at
 * the pinned revision. Every step checks the hash; a copy whose hash differs is reported as
 * corruption and never used, and no other version is ever substituted (I2, I7).
 */
export function resolvePin(store: SqliteStore, projectId: string, pin: PinSource): PinResolution {
  const sha = pin.versionSha256 ?? ''
  const embedded = store.getContent(projectId, contentIdOf(sha))
  if (embedded?.body !== null && embedded?.body !== undefined) {
    const found = sha256Hex(embedded.body)
    if (found !== sha)
      return {
        state: 'unresolved',
        reason: 'hash-mismatch',
        detail: `embedded copy hashes to ${found}, the pin to ${sha}`,
      }
    return { state: 'resolved', from: 'embedded', content: JSON.parse(embedded.body) }
  }
  const version = versionAt(store, pin)
  if (!version.ok) return { state: 'unresolved', reason: version.reason, detail: version.detail }
  if (version.sha256 !== sha)
    return {
      state: 'unresolved',
      reason: 'hash-mismatch',
      detail: `the library's version hashes to ${version.sha256}, the pin to ${sha}`,
    }
  return { state: 'resolved', from: 'library', content: JSON.parse(version.text) }
}

/** Canonical text of an evidence record, as embedded beside the version that cites it. */
export const evidenceText = (source: EvidenceSource): string => canonicalV1(source)
