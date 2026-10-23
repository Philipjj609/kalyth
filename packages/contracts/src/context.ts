import { z } from 'zod'
import { Scope } from './auth.ts'
import { Basis, Confidence, Stance } from './claims.ts'
import {
  AgentTokenId,
  ContextPackageId,
  ObjectId,
  PrincipalId,
  ProjectId,
  RelationId,
} from './ids.ts'
import { JsonRecord } from './json.ts'
import { ImpactStep } from './navigator.ts'
import { FreshnessStatus } from './queries.ts'

const revision = z.int().min(0).optional()

// ---------- context packages (ADR 0011) ----------

export const ContextTask = z.object({
  title: z.string().trim().min(1).max(300),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
})
export type ContextTask = z.input<typeof ContextTask>

export const CompileContextInput = z.object({
  projectId: ProjectId,
  revision,
  /** Elements, decisions or alternatives the task is about. */
  focus: z.array(ObjectId).min(1).max(50),
  task: ContextTask.optional(),
  /** Size limit for the whole package, in characters of canonical JSON. */
  maxChars: z.int().min(4000).max(400_000).default(60_000),
})
export type CompileContextInput = z.input<typeof CompileContextInput>

export const ContextRole = z.enum([
  'focus',
  'invariant',
  'constraint',
  'decision',
  'alternative',
  'directChange',
  'impacted',
  'dependency',
  'question',
])

export const ContextEvidence = z.object({
  id: z.string(),
  /** path:lines @ short commit, or a document locator. */
  location: z.string(),
  /** The pinned excerpt, null when redacted or not included. */
  excerpt: z.string().nullable(),
})
export type ContextEvidence = z.infer<typeof ContextEvidence>

export const ContextItem = z.object({
  id: z.union([ObjectId, RelationId]),
  kind: z.enum(['object', 'relation']),
  type: z.string(),
  label: z.string(),
  role: ContextRole,
  /** Typed distance from the focus; 0 for focus and mandatory items. */
  distance: z.int().min(0),
  stance: Stance,
  basis: Basis,
  confidence: Confidence.nullable(),
  freshness: FreshnessStatus,
  attributes: JsonRecord,
  /** For relations: endpoints and properties. */
  from: ObjectId.nullable(),
  to: ObjectId.nullable(),
  /** For impacted elements: how a change reaches them. */
  path: z.array(ImpactStep),
  evidence: z.array(ContextEvidence),
})
export type ContextItem = z.infer<typeof ContextItem>

export const ContextOmission = z.object({
  reason: z.enum(['size_limit', 'traversal_limit']),
  /** How many were left out; 0 when a traversal stopped at its limit without counting further. */
  count: z.int().min(0),
  /** The first omitted ids, nearest first. */
  ids: z.array(z.string()),
})
export type ContextOmission = z.infer<typeof ContextOmission>

export const RetrievalHint = z.object({
  tool: z.string(),
  arguments: JsonRecord,
  purpose: z.string(),
})
export type RetrievalHint = z.infer<typeof RetrievalHint>

/** The content-addressed part of a package: identical input at one revision gives identical bytes. */
export const ContextPackageBody = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  snapshots: z.array(
    z.object({
      repo: z.string(),
      commit: z.string(),
      /** Present when an analysis of a newer commit stopped part way: the model is incomplete. */
      pending: z.object({ commit: z.string(), parts: z.int() }).optional(),
    }),
  ),
  focus: z.array(ObjectId),
  task: z.object({ title: z.string(), acceptanceCriteria: z.array(z.string()) }).nullable(),
  status: z.enum(['ready', 'blocked']),
  blocked: z
    .object({
      code: z.literal('context_overflow'),
      mandatoryChars: z.int(),
      maxChars: z.int(),
      /** Focus split by container; compile each group as its own package. */
      splits: z.array(z.array(ObjectId)),
    })
    .nullable(),
  mandatory: z.object({
    invariants: z.array(ContextItem),
    constraints: z.array(ContextItem),
    decisions: z.array(ContextItem),
    acceptanceCriteria: z.array(z.string()),
    policy: z.array(z.string()),
  }),
  items: z.array(ContextItem),
  omissions: z.array(ContextOmission),
  retrieval: z.array(RetrievalHint),
  size: z.object({ chars: z.int(), maxChars: z.int(), mandatoryChars: z.int() }),
})
export type ContextPackageBody = z.infer<typeof ContextPackageBody>

