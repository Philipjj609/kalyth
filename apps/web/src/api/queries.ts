import type {
  AgentTokenSummary,
  ContextPackageResult,
  NavigatorRun,
  NavigatorStatus,
  ObjectVersion,
  RelationVersion,
  TaskRepositoryView,
} from '@kalyth/contracts'
import {
  QueryCache,
  QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { session } from '../app/session.ts'
import { objectLabel } from '../model/labels.ts'
import { RUN_POLL_MS, runRefetchInterval } from '../model/navigator.ts'
import {
  type Api,
  type ApiError,
  type CompileContextBody,
  createApi,
  isApiError,
  type StartRunBody,
} from './client.ts'
import {
  type AcceptAlternativeInput,
  type AcceptAlternativeOutcome,
  acceptAlternative,
  type ProposeCommitOutcome,
  proposeAndCommit,
} from './decide.ts'
import type { DemoView } from './demo.ts'
import { freshnessIndex } from './freshness.ts'
import {
  type ChangeTaskStatusInput,
  type CreateTaskInput,
  type CreateTaskOutcome,
  changeTaskStatus,
  createTask,
} from './tasks.ts'

export const api = createApi(() => session.token())

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isApiError(error) && error.status === 401) session.reject()
      },
    }),
    defaultOptions: {
      queries: {
        retry: (count, error) =>
          isApiError(error) && (error.status === 0 || error.status >= 500) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 5_000,
      },
    },
  })
}

export const keys = {
  projects: ['projects'] as const,
  types: ['types'] as const,
  overview: (projectId: string, revision: number | undefined) =>
    ['overview', projectId, revision ?? 'head'] as const,
  objects: (projectId: string, revision: number, retired: boolean) =>
    ['objects', projectId, revision, retired] as const,
  relations: (projectId: string, revision: number, retired: boolean) =>
    ['relations', projectId, revision, retired] as const,
  freshness: (projectId: string, revision: number) => ['freshness', projectId, revision] as const,
  evidence: (projectId: string, ids: string) => ['evidence', projectId, ids] as const,
  history: (projectId: string) => ['history', projectId] as const,
  proposals: (projectId: string) => ['proposals', projectId] as const,
  proposal: (proposalId: string) => ['proposal', proposalId] as const,
  situation: (projectId: string) => ['situation', projectId] as const,
  navigatorStatus: (projectId: string) => ['navigator', 'status', projectId] as const,
  navigatorRuns: (projectId: string) => ['navigator', 'runs', projectId] as const,
  navigatorRun: (runId: string) => ['navigator', 'run', runId] as const,
  impact: (projectId: string, revision: number | 'head', seeds: string) =>
    ['impact', projectId, revision, seeds] as const,
  decisions: (projectId: string, status: string) => ['decisions', projectId, status] as const,
  contextPackage: (packageId: string) => ['context', packageId] as const,
  contextPackages: (projectId: string) => ['contextPackages', projectId] as const,
  agentTokens: (projectId: string) => ['agentTokens', projectId] as const,
  tasks: (projectId: string) => ['tasks', projectId] as const,
  task: (taskId: string) => ['task', taskId] as const,
  taskRepository: (projectId: string) => ['taskRepository', projectId] as const,
  demo: ['demo', 'session'] as const,
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects, refetchInterval: 30_000 })
}

