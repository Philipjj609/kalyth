import { z } from 'zod'

/**
 * Identifiers are a type prefix plus a 32-hex-digit UUIDv7 body (time-ordered, no dashes).
 * They are stable across revisions and never reused.
 */
export const ID_PREFIX = {
  project: 'prj',
  object: 'obj',
  relation: 'rel',
  evidence: 'evd',
  content: 'cnt',
  proposal: 'prp',
  changeSet: 'chg',
  event: 'evt',
  principal: 'pcp',
  grant: 'grt',
  navigatorRun: 'nav',
  contextPackage: 'ctx',
  agentToken: 'tok',
  methodRun: 'run',
} as const

export type IdKind = keyof typeof ID_PREFIX

const idSchema = (kind: IdKind) =>
  z.string().regex(new RegExp(`^${ID_PREFIX[kind]}_[0-9a-f]{32}$`), `expected a ${kind} id`)

export const ProjectId = idSchema('project')
export const ObjectId = idSchema('object')
export const RelationId = idSchema('relation')
export const EvidenceId = idSchema('evidence')
export const ContentId = idSchema('content')
export const ProposalId = idSchema('proposal')
export const ChangeSetId = idSchema('changeSet')
export const EventId = idSchema('event')
export const PrincipalId = idSchema('principal')
export const GrantId = idSchema('grant')
export const NavigatorRunId = idSchema('navigatorRun')
/** Content-addressed: the first 32 hex digits of the package's SHA-256 (ADR 0011). */
export const ContextPackageId = idSchema('contextPackage')
export const AgentTokenId = idSchema('agentToken')
export const MethodRunId = idSchema('methodRun')

/** Claims are carried by objects and relations, so a claim id is either. */
export const ClaimId = z.union([ObjectId, RelationId])

/**
 * A proposal-local reference such as "$api". It lets one proposal create an object and
 * relate to it before ids are assigned. References are resolved to ids when the proposal is stored.
 */
export const LocalRef = z
  .string()
  .regex(/^\$[A-Za-z][\w-]{0,63}$/, 'expected a local ref like $name')

export const ObjectTarget = z.union([ObjectId, LocalRef])
export const EvidenceTarget = z.union([EvidenceId, LocalRef])
export const ClaimTarget = z.union([ObjectId, RelationId, LocalRef])

export function idKindOf(id: string): IdKind | undefined {
  const prefix = id.slice(0, 3)
  for (const [kind, p] of Object.entries(ID_PREFIX)) {
    if (p === prefix && id[3] === '_') return kind as IdKind
  }
  return undefined
}

export const isLocalRef = (value: string): boolean => value.startsWith('$')