export const ContextPackage = ContextPackageBody.extend({
  id: ContextPackageId,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type ContextPackage = z.infer<typeof ContextPackage>

/**
 * The package checked against the project's head when it is read (ADR 0023). The package itself
 * never changes; this says what moved since it was compiled.
 */
export const ContextPackageCurrent = z.object({
  headRevision: z.int().min(0),
  headMoved: z.boolean(),
  /** Items that need review at the head although the package recorded them as current. */
  stale: z.array(
    z.object({
      id: z.union([ObjectId, RelationId]),
      label: z.string(),
      compiled: FreshnessStatus,
      now: FreshnessStatus,
      reason: z.string(),
    }),
  ),
  /** Items that are no longer active in the model at the head. */
  removed: z.array(z.object({ id: z.union([ObjectId, RelationId]), label: z.string() })),
  /** What to do about it, in a sentence; null when nothing moved. */
  warning: z.string().nullable(),
})
export type ContextPackageCurrent = z.infer<typeof ContextPackageCurrent>

/** A package as returned to a caller, with that caller's own scopes beside it. */
export const ContextPackageResult = z.object({
  package: ContextPackage,
  uri: z.string(),
  callerScopes: z.array(Scope),
  current: ContextPackageCurrent,
})
export type ContextPackageResult = z.infer<typeof ContextPackageResult>

export const ContextPackageQuery = z.object({ packageId: ContextPackageId })

export const ContextPackageListQuery = z.object({
  projectId: ProjectId,
  limit: z.int().min(1).max(200).default(50),
})

/** A compiled package, as listed for a project: newest first. */
export const ContextPackageSummary = z.object({
  id: ContextPackageId,
  revision: z.int().min(0),
  status: z.enum(['ready', 'blocked']),
  focus: z.array(ObjectId),
  taskTitle: z.string().nullable(),
  items: z.int().min(0),
  chars: z.int().min(0),
  firstCompiledAt: z.iso.datetime(),
})
export type ContextPackageSummary = z.infer<typeof ContextPackageSummary>

export const ContextPackageList = z.object({ packages: z.array(ContextPackageSummary) })
export type ContextPackageList = z.infer<typeof ContextPackageList>

// ---------- decisions read model ----------

export const DecisionsQuery = z.object({
  projectId: ProjectId,
  revision,
  status: z.enum(['open', 'accepted', 'rejected', 'deferred', 'superseded']).optional(),
})

/**
 * Where a decision stands besides its acceptance (`status`), each facet on its own and computed
 * on read (ADR 0023): whether the evidence its changes rest on still matches the source, how far
 * the tasks that implement it got, and what git confirmed about their reports. A facet may be
 * partial; none implies another.
 */
export const DecisionFacets = z.object({
  freshness: z.object({
    /** `unchecked` when none of the changes cite evidence that can go stale. */
    status: z.enum(['current', 'stale', 'unchecked']),
    /** Direct changes considered: the accepted alternative's, or every alternative's while open. */
    changes: z.int().min(0),
    stale: z.array(
      z.object({
        relationId: RelationId,
        target: ObjectId,
        label: z.string(),
        status: FreshnessStatus,
        reason: z.string(),
      }),
    ),
  }),
  implementation: z.object({
    state: z.enum(['none', 'planned', 'in-progress', 'reported', 'partial', 'complete']),
    tasks: z.array(z.object({ id: ObjectId, title: z.string(), status: z.string() })),
    /**
     * How many of the `changes` considered (as for freshness) the verified reports touched: a file
     * the change target's evidence cites is among the files changed of a task's latest report
     * that passed verification (ADR 0024). Optional for readers of earlier results.
     */
    touched: z.int().min(0).optional(),
    changes: z.int().min(0).optional(),
  }),
  verification: z.object({
    state: z.enum(['none', 'failed', 'partial', 'passed']),
    /** What the latest passing verification checked, in the verifier's own words. */
    coverage: z.string().nullable(),
  }),
})
export type DecisionFacets = z.infer<typeof DecisionFacets>

export const DecisionSummary = z.object({
  id: ObjectId,
  title: z.string(),
  question: z.string(),
  status: z.string(),
  statusRationale: z.string().nullable(),
  basis: Basis,
  alternatives: z.array(
    z.object({
      id: ObjectId,
      title: z.string(),
      summary: z.string(),
      status: z.string(),
      directChanges: z.array(
        z.object({
          relationId: RelationId,
          target: ObjectId,
          label: z.string(),
          change: z.string(),
        }),
      ),
    }),
  ),
  /** Elements the decision determines directly (`decides`). */
  decides: z.array(z.object({ id: ObjectId, label: z.string() })),
  facets: DecisionFacets,
})
export type DecisionSummary = z.infer<typeof DecisionSummary>

export const DecisionsResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  decisions: z.array(DecisionSummary),
})
export type DecisionsResult = z.infer<typeof DecisionsResult>

// ---------- agent tokens (ADR 0011) ----------

export const IssueAgentTokenInput = z.object({
  projectId: ProjectId,
  label: z.string().trim().min(1).max(120),
  expiresInDays: z.int().min(1).max(30).default(7),
})
export type IssueAgentTokenInput = z.input<typeof IssueAgentTokenInput>

export const AgentTokenSummary = z.object({
  id: AgentTokenId,
  projectId: ProjectId,
  principalId: PrincipalId,
  label: z.string(),
  scopes: z.array(Scope),
  createdBy: PrincipalId,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
})
export type AgentTokenSummary = z.infer<typeof AgentTokenSummary>

/** The secret appears only here, once. Kalyth stores its SHA-256. */
export const IssuedAgentToken = z.object({
  token: z.string().regex(/^kalyth_at_[A-Za-z0-9_-]{43}$/),
  summary: AgentTokenSummary,
})
export type IssuedAgentToken = z.infer<typeof IssuedAgentToken>

export const AgentTokenListQuery = z.object({ projectId: ProjectId })
export const RevokeAgentTokenInput = z.object({ tokenId: AgentTokenId })
