import type {
  ClaimInput,
  EvidenceRecord,
  JsonValue,
  ObjectVersion,
  OperationInput,
  RelationVersion,
} from '@kalyth/contracts'
import { canonicalJson } from '@kalyth/contracts'
import type { AnalysisResult } from './analyze.ts'
import { ANALYZER, type EvidenceSpan } from './facts.ts'

export interface ExistingState {
  objects: readonly ObjectVersion[]
  relations: readonly RelationVersion[]
  evidence: ReadonlyMap<string, EvidenceRecord>
}

export interface PlanStats {
  created: number
  refreshed: number
  unchanged: number
  notReobserved: number
  evidence: number
}

const ANALYZER_TYPES = new Set([
  'core.SourceSnapshot',
  'software.System',
  'software.Container',
  'software.Module',
  'software.Endpoint',
  'software.DataEntity',
  'software.Library',
])

/** Natural key of an analyzer-managed object, from its attributes. */
export function objectKey(o: Pick<ObjectVersion, 'type' | 'attributes'>): string | undefined {
  const a = o.attributes as Record<string, string>
  switch (o.type) {
    case 'core.SourceSnapshot':
      return `snapshot:${a.repo}`
    case 'software.System':
      return 'system'
    case 'software.Container':
      return `container:${a.name}`
    case 'software.Module':
      return `module:${a.path}`
    case 'software.Endpoint':
      return `endpoint:${a.method} ${a.path}${a.scope ? `@${a.scope}` : ''}`
    case 'software.DataEntity':
      return `entity:${a.name}${a.scope ? `@${a.scope}` : ''}`
    case 'software.Library':
      return `library:${a.ecosystem}:${a.name}`
    default:
      return undefined
  }
}

const spanKey = (e: EvidenceRecord) =>
  e.source.kind === 'sourceSpan'
    ? `${e.source.path}:${e.source.span.startLine}-${e.source.span.endLine}@${e.source.blobSha}`
    : undefined

/**
 * Turns an analysis into kernel operations against the existing state: new facts are created,
 * re-observed facts whose evidence or attributes changed get a refreshed observed claim, and facts
 * no longer observed are left untouched so they surface as stale for review instead of being
 * silently retired. Only records previously observed by this analyzer are matched.
 */
