import { z } from 'zod'
import { GrantId, PrincipalId, ProjectId } from './ids.ts'

export const PrincipalKind = z.enum(['human', 'agent', 'model', 'tool'])
export type PrincipalKind = z.infer<typeof PrincipalKind>

/**
 * Who originated the instruction behind a request (instruction provenance, KAL-004).
 * Only "human" means a person acted directly in a first-party interface. Text computed by a
 * model or plan, or relayed from external content, never carries a person's authority.
 */
export const InstructionOrigin = z.enum(['human', 'agent', 'model', 'tool', 'relayed'])
export type InstructionOrigin = z.infer<typeof InstructionOrigin>

export const Scope = z.enum([
  'project.read',
  'project.create',
  'proposal.create',
  'proposal.commit',
  'proposal.reject',
  'decision.decide',
  'ingest.observed',
  'grant.manage',
  /** Claim, renew, release and report on tasks (ADR 0013). */
  'task.work',
  /** The task coordinator's narrow commit right for task lifecycle records (ADR 0013). */
  'task.coordinate',
])
export type Scope = z.infer<typeof Scope>

/** Scopes that version 1 grants only to human principals (ADR 0006, decision D4). */
export const HUMAN_ONLY_SCOPES: readonly Scope[] = ['decision.decide', 'grant.manage']

export const Principal = z.object({
  id: PrincipalId,
  kind: PrincipalKind,
  displayName: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
})
export type Principal = z.infer<typeof Principal>

/** Who a principal id stands for, so screens can name who did what instead of showing ids. */
export const PrincipalName = Principal.pick({ id: true, kind: true, displayName: true }).extend({
  /** The principal making the request. */
  you: z.boolean(),
})
export type PrincipalName = z.infer<typeof PrincipalName>

export const PrincipalNames = z.object({ principals: z.array(PrincipalName) })
export type PrincipalNames = z.infer<typeof PrincipalNames>

export const Grant = z.object({
  id: GrantId,
  principalId: PrincipalId,
  /** null means every project. */
  projectId: ProjectId.nullable(),
  scopes: z.array(Scope).min(1),
  expiresAt: z.iso.datetime().nullable(),
  grantedBy: PrincipalId.nullable(),
  createdAt: z.iso.datetime(),
})
export type Grant = z.infer<typeof Grant>

/** The authenticated caller of a service operation. */
export const Caller = z.object({
  principalId: PrincipalId,
  origin: InstructionOrigin,
})
export type Caller = z.infer<typeof Caller>
