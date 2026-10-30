import type {
  Claim,
  ClaimInput,
  ContentRef,
  Issue,
  JsonValue,
  OperationParsed,
  ResolvedOperation,
} from '@kalyth/contracts'
import { idKindOf, isLocalRef } from '@kalyth/contracts'
import type { z } from 'zod'
import type { IdGenerator } from '../util.ts'
import { supportGroupKey } from './support.ts'

type ParsedClaim = z.output<typeof ClaimInput>

export interface ContentSink {
  /** Stores an excerpt in the redactable content store and returns its reference. */
  putExcerpt(text: string): ContentRef
}

type RefKind = 'object' | 'relation' | 'evidence'

export interface ResolveContext {
  /** The proposer: the reviewer or verifier a curation operation records (ADR 0030 A4). */
  actor: string
  /** Attributes of a type that hold an object id, which a local ref may name. */
  referenceAttributes?: (type: string) => readonly string[]
}

/**
 * Turns submitted operations into resolved ones: assigns ids to created records, replaces local
 * refs with ids, and moves evidence excerpts into the content store. Only references are kept
 * in the proposal and, later, in events (R3). A created record keeps its own ref beside its id,
 * so the commit can say which id each ref became.
 */
export function resolveOperations(
  ops: readonly OperationParsed[],
  ids: IdGenerator,
  content: ContentSink,
  collectedAt: string,
  context: ResolveContext,
): { ops: ResolvedOperation[]; issues: Issue[] } {
  const issues: Issue[] = []
  const refs = new Map<string, { id: string; kind: RefKind }>()

  ops.forEach((op, index) => {
    if (!('ref' in op) || op.ref === undefined) return
    if (refs.has(op.ref)) {
      issues.push({ code: 'ref.duplicate', message: `${op.ref} is defined twice`, op: index })
      return
    }
    const kind: RefKind =
      op.op === 'createObject' ? 'object' : op.op === 'createRelation' ? 'relation' : 'evidence'
    refs.set(op.ref, { id: ids(kind), kind })
  })

  const resolve = (value: string, allowed: RefKind[], index: number, path: string[]): string => {
    if (!isLocalRef(value)) {
      const kind = idKindOf(value)
      if (!kind || !(allowed as string[]).includes(kind))
        issues.push({
          code: 'ref.kind_mismatch',
          message: `${value} is not a ${allowed.join(' or ')} id`,
          op: index,
          path,
        })
      return value
    }
    const target = refs.get(value)
    if (!target) {
      issues.push({
        code: 'ref.unknown',
        message: `${value} is not defined in this proposal`,
        op: index,
        path,
      })
      return value
    }
    if (!allowed.includes(target.kind)) {
      issues.push({
        code: 'ref.kind_mismatch',
        message: `${value} refers to a ${target.kind}`,
        op: index,
        path,
      })
    }
    return target.id
  }

  const resolveClaim = (c: ParsedClaim, index: number): Claim => {
    return {
      basis: c.basis,
      ...(c.confidence ? { confidence: c.confidence } : {}),
      ...(c.observation ? { observation: c.observation } : {}),
      ...(c.method ? { method: c.method } : {}),
      ...(c.model ? { model: c.model } : {}),
      supports: c.supports.map((g, gi) => ({
        allOf: g.allOf.map((e, ei) =>
          resolve(e, ['evidence'], index, ['claim', 'supports', String(gi), String(ei)]),
        ),
      })),
      contradictedBy: c.contradictedBy.map((e, ei) =>
        resolve(e, ['evidence'], index, ['claim', 'contradictedBy', String(ei)]),
      ),
      derivedFrom: c.derivedFrom.map((d, di) =>
        resolve(d, ['object', 'relation'], index, ['claim', 'derivedFrom', String(di)]),
      ),
    }
  }

  const resolveReferences = (
    type: string,
    attributes: Record<string, JsonValue>,
    index: number,
  ): Record<string, JsonValue> => {
    const out = { ...attributes }
    for (const key of context.referenceAttributes?.(type) ?? []) {
      const value = out[key]
      if (typeof value === 'string')
        out[key] = resolve(value, ['object'], index, ['attributes', key])
    }
    return out
  }

  const resolved = ops.map((op, index): ResolvedOperation => {
    const newId = (kind: RefKind) =>
      ('ref' in op && op.ref ? refs.get(op.ref)?.id : undefined) ?? ids(kind)
    const keptRef = 'ref' in op && op.ref ? { ref: op.ref } : {}
    switch (op.op) {
      case 'createObject':
        return {
          op: 'createObject',
          id: newId('object'),
          ...keptRef,
          type: op.type,
          stance: op.stance,
          attributes: resolveReferences(op.type, op.attributes, index),
          claim: resolveClaim(op.claim, index),
        }
      case 'updateObject':
        return {
          op: 'updateObject',
          id: op.id,
          set: op.set,
          ...(op.claim ? { claim: resolveClaim(op.claim, index) } : {}),
        }
      case 'updateRelation':
        return {
          op: 'updateRelation',
          id: op.id,
          set: op.set,
          ...(op.claim ? { claim: resolveClaim(op.claim, index) } : {}),
        }
      case 'retireObject':
      case 'retireRelation':
      case 'setDecisionStatus':
        return op
      case 'setTaskStatus':
        return { ...op, lease: op.lease ?? null }
      case 'setMaturity':
        return { ...op, id: resolve(op.id, ['object'], index, ['id']) }
      case 'reviewSupport': {
        const group =
          typeof op.group === 'string'
            ? op.group
            : supportGroupKey(
                op.group.allOf.map((e, ei) =>
                  resolve(e, ['evidence'], index, ['group', 'allOf', String(ei)]),
                ),
              )
        return {
          op: 'reviewSupport',
          target: resolve(op.target, ['object', 'relation'], index, ['target']),
          group,
          review: {
            verdict: op.verdict,
            reviewer: context.actor,
            reviewedAt: collectedAt,
            note: op.note,
            ...(op.scopeLimit ? { scopeLimit: op.scopeLimit } : {}),
          },
        }
      }
      case 'verifySource':
        return {
          op: 'verifySource',
          evidence: resolve(op.evidence, ['evidence'], index, ['evidence']),
          verification: {
            status: op.status,
            method: op.method,
            by: context.actor,
            at: collectedAt,
            ...(op.retrievedSha256 ? { retrievedSha256: op.retrievedSha256 } : {}),
            ...(op.licence ? { licence: op.licence } : {}),
            note: op.note,
          },
          // Without targets, the claims citing the evidence are found when the proposal is
          // applied, and recorded in it (ADR 0030 A1).
          targets: (op.targets ?? []).map((t, ti) =>
            resolve(t, ['object', 'relation'], index, ['targets', String(ti)]),
          ),
          allCiting: op.targets === undefined,
        }
      case 'createRelation':
        return {
          op: 'createRelation',
          id: newId('relation'),
          ...keptRef,
          type: op.type,
          from: resolve(op.from, ['object'], index, ['from']),
          to: resolve(op.to, ['object'], index, ['to']),
          stance: op.stance,
          properties: op.properties,
          claim: resolveClaim(op.claim, index),
        }
      case 'recordEvidence':
        return {
          op: 'recordEvidence',
          id: newId('evidence'),
          ...keptRef,
          source: op.evidence.source,
          excerpt:
            op.evidence.excerpt === undefined ? null : content.putExcerpt(op.evidence.excerpt),
          collectedBy: op.evidence.collectedBy,
          collectedAt,
        }
      default:
        return assertNever(op)
    }
  })
  return { ops: resolved, issues }
}

