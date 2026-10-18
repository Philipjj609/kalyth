import { z } from 'zod'
import { Scope } from './auth.ts'
import {
  ChangeSetId,
  EventId,
  EvidenceId,
  LocalRef,
  ObjectId,
  ProjectId,
  RelationId,
} from './ids.ts'

export const ErrorCode = z.enum([
  'invalid',
  'unauthenticated',
  'unauthorized',
  'stale',
  'conflicting',
  'not_found',
  'budget_exceeded',
  'retryable',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const Issue = z.object({
  code: z.string(),
  message: z.string(),
  /** Index of the operation in the proposal, when the issue concerns one. */
  op: z.int().min(0).optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
})
export type Issue = z.infer<typeof Issue>

/**
 * The single error envelope used by services, HTTP and MCP (ADR 0004).
 * - invalid: fails schema, type or relation rules on its own
 * - unauthorized / unauthenticated: the caller lacks authority; nothing changes
 * - stale: state the proposal relied on changed since its base revision; re-read and re-propose
 * - conflicting: valid alone but violates a cross-object invariant at the current head (R1)
 */
export const KernelError = z.object({
  code: ErrorCode,
  message: z.string(),
  issues: z.array(Issue).default([]),
  requiredScopes: z.array(Scope).optional(),
  currentRevision: z.int().min(0).optional(),
  changedRefs: z.array(z.string()).optional(),
  retryAfterMs: z.int().min(0).optional(),
})
export type KernelError = z.output<typeof KernelError>

export const CommitSuccess = z.object({
  status: z.literal('committed'),
  projectId: ProjectId,
  revision: z.int().min(1),
  changeSetId: ChangeSetId,
  eventId: EventId,
  /** The proposal's base revision when it was applied on a newer head (automatic rebase). */
  rebasedFrom: z.int().min(0).nullable(),
  /**
   * The id each local ref in the proposal resolved to, e.g. `{"$task": "obj_…"}`. Empty when the
   * proposal named no refs, and for proposals committed before refs were kept.
   */
  refs: z.record(LocalRef, z.union([ObjectId, RelationId, EvidenceId])),
})
export type CommitSuccess = z.infer<typeof CommitSuccess>

export type Result<T> = { ok: true; value: T } | { ok: false; error: KernelError }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T = never>(
  code: ErrorCode,
  message: string,
  extra: Partial<Omit<KernelError, 'code' | 'message'>> = {},
): Result<T> => ({ ok: false, error: { code, message, issues: [], ...extra } })

/** HTTP status for each error code. */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid: 422,
  unauthenticated: 401,
  unauthorized: 403,
  stale: 409,
  conflicting: 409,
  not_found: 404,
  budget_exceeded: 429,
  retryable: 503,
}
