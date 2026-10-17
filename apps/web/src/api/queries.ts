import type {
  NavigatorRun,
  NavigatorStatus,
  ObjectVersion,
  RelationVersion,
} from '@kalyth/contracts'
import {
  QueryCache,
  QueryClient,
  queryOptions,
  useMutation,
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
  createApi,
  isApiError,
  PAGE_LIMIT,
  type StartRunBody,
} from './client.ts'
import { freshnessIndex } from './freshness.ts'

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
  navigatorStatus: (projectId: string) => ['navigator', 'status', projectId] as const,
  navigatorRuns: (projectId: string) => ['navigator', 'runs', projectId] as const,
  navigatorRun: (runId: string) => ['navigator', 'run', runId] as const,
  impact: (projectId: string, revision: number | 'head', seeds: string) =>
    ['impact', projectId, revision, seeds] as const,
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects, refetchInterval: 30_000 })
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
      truncated:
        objects.data.objects.length >= PAGE_LIMIT || relations.data.relations.length >= PAGE_LIMIT,
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
    client.invalidateQueries({ queryKey: keys.navigatorStatus(projectId) }),
    runs ? client.invalidateQueries({ queryKey: keys.navigatorRuns(projectId) }) : undefined,
    client.invalidateQueries({ queryKey: keys.proposals(projectId) }),
    client.invalidateQueries({ queryKey: ['overview', projectId] }),
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