/** The id each local ref resolved to, for the commit result. */
export function localRefsOf(ops: readonly ResolvedOperation[]): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const op of ops) {
    if (
      (op.op === 'createObject' || op.op === 'createRelation' || op.op === 'recordEvidence') &&
      op.ref
    )
      refs[op.ref] = op.id
  }
  return refs
}

/** Ids a proposal modifies. Overlap with changes since its base makes it stale. */
export function writeSetOf(ops: readonly ResolvedOperation[]): string[] {
  const ids = new Set<string>()
  for (const op of ops) {
    if (
      op.op === 'updateObject' ||
      op.op === 'retireObject' ||
      op.op === 'updateRelation' ||
      op.op === 'retireRelation' ||
      op.op === 'setDecisionStatus' ||
      op.op === 'setTaskStatus' ||
      op.op === 'setMaturity'
    )
      ids.add(op.id)
    // Curation writes the claims it names, so a change to them after the base is a conflict (A1).
    if (op.op === 'reviewSupport') ids.add(op.target)
    if (op.op === 'verifySource') for (const t of op.targets) ids.add(t)
  }
  return [...ids]
}

/** Existing ids a proposal relies on without modifying them, plus any it declared explicitly. */
export function readSetOf(
  ops: readonly ResolvedOperation[],
  explicit: readonly string[],
  isExisting: (id: string) => boolean,
): string[] {
  const ids = new Set<string>(explicit)
  for (const op of ops) {
    if (op.op === 'createRelation') {
      ids.add(op.from)
      ids.add(op.to)
    }
    if ('claim' in op && op.claim) for (const d of op.claim.derivedFrom) ids.add(d)
  }
  return [...ids].filter(isExisting).sort()
}

function assertNever(value: never): never {
  throw new Error(`unhandled operation ${JSON.stringify(value)}`)
}
