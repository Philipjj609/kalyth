import type {
  AgentTokenSummary,
  CommitSuccess,
  CompileContextInput,
  ContextPackageResult,
  DecisionsResult,
  EvidenceQueryResult,
  EvidenceView,
  HistoryResult,
  ImpactResult,
  Issue,
  IssueAgentTokenInput,
  IssuedAgentToken,
  NavigatorRun,
  NavigatorStatus,
  ObjectQueryResult,
  ObjectTypeDescriptor,
  ProjectOverview,
  ProjectSummary,
  Proposal,
  ProposeChangeInput,
  ProposeChangeOutput,
  RelationQueryResult,
  RelationTypeDescriptor,
  StartNavigatorRunInput,
} from '@kalyth/contracts'
import { type FreshnessReport, parseFreshness } from './freshness.ts'
import type { Situation } from './situation.ts'

/**
 * The API error envelope, {error: {code, message, issues, changedRefs?, currentRevision?, ...}}.
 * Mirrors KernelError from @kalyth/contracts, but codes are kept open-ended so a code added on the
 * server still renders.
 */
export interface ApiErrorBody {
  code: string
  message: string
  issues: Issue[]
  changedRefs?: string[]
  currentRevision?: number
  requiredScopes?: string[]
  retryAfterMs?: number
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError

const FALLBACK_CODES: Record<number, string> = {
  401: 'unauthenticated',
  403: 'unauthorized',
  404: 'not_found',
  409: 'conflicting',
  422: 'invalid',
  429: 'budget_exceeded',
  503: 'retryable',
}

/** Reads the error envelope defensively; anything unexpected becomes a generic error. */
export function toApiErrorBody(status: number, payload: unknown): ApiErrorBody {
  const error =
    typeof payload === 'object' && payload !== null && 'error' in payload
      ? (payload as { error: unknown }).error
      : undefined
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>
    const body: ApiErrorBody = {
      code: typeof e.code === 'string' ? e.code : (FALLBACK_CODES[status] ?? 'error'),
      message: typeof e.message === 'string' ? e.message : `Request failed (HTTP ${status})`,
      issues: Array.isArray(e.issues)
        ? e.issues.filter(
            (i): i is Issue =>
              typeof i === 'object' &&
              i !== null &&
              typeof (i as Issue).code === 'string' &&
              typeof (i as Issue).message === 'string',
          )
        : [],
    }
    if (Array.isArray(e.changedRefs)) {
      body.changedRefs = e.changedRefs.filter((r): r is string => typeof r === 'string')
    }
    if (typeof e.currentRevision === 'number') body.currentRevision = e.currentRevision
    if (Array.isArray(e.requiredScopes)) {
      body.requiredScopes = e.requiredScopes.filter((s): s is string => typeof s === 'string')
    }
    if (typeof e.retryAfterMs === 'number') body.retryAfterMs = e.retryAfterMs
    return body
  }
  return {
    code: FALLBACK_CODES[status] ?? 'error',
    message: `Request failed (HTTP ${status})`,
    issues: [],
  }
}

type QueryValue = string | number | boolean | undefined | readonly string[]