/** A new, empty project; a person names it and may describe the idea behind it. */
export function useCreateProject() {
  const client = useQueryClient()
  return useMutation<
    Awaited<ReturnType<typeof api.createProject>>,
    ApiError,
    { name: string; description: string }
  >({
    mutationFn: (input) => api.createProject(input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

export function useTypes() {
  return useQuery({ queryKey: keys.types, queryFn: api.types, staleTime: Number.POSITIVE_INFINITY })
}

/** The overview at a revision; undefined follows the head and polls for new revisions. */
export function useOverview(projectId: string | undefined, revision: number | undefined) {
  return useQuery({
    queryKey: keys.overview(projectId ?? '', revision),
    queryFn: () => api.overview(projectId as string, revision),
    enabled: projectId !== undefined,
    refetchInterval: revision === undefined ? 15_000 : false,
    staleTime: revision === undefined ? 5_000 : Number.POSITIVE_INFINITY,
  })
}

export interface RevisionModel {
  objects: ObjectVersion[]
  relations: RelationVersion[]
  objectById: Map<string, ObjectVersion>
  relationById: Map<string, RelationVersion>
  nameOf: (id: string) => string | undefined
  /** True when a list hit the page limit, so the view may be incomplete. */
  truncated: boolean
}

/**
 * Objects and relations at one revision. Revisions are immutable, so these are cached for good;
 * the head moves by changing the revision, never by refetching.
 */
export function useRevisionModel(
  projectId: string | undefined,
  revision: number | undefined,
  includeRetired = false,
) {
  const enabled = projectId !== undefined && revision !== undefined
  const objects = useQuery({
    queryKey: keys.objects(projectId ?? '', revision ?? -1, includeRetired),
    queryFn: () => api.objects(projectId as string, revision as number, includeRetired),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const relations = useQuery({
    queryKey: keys.relations(projectId ?? '', revision ?? -1, includeRetired),
    queryFn: () => api.relations(projectId as string, revision as number, includeRetired),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const model = useMemo((): RevisionModel | undefined => {
    if (!objects.data || !relations.data) return undefined
    const objectById = new Map(objects.data.objects.map((o) => [o.id, o]))
    const relationById = new Map(relations.data.relations.map((r) => [r.id, r]))
    const names = new Map(objects.data.objects.map((o) => [o.id, objectLabel(o)]))
    return {
      objects: objects.data.objects,
      relations: relations.data.relations,
      objectById,
      relationById,
      nameOf: (id) => {
        const name = names.get(id)
        if (name !== undefined) return name
        const r = relationById.get(id)
        return r
          ? `${names.get(r.from) ?? r.from} —${r.type}→ ${names.get(r.to) ?? r.to}`
          : undefined
      },
      truncated: objects.data.truncated || relations.data.truncated,
    }
  }, [objects.data, relations.data])
  return {
    model,
    isLoading: objects.isLoading || relations.isLoading,
    error: objects.error ?? relations.error,
  }
}

/** Freshness at a revision, or null when the server has no freshness endpoint yet. */
export function useFreshness(projectId: string | undefined, revision: number | undefined) {
  const query = useQuery({
    queryKey: keys.freshness(projectId ?? '', revision ?? -1),
    queryFn: () => api.freshness(projectId as string, revision as number),
    enabled: projectId !== undefined && revision !== undefined,
    staleTime: 60_000,
    retry: false,
  })
  const index = useMemo(() => freshnessIndex(query.data), [query.data])
  return { report: query.data ?? null, index, available: Boolean(query.data) }
}

export function useEvidence(projectId: string | undefined, ids: readonly string[]) {
  const key = [...new Set(ids)].sort().join(',')
  return useQuery({
    queryKey: keys.evidence(projectId ?? '', key),
    queryFn: () => api.evidence(projectId as string, key ? key.split(',') : []),
    enabled: projectId !== undefined && key !== '',
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useHistory(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.history(projectId ?? ''),
    queryFn: () => api.history(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: 30_000,
  })
}

export function useProposals(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.proposals(projectId ?? ''),
    queryFn: () => api.proposals(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: 15_000,
  })
}

function useInvalidateProject(projectId: string) {
  const client = useQueryClient()
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['overview', projectId] }),
      client.invalidateQueries({ queryKey: keys.proposals(projectId) }),
      client.invalidateQueries({ queryKey: keys.history(projectId) }),
      client.invalidateQueries({ queryKey: keys.projects }),
      client.invalidateQueries({ queryKey: ['proposal'] }),
      client.invalidateQueries({ queryKey: keys.situation(projectId) }),
      // Any commit may create or move tasks, wherever it was made.
      client.invalidateQueries({ queryKey: keys.tasks(projectId) }),
      client.invalidateQueries({ queryKey: ['task'] }),
      client.invalidateQueries({ queryKey: ['decisions', projectId] }),
    ])
}

export function useCommitProposal(projectId: string) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation<Awaited<ReturnType<typeof api.commit>>, ApiError, string>({
    mutationFn: (proposalId) => api.commit(proposalId),
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

export function useRejectProposal(projectId: string) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation<
    Awaited<ReturnType<typeof api.reject>>,
    ApiError,
    { proposalId: string; reason: string }
  >({
    mutationFn: ({ proposalId, reason }) => api.reject(proposalId, reason),
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

// ---------- Navigator (ADR 0010) ----------

/** Provider, models, budget and consent; null while the server has no Navigator (404). */
export function useNavigatorStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.navigatorStatus(projectId ?? ''),
    queryFn: () => api.navigatorStatus(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: 30_000,
  })
}

/** Refreshes what a finished run changed: spend and reservations, runs and the new proposal. */
function refreshAfterRun(client: QueryClient, projectId: string, runs = true) {
  return Promise.all([
    client.invalidateQueries({ queryKey: keys.demo }),
    client.invalidateQueries({ queryKey: keys.navigatorStatus(projectId) }),
    runs ? client.invalidateQueries({ queryKey: keys.navigatorRuns(projectId) }) : undefined,
    client.invalidateQueries({ queryKey: keys.proposals(projectId) }),
    client.invalidateQueries({ queryKey: ['overview', projectId] }),
    client.invalidateQueries({ queryKey: keys.situation(projectId) }),
  ])
}

const runningIds = (runs: readonly NavigatorRun[] | undefined) =>
  (runs ?? []).filter((r) => r.status === 'running').map((r) => r.id)

/** Recent runs, newest first. Polls while any run is in flight, wherever it was started. */
export function useNavigatorRuns(projectId: string | undefined, enabled = true) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: keys.navigatorRuns(projectId ?? ''),
    queryFn: () => api.navigatorRuns(projectId as string, 50),
    enabled: enabled && projectId !== undefined,
    refetchInterval: (q) => (runningIds(q.state.data?.runs).length > 0 ? RUN_POLL_MS * 2 : 30_000),
  })
  const running = runningIds(query.data?.runs).join(',')
  const previous = useRef(running)
  useEffect(() => {
    const before = previous.current.split(',').filter(Boolean)
    previous.current = running
    const now = running.split(',')
    if (projectId === undefined || !before.some((id) => !now.includes(id))) return
    // A run settled: keep its own cache in step and refresh what it changed.
    for (const run of query.data?.runs ?? []) {
      if (before.includes(run.id)) client.setQueryData(keys.navigatorRun(run.id), run)
    }
    void refreshAfterRun(client, projectId, false)
  }, [client, projectId, running, query.data])
  return query
}

/**
 * One run. While its status is "running" it is refetched about once a second
 * (`runRefetchInterval`); a final run never changes, so it is then cached for good.
 */
export function navigatorRunOptions(source: Pick<Api, 'navigatorRun'>, runId: string) {
  return queryOptions({
    queryKey: keys.navigatorRun(runId),
    queryFn: () => source.navigatorRun(runId),
    refetchInterval: (query) => runRefetchInterval(query.state.data),
    staleTime: (query) => (query.state.data?.status === 'running' ? 0 : Number.POSITIVE_INFINITY),
  })
}

export function useNavigatorRun(projectId: string, runId: string | undefined) {
  const client = useQueryClient()
  const query = useQuery({
    ...navigatorRunOptions(api, runId ?? ''),
    enabled: runId !== undefined,
  })
  const status = query.data?.status
  const previous = useRef<{ runId: string | undefined; status: string | undefined }>({
    runId,
    status,
  })
  useEffect(() => {
    const before = previous.current
    previous.current = { runId, status }
    if (before.runId === runId && before.status === 'running' && status && status !== 'running') {
      void refreshAfterRun(client, projectId)
    }
  }, [client, projectId, runId, status])
  return query
}

export function useStartNavigatorRun(projectId: string) {
  const client = useQueryClient()
  return useMutation<NavigatorRun, ApiError, StartRunBody>({
    mutationFn: (input) => api.startNavigatorRun(projectId, input),
    onSuccess: (run) => {
      client.setQueryData(keys.navigatorRun(run.id), run)
      client.setQueryData<{ runs: NavigatorRun[] }>(keys.navigatorRuns(projectId), (prev) =>
        prev ? { runs: [run, ...prev.runs.filter((r) => r.id !== run.id)] } : prev,
      )
      void refreshAfterRun(client, projectId)
    },
    onError: (error) => {
      if (error.status === 401) session.reject()
      // A refusal (budget, consent) can reflect a status this tab has not seen yet.
      void client.invalidateQueries({ queryKey: keys.navigatorStatus(projectId) })
    },
  })
}

export function useSetNavigatorConsent(projectId: string) {
  const client = useQueryClient()
  return useMutation<NavigatorStatus, ApiError, boolean>({
    mutationFn: (granted) => api.setNavigatorConsent(projectId, granted),
    onSuccess: (status) => client.setQueryData(keys.navigatorStatus(projectId), status),
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

/** One proposal. Its operations never change; its review status is refreshed while pending. */
export function useProposal(proposalId: string | null | undefined) {
  return useQuery({
    queryKey: keys.proposal(proposalId ?? ''),
    queryFn: () => api.proposal(proposalId as string),
    enabled: Boolean(proposalId),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 15_000 : false),
  })
}

/** Open decisions and questions, pending proposals and stale claims; null without the route. */
export function useSituation(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.situation(projectId ?? ''),
    queryFn: () => api.situation(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: 15_000,
  })
}

/** A person answers a question: the answer is proposed and committed at once (Journey 1). */
export function useAnswerQuestion(projectId: string) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation<
    ProposeCommitOutcome,
    ApiError,
    { questionId: string; answer: string; baseRevision: number }
  >({
    mutationFn: ({ questionId, answer, baseRevision }) =>
      proposeAndCommit(
        api,
        projectId,
        {
          baseRevision,
          rationale: `Answer: ${answer.slice(0, 300)}`,
          ops: [{ op: 'updateObject', id: questionId, set: { status: 'answered', answer } }],
        },
        'The answer',
      ),
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

/** Proposes the chosen alternative's setDecisionStatus operations, then commits them. */
export function useAcceptAlternative(projectId: string) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation<AcceptAlternativeOutcome, ApiError, AcceptAlternativeInput>({
    mutationFn: (input) => acceptAlternative(api, projectId, input),
    onSuccess: (outcome) => {
      if ('refused' in outcome && outcome.refused.status === 401) session.reject()
    },
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

export const IMPACT_LIMITS = { maxDepth: 4, maxNodes: 300 } as const
/** The contract accepts at most this many seeds per traversal. */
export const MAX_IMPACT_SEEDS = 50

/** Propagated impact from seed elements at a revision. Revisions are immutable, so cached. */
export function useImpact(
  projectId: string,
  seeds: readonly string[],
  revision: number,
  enabled: boolean,
) {
  const key = [...new Set(seeds)].sort().slice(0, MAX_IMPACT_SEEDS).join(',')
  return useQuery({
    queryKey: keys.impact(projectId, revision, key),
    queryFn: () => api.impact(projectId, { seeds: key.split(','), ...IMPACT_LIMITS, revision }),
    enabled: enabled && key !== '',
    staleTime: Number.POSITIVE_INFINITY,
  })
}

// ---------- handoff to agents (ADR 0011) ----------

/** Accepted decisions with their alternatives and direct changes; null without the route. */
/** Propagated impact from several seed sets at one revision, one traversal each, in order. */
export function useImpacts(
  projectId: string,
  seedSets: readonly (readonly string[])[],
  revision: number,
) {
  return useQueries({
    queries: seedSets.map((seeds) => {
      const key = [...new Set(seeds)].sort().slice(0, MAX_IMPACT_SEEDS).join(',')
      return {
        queryKey: keys.impact(projectId, revision, key),
        queryFn: () => api.impact(projectId, { seeds: key.split(','), ...IMPACT_LIMITS, revision }),
        enabled: key !== '',
        staleTime: Number.POSITIVE_INFINITY,
      }
    }),
  })
}

/** Every decision of the project at the head, whatever its status, or null without the route. */
export function useDecisions(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.decisions(projectId ?? '', 'all'),
    queryFn: () => api.decisions(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: 30_000,
  })
}

export function useAcceptedDecisions(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.decisions(projectId ?? '', 'accepted'),
    queryFn: () => api.decisions(projectId as string, 'accepted'),
    enabled: projectId !== undefined,
    refetchInterval: 30_000,
  })
}

/**
 * One context package. Its body is content-addressed and never changes, so it is cached for good;
 * only the caller's scopes beside it could, and those are informational.
 */
export function useContextPackage(packageId: string | undefined) {
  return useQuery({
    queryKey: keys.contextPackage(packageId ?? ''),
    queryFn: () => api.contextPackage(packageId as string),
    enabled: packageId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

/** Packages compiled for the project, newest first; null while the server has no list route. */
export function useContextPackages(projectId: string) {
  return useQuery({
    queryKey: keys.contextPackages(projectId),
    queryFn: () => api.contextPackages(projectId),
    staleTime: 30_000,
  })
}

/** Compiles a package at the head and caches it under its id, so opening it needs no request. */
export function useCompileContext(projectId: string) {
  const client = useQueryClient()
  return useMutation<ContextPackageResult, ApiError, CompileContextBody>({
    mutationFn: (input) => api.compileContext(projectId, input),
    onSuccess: (result) => {
      client.setQueryData(keys.contextPackage(result.package.id), result)
      void client.invalidateQueries({ queryKey: keys.contextPackages(projectId) })
    },
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

/**
 * Agent token summaries; null while the server has no token routes. Secrets never appear here.
 * The hosted demo has no agent access (ADR 0019), so nothing is asked for there.
 */
export function useAgentTokens(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.agentTokens(projectId ?? ''),
    queryFn: () => api.agentTokens(projectId as string),
    enabled: projectId !== undefined && session.mode() !== 'demo',
    refetchInterval: 60_000,
  })
}

/** Puts a token summary into the cached list, replacing an earlier copy of it. */
export function upsertTokenSummary(client: QueryClient, summary: AgentTokenSummary) {
  client.setQueryData<{ tokens: AgentTokenSummary[] } | null>(
    keys.agentTokens(summary.projectId),
    (prev) =>
      prev ? { tokens: [summary, ...prev.tokens.filter((t) => t.id !== summary.id)] } : prev,
  )
}

export function useRevokeAgentToken(projectId: string) {
  const client = useQueryClient()
  return useMutation<AgentTokenSummary, ApiError, string>({
    mutationFn: (tokenId) => api.revokeAgentToken(tokenId),
    onSuccess: (summary) => upsertTokenSummary(client, summary),
    onSettled: () => client.invalidateQueries({ queryKey: keys.agentTokens(projectId) }),
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

// ---------- tasks (ADR 0013) ----------

/**
 * The project's tasks at the head; null while the server has no task routes. Polled, since agents
 * claim and report over MCP and leases run out between a person's actions.
 */
export function useTasks(projectId: string) {
  return useQuery({
    queryKey: keys.tasks(projectId),
    queryFn: () => api.tasks(projectId),
    refetchInterval: 10_000,
  })
}

/** One task by id, for a deep link to a task the list does not hold. */
export function useTask(taskId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.task(taskId ?? ''),
    queryFn: () => api.task(taskId as string),
    enabled: enabled && taskId !== undefined,
    refetchInterval: 10_000,
    retry: false,
  })
}

/** The repository agents commit to; null while the server has no task routes. */
export function useTaskRepository(projectId: string) {
  return useQuery({
    queryKey: keys.taskRepository(projectId),
    queryFn: () => api.taskRepository(projectId),
    staleTime: 30_000,
  })
}

export function useSetTaskRepository(projectId: string) {
  const client = useQueryClient()
  return useMutation<TaskRepositoryView, ApiError, string>({
    mutationFn: (path) => api.setTaskRepository(projectId, path),
    onSuccess: (view) => client.setQueryData(keys.taskRepository(projectId), view),
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

/** Proposes and commits a person's status change (never to running: that is the coordinator's). */
export function useChangeTaskStatus(projectId: string) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation<ProposeCommitOutcome, ApiError, ChangeTaskStatusInput>({
    mutationFn: (input) => changeTaskStatus(api, projectId, input),
    onSuccess: (outcome) => {
      if ('refused' in outcome && outcome.refused.status === 401) session.reject()
    },
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

/** Proposes and commits a new task with its implements and requires relations. */
export function useCreateTask(projectId: string) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation<CreateTaskOutcome, ApiError, CreateTaskInput>({
    mutationFn: (input) => createTask(api, projectId, input),
    onSuccess: (outcome) => {
      if ('refused' in outcome && outcome.refused.status === 401) session.reject()
    },
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

/** This visitor's hosted demo session (ADR 0019); off outside the demo. */
export function useDemoSession() {
  return useQuery({
    queryKey: keys.demo,
    queryFn: api.demoSession,
    enabled: session.mode() === 'demo',
    refetchInterval: 30_000,
  })
}

/** Unlocks the judges' allowance for this session. */
export function useEnterJudgeCode() {
  const client = useQueryClient()
  return useMutation<DemoView, ApiError, string>({
    mutationFn: (code) => api.enterJudgeCode(code),
    onSuccess: (view) => {
      client.setQueryData(keys.demo, view)
      void client.invalidateQueries({ queryKey: ['navigator'] })
    },
  })
}
