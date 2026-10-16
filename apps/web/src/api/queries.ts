import type { ObjectVersion, RelationVersion } from '@kalyth/contracts'
import {
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'
import { session } from '../app/session.ts'
import { objectLabel } from '../model/labels.ts'
import { type ApiError, createApi, isApiError, PAGE_LIMIT } from './client.ts'
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