export function planIngest(
  analysis: AnalysisResult,
  existing: ExistingState,
): { ops: OperationInput[]; stats: PlanStats } {
  const stats: PlanStats = { created: 0, refreshed: 0, unchanged: 0, notReobserved: 0, evidence: 0 }
  const isOurs = (claim: ObjectVersion['claim']) => claim.observation?.tool === ANALYZER.tool

  const objectsByKey = new Map<string, ObjectVersion>()
  for (const o of existing.objects) {
    const key = ANALYZER_TYPES.has(o.type) && isOurs(o.claim) ? objectKey(o) : undefined
    if (key && o.lifecycle === 'active') objectsByKey.set(key, o)
  }
  const keyById = new Map([...objectsByKey].map(([k, o]) => [o.id, k]))
  const relationsByKey = new Map<string, RelationVersion>()
  for (const r of existing.relations) {
    const from = keyById.get(r.from)
    const to = keyById.get(r.to)
    if (from && to && r.lifecycle === 'active' && isOurs(r.claim))
      relationsByKey.set(`${r.type}|${from}|${to}`, r)
  }
  const existingEvidence = new Map<string, string>()
  for (const [id, e] of existing.evidence) {
    const k = spanKey(e)
    if (k) existingEvidence.set(k, id)
  }

  // Evidence is recorded lazily: only for facts that are created or refreshed.
  const evidenceOps: OperationInput[] = []
  const evidenceRefs = new Map<string, string>()
  const evidenceRef = (span: EvidenceSpan): string => {
    const reused = existingEvidence.get(span.key)
    if (reused) return reused
    let ref = evidenceRefs.get(span.key)
    if (!ref) {
      ref = `$e${evidenceRefs.size}`
      evidenceRefs.set(span.key, ref)
      evidenceOps.push({
        op: 'recordEvidence',
        ref,
        evidence: {
          source: {
            kind: 'sourceSpan',
            repo: analysis.repo,
            commit: analysis.commit,
            path: span.path,
            blobSha: span.blobSha,
            span: { startLine: span.startLine, endLine: span.endLine },
            spanSha256: span.spanSha256,
            ...(span.symbol ? { symbol: span.symbol } : {}),
          },
          ...(span.excerpt !== undefined ? { excerpt: span.excerpt } : {}),
          collectedBy: ANALYZER,
        },
      })
    }
    return ref
  }
  const observation = {
    ...ANALYZER,
    coverage: analysis.coverage.slice(0, 2000),
    ...(analysis.limitations.length > 0
      ? { limitations: analysis.limitations.join('; ').slice(0, 2000) }
      : {}),
  }
  const supportSignature = (groups: EvidenceSpan[][]) =>
    canonicalJson(groups.map((g) => g.map((s) => s.key).sort()).sort())
  const existingSignature = (claim: ObjectVersion['claim']) =>
    canonicalJson(
      claim.supports
        .map((g) =>
          g.allOf
            .map((id) => {
              const e = existing.evidence.get(id)
              return (e && spanKey(e)) ?? id
            })
            .sort(),
        )
        .sort(),
    )
  const claimFor = (groups: EvidenceSpan[][]): ClaimInput => ({
    basis: 'observed',
    observation,
    supports: groups.map((g) => ({ allOf: g.map(evidenceRef) })),
  })

  const factOps: OperationInput[] = []
  const targets = new Map<string, string>()
  analysis.objects.forEach((fact, i) => {
    const current = objectsByKey.get(fact.key)
    if (!current) {
      const ref = `$o${i}`
      targets.set(fact.key, ref)
      factOps.push({
        op: 'createObject',
        ref,
        type: fact.type,
        stance: 'asIs',
        attributes: fact.attributes,
        claim: claimFor(fact.supports),
      })
      stats.created++
      return
    }
    targets.set(fact.key, current.id)
    const set: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(fact.attributes))
      if (canonicalJson(current.attributes[k]) !== canonicalJson(v)) set[k] = v
    for (const k of Object.keys(current.attributes)) if (!(k in fact.attributes)) set[k] = null
    const evidenceChanged = supportSignature(fact.supports) !== existingSignature(current.claim)
    if (Object.keys(set).length === 0 && !evidenceChanged) {
      stats.unchanged++
      return
    }
    factOps.push({ op: 'updateObject', id: current.id, set, claim: claimFor(fact.supports) })
    stats.refreshed++
  })

  analysis.relations.forEach((fact, i) => {
    const from = targets.get(fact.from)
    const to = targets.get(fact.to)
    if (!from || !to) return
    const current = relationsByKey.get(fact.key)
    if (!current) {
      factOps.push({
        op: 'createRelation',
        ref: `$r${i}`,
        type: fact.type,
        from,
        to,
        stance: 'asIs',
        claim: claimFor(fact.supports),
      })
      stats.created++
    } else if (supportSignature(fact.supports) !== existingSignature(current.claim)) {
      factOps.push({
        op: 'updateRelation',
        id: current.id,
        set: {},
        claim: claimFor(fact.supports),
      })
      stats.refreshed++
    } else stats.unchanged++
  })

  const observedKeys = new Set([
    ...analysis.objects.map((o) => o.key),
    ...analysis.relations.map((r) => r.key),
  ])
  for (const key of [...objectsByKey.keys(), ...relationsByKey.keys()]) {
    if (!key.startsWith('snapshot:') && !observedKeys.has(key)) stats.notReobserved++
  }

  // The snapshot records which source revision the project now reflects.
  const snapshotAttributes = {
    repo: analysis.repo,
    commit: analysis.commit,
    ...(analysis.ref ? { ref: analysis.ref } : {}),
    coverage: analysis.coverage.slice(0, 4000),
    files: analysis.files,
  }
  const snapshotEvidence: OperationInput = {
    op: 'recordEvidence',
    ref: '$snapshot',
    evidence: {
      source: {
        kind: 'document',
        uri: `git:${analysis.repo}@${analysis.commit}`,
        version: analysis.commit,
      },
      collectedBy: ANALYZER,
    },
  }
  const snapshotClaim: ClaimInput = {
    basis: 'observed',
    observation,
    supports: [{ allOf: ['$snapshot'] }],
  }
  const currentSnapshot = objectsByKey.get(`snapshot:${analysis.repo}`)
  const snapshotOps: OperationInput[] = []
  if (!currentSnapshot) {
    snapshotOps.push(snapshotEvidence, {
      op: 'createObject',
      type: 'core.SourceSnapshot',
      stance: 'asIs',
      attributes: snapshotAttributes,
      claim: snapshotClaim,
    })
  } else if (canonicalJson(currentSnapshot.attributes) !== canonicalJson(snapshotAttributes)) {
    const set: Record<string, JsonValue> = { ...snapshotAttributes }
    if (!analysis.ref && 'ref' in currentSnapshot.attributes) set.ref = null
    snapshotOps.push(snapshotEvidence, {
      op: 'updateObject',
      id: currentSnapshot.id,
      set,
      claim: snapshotClaim,
    })
  }

  stats.evidence = evidenceOps.length
  const all = [...evidenceOps, ...factOps]
  return { ops: all.length + snapshotOps.length > 0 ? [...all, ...snapshotOps] : [], stats }
}