export function buildUrl(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','))
    } else {
      params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Body of POST /navigator/runs: a run input without the project id, which is in the path. */
export type StartRunBody = DistributiveOmit<StartNavigatorRunInput, 'projectId'>

/** Body of POST /projects/:id/proposals: the project id is in the path. */
export type ProposeBody = Omit<ProposeChangeInput, 'projectId'>

/**
 * Body of POST /projects/:id/context (ADR 0011). The project is in the path and packages are
 * always compiled at the head, so neither is sent.
 */
export type CompileContextBody = Omit<CompileContextInput, 'projectId' | 'revision'>

/** Body of POST /projects/:id/agent-tokens. */
export type IssueAgentTokenBody = Omit<IssueAgentTokenInput, 'projectId'>

export type DecisionStatusFilter = 'open' | 'accepted' | 'rejected' | 'deferred' | 'superseded'

export interface ImpactParams {
  seeds: readonly string[]
  maxDepth?: number
  maxNodes?: number
  /** A past revision; undefined uses the head. */
  revision?: number | undefined
}

/** Impact traversal URL. Seeds go as repeated `seed` parameters, de-duplicated. */
export function impactUrl(projectId: string, params: ImpactParams): string {
  const q = new URLSearchParams()
  for (const seed of new Set(params.seeds)) q.append('seed', seed)
  if (params.maxDepth !== undefined) q.set('maxDepth', String(params.maxDepth))
  if (params.maxNodes !== undefined) q.set('maxNodes', String(params.maxNodes))
  if (params.revision !== undefined) q.set('revision', String(params.revision))
  return `/api/v1/projects/${encodeURIComponent(projectId)}/impact?${q.toString()}`
}

export interface TypeDescriptors {
  objectTypes: ObjectTypeDescriptor[]
  relationTypes: RelationTypeDescriptor[]
}

/** Largest page the API serves; the UI reads whole revisions up to this size. */
export const PAGE_LIMIT = 1000
const EVIDENCE_BATCH = 200

const enc = encodeURIComponent

export function createApi(getToken: () => string | null, fetchImpl?: FetchLike) {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init))

  /** `passStatuses`: error statuses whose body is returned instead of thrown. */
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: Record<string, unknown>,
    passStatuses: readonly number[] = [],
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await doFetch(url, {
        method,
        headers,
        credentials: 'omit',
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new ApiError(0, {
        code: 'retryable',
        message: 'Cannot reach the Kalyth server. Is it running?',
        issues: [],
      })
    }
    const text = await res.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }
    const isEnvelope = typeof payload === 'object' && payload !== null && 'error' in payload
    if (!res.ok && (isEnvelope || !passStatuses.includes(res.status))) {
      throw new ApiError(res.status, toApiErrorBody(res.status, payload))
    }
    return payload as T
  }

  const project = (projectId: string) => `/api/v1/projects/${enc(projectId)}`

  return {
    health: () => request<{ status: string; schemaVersion: number }>('GET', '/api/v1/health'),
    types: () => request<TypeDescriptors>('GET', '/api/v1/types'),
    listProjects: () => request<{ projects: ProjectSummary[] }>('GET', '/api/v1/projects'),
    overview: (projectId: string, revision?: number) =>
      request<ProjectOverview>('GET', buildUrl(project(projectId), { revision })),
    objects: (projectId: string, revision: number, includeRetired = false) =>
      request<ObjectQueryResult>(
        'GET',
        buildUrl(`${project(projectId)}/objects`, {
          revision,
          limit: PAGE_LIMIT,
          includeRetired: includeRetired || undefined,
        }),
      ),
    relations: (projectId: string, revision: number, includeRetired = false) =>
      request<RelationQueryResult>(
        'GET',
        buildUrl(`${project(projectId)}/relations`, {
          revision,
          limit: PAGE_LIMIT,
          includeRetired: includeRetired || undefined,
        }),
      ),
    evidence: async (projectId: string, ids: readonly string[]): Promise<EvidenceView[]> => {
      const unique = [...new Set(ids)]
      const out: EvidenceView[] = []
      for (let i = 0; i < unique.length; i += EVIDENCE_BATCH) {
        const batch = unique.slice(i, i + EVIDENCE_BATCH)
        const res = await request<EvidenceQueryResult>(
          'GET',
          buildUrl(`${project(projectId)}/evidence`, { id: batch }),
        )
        out.push(...res.evidence)
      }
      return out
    },
    history: (projectId: string) =>
      request<HistoryResult>(
        'GET',
        buildUrl(`${project(projectId)}/history`, { limit: PAGE_LIMIT }),
      ),
    proposals: (projectId: string) =>
      request<{ proposals: Proposal[] }>(
        'GET',
        buildUrl(`${project(projectId)}/proposals`, { limit: PAGE_LIMIT }),
      ),
    commit: (proposalId: string) =>
      request<CommitSuccess>('POST', `/api/v1/proposals/${enc(proposalId)}/commit`),
    reject: (proposalId: string, reason: string) =>
      request<Proposal>('POST', `/api/v1/proposals/${enc(proposalId)}/reject`, { reason }),
    /** Freshness report, or null while the server does not provide one (404). */
    freshness: async (projectId: string, revision: number): Promise<FreshnessReport | null> => {
      try {
        const body = await request<unknown>(
          'GET',
          buildUrl(`${project(projectId)}/freshness`, { revision }),
        )
        return parseFreshness(body)
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 501)) return null
        throw e
      }
    },
    proposal: (proposalId: string) =>
      request<Proposal>('GET', `/api/v1/proposals/${enc(proposalId)}`),
    /**
     * Proposes a change for review. A proposal that fails validation is still stored and answered
     * with 422 and the proposal (status "invalid" with its issues), not the error envelope; that
     * body is returned so the caller sees the issues.
     */
    propose: (projectId: string, input: ProposeBody) =>
      request<ProposeChangeOutput>('POST', `${project(projectId)}/proposals`, { ...input }, [422]),
    /** What needs attention, or null while the server has no situation route (404). */
    situation: async (projectId: string): Promise<Situation | null> => {
      try {
        return await request<Situation>('GET', `${project(projectId)}/situation`)
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 501)) return null
        throw e
      }
    },

    // ---------- Navigator (ADR 0010) ----------

    /** Provider, models, budget and consent, or null while the server has no Navigator (404). */
    navigatorStatus: async (projectId: string): Promise<NavigatorStatus | null> => {
      try {
        return await request<NavigatorStatus>('GET', `${project(projectId)}/navigator`)
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 501)) return null
        throw e
      }
    },
    setNavigatorConsent: (projectId: string, granted: boolean) =>
      request<NavigatorStatus>('PUT', `${project(projectId)}/navigator/consent`, { granted }),
    /** Answers 202 with the run, which may still be running or already final. */
    startNavigatorRun: (projectId: string, input: StartRunBody) =>
      request<NavigatorRun>('POST', `${project(projectId)}/navigator/runs`, { ...input }),
    navigatorRuns: (projectId: string, limit = 50) =>
      request<{ runs: NavigatorRun[] }>(
        'GET',
        buildUrl(`${project(projectId)}/navigator/runs`, { limit }),
      ),
    navigatorRun: (runId: string) =>
      request<NavigatorRun>('GET', `/api/v1/navigator/runs/${enc(runId)}`),
    impact: (projectId: string, params: ImpactParams) =>
      request<ImpactResult>('GET', impactUrl(projectId, params)),

    // ---------- handoff to agents (ADR 0011) ----------

    /** Decisions with alternatives and direct changes, or null while the route is missing (404). */
    decisions: async (
      projectId: string,
      status?: DecisionStatusFilter,
    ): Promise<DecisionsResult | null> => {
      try {
        return await request<DecisionsResult>(
          'GET',
          buildUrl(`${project(projectId)}/decisions`, { status }),
        )
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 501)) return null
        throw e
      }
    },
    /** Compiles a context package at the head; answers 201, also when the package is blocked. */
    compileContext: (projectId: string, input: CompileContextBody) =>
      request<ContextPackageResult>('POST', `${project(projectId)}/context`, { ...input }),
    contextPackage: (packageId: string) =>
      request<ContextPackageResult>('GET', `/api/v1/context/${enc(packageId)}`),
    /** Agent token summaries (never the secrets), or null while the route is missing (404). */
    agentTokens: async (projectId: string): Promise<{ tokens: AgentTokenSummary[] } | null> => {
      try {
        return await request<{ tokens: AgentTokenSummary[] }>(
          'GET',
          `${project(projectId)}/agent-tokens`,
        )
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 501)) return null
        throw e
      }
    },
    /** The only response that carries the token secret; the server keeps its hash. */
    issueAgentToken: (projectId: string, input: IssueAgentTokenBody) =>
      request<IssuedAgentToken>('POST', `${project(projectId)}/agent-tokens`, { ...input }),
    revokeAgentToken: (tokenId: string) =>
      request<AgentTokenSummary>('POST', `/api/v1/agent-tokens/${enc(tokenId)}/revoke`),
  }
}

export type Api = ReturnType<typeof createApi>
