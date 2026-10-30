import type { EvidenceSource, ResolvedOperation } from '@kalyth/contracts'
import { shortId, shortSha, typeParts } from './format.ts'
import { objectLabel } from './labels.ts'

/** A readable line for one proposal operation. */
export interface OpDescription {
  verb: string
  subject: string
  detail?: string
  basis?: string
  /** Ids the line refers to, so the UI can link them. */
  refs: string[]
}

export type NameOf = (id: string) => string | undefined

/** Where a piece of evidence points, as short display strings. */
export function evidenceLocation(source: EvidenceSource): { primary: string; secondary: string } {
  switch (source.kind) {
    case 'sourceSpan': {
      const { startLine, endLine } = source.span
      const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
      return {
        primary: `${source.path}:${lines}`,
        secondary: `${source.repo} @ ${shortSha(source.commit)}`,
      }
    }
    case 'document':
      return {
        primary: source.locator ? `${source.uri} (${source.locator})` : source.uri,
        secondary: source.version ? `version ${source.version}` : 'document',
      }
    case 'external':
      return { primary: source.uri, secondary: `retrieved ${source.retrievedAt.slice(0, 10)}` }
    case 'statement':
      return { primary: `Statement by ${shortId(source.statedBy)}`, secondary: 'statement' }
    case 'knowledge':
      return {
        primary: `Knowledge ${shortId(source.id)} @ revision ${source.revision}`,
        secondary: `pinned from library ${shortId(source.library)}`,
      }
  }
}

function render(value: unknown): string {
  if (value === null) return 'removed'
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/**
 * Describes resolved operations. Names come from the proposal itself (objects it creates) first,
 * then from `nameOf` (the current model), then the short id.
 */
export function describeOps(ops: readonly ResolvedOperation[], nameOf: NameOf): OpDescription[] {
  const local = new Map<string, string>()
  for (const op of ops) if (op.op === 'createObject') local.set(op.id, objectLabel(op))
  const name = (id: string) => local.get(id) ?? nameOf(id) ?? shortId(id)

  return ops.map((op): OpDescription => {
    switch (op.op) {
      case 'createObject':
        return withOptional({
          verb: 'Create',
          subject: `${typeParts(op.type).name} “${name(op.id)}”`,
          basis: op.claim.basis,
          detail: op.stance === 'toBe' ? 'to-be (intended)' : undefined,
          refs: [op.id],
        })
      case 'updateObject': {
        const keys = Object.entries(op.set).map(([k, v]) => `${k} → ${render(v)}`)
        return withOptional({
          verb: 'Update',
          subject: name(op.id),
          detail: keys.join(', ') || undefined,
          basis: op.claim?.basis,
          refs: [op.id],
        })
      }
      case 'retireObject':
        return { verb: 'Retire', subject: name(op.id), detail: op.reason, refs: [op.id] }
      case 'createRelation':
        return {
          verb: 'Relate',
          subject: `${name(op.from)} —${op.type}→ ${name(op.to)}`,
          basis: op.claim.basis,
          refs: [op.from, op.to],
        }
      case 'updateRelation': {
        const keys = Object.entries(op.set).map(([k, v]) => `${k} → ${render(v)}`)
        return withOptional({
          verb: 'Update relation',
          subject: name(op.id),
          detail: keys.join(', ') || (op.claim ? 'refreshed evidence' : undefined),
          basis: op.claim?.basis,
          refs: [op.id],
        })
      }
      case 'retireRelation':
        return { verb: 'Retire relation', subject: name(op.id), detail: op.reason, refs: [op.id] }
      case 'recordEvidence': {
        const where = evidenceLocation(op.source)
        return {
          verb: 'Record evidence',
          subject: where.primary,
          detail: where.secondary,
          refs: [],
        }
      }
      case 'setDecisionStatus':
        return {
          verb: 'Set status',
          subject: name(op.id),
          detail: `→ ${op.status}: ${op.rationale}`,
          refs: [op.id],
        }
      case 'setTaskStatus':
        return {
          verb: 'Set task status',
          subject: name(op.id),
          detail: `→ ${op.status}: ${op.rationale}`,
          refs: [op.id],
        }
      // Curation of a knowledge library (ADR 0030); libraries have no views of their own yet.
      case 'setMaturity':
        return {
          verb: 'Set maturity',
          subject: name(op.id),
          detail: `→ ${op.maturity}: ${op.reason}`,
          refs: [op.id],
        }
      case 'reviewSupport':
        return {
          verb: 'Review support',
          subject: name(op.target),
          detail: `${op.review.verdict}: ${op.review.note}`,
          refs: [op.target],
        }
      case 'verifySource':
        return {
          verb: 'Verify source',
          subject: shortId(op.evidence),
          detail: `${op.verification.status} in ${op.targets.length} claim(s): ${op.verification.note}`,
          refs: [...op.targets],
        }
      default:
        return unknownOp(op)
    }
  })
}

/** An operation kind this UI does not know yet (a newer server): shown, not dropped. */
function unknownOp(op: never): OpDescription {
  const kind = (op as { op?: unknown }).op
  return { verb: typeof kind === 'string' ? kind : 'Unknown operation', subject: '', refs: [] }
}

function withOptional(d: {
  verb: string
  subject: string
  detail: string | undefined
  basis: string | undefined
  refs: string[]
}): OpDescription {
  const out: OpDescription = { verb: d.verb, subject: d.subject, refs: d.refs }
  if (d.detail !== undefined) out.detail = d.detail
  if (d.basis !== undefined) out.basis = d.basis
  return out
}

/** Counts per operation kind, in a stable order, e.g. [["createObject", 3], ["recordEvidence", 2]]. */
export function opCounts(ops: readonly ResolvedOperation[]): [string, number][] {
  const order = [
    'createObject',
    'updateObject',
    'retireObject',
    'createRelation',
    'retireRelation',
    'recordEvidence',
    'setDecisionStatus',
    'setTaskStatus',
  ]
  const counts = new Map<string, number>()
  for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1)
  return order.filter((k) => counts.has(k)).map((k) => [k, counts.get(k) as number])
}

export const OP_LABEL: Record<string, string> = {
  createObject: 'create',
  updateObject: 'update',
  retireObject: 'retire',
  createRelation: 'relate',
  retireRelation: 'retire relation',
  recordEvidence: 'evidence',
  setDecisionStatus: 'decision status',
  setTaskStatus: 'task status',
}
