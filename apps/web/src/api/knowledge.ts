import type {
  AssessmentResult,
  KnowledgeSearchResult,
  KnowledgeView,
  LibraryUsesResult,
  ListAssessmentsResult,
  PinStatusResult,
  ReadAs,
} from '@kalyth/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { Nature } from '../model/knowledge.ts'
import { api } from './queries.ts'

/**
 * Query hooks over the K4 read operations (ADR 0031). The explorer reads only through them, with
 * the same contracts agents use over MCP; nothing here writes.
 */
const read = <T>(name: string, input: Record<string, unknown>) => api.knowledge<T>(name, input)

export function useLibraryUses(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['knowledge', 'uses', projectId],
    queryFn: () => read<LibraryUsesResult>('list_library_uses', { projectId }),
    enabled,
  })
}

export function useKnowledgeSearch(projectId: string, text: string) {
  return useQuery({
    queryKey: ['knowledge', 'search', projectId, text],
    queryFn: () => read<KnowledgeSearchResult>('search_knowledge', { projectId, text, limit: 200 }),
    placeholderData: keepPreviousData,
  })
}

export function useKnowledgeItem(item: { library: string; id: string } | undefined) {
  return useQuery({
    queryKey: ['knowledge', 'item', item?.library, item?.id],
    queryFn: () => read<KnowledgeView>('get_knowledge', { library: item?.library, id: item?.id }),
    enabled: Boolean(item),
  })
}

export function usePinStatus(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['knowledge', 'pins', projectId],
    queryFn: () => read<PinStatusResult>('get_pin_status', { projectId }),
    enabled,
  })
}

export function useAssessments(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['knowledge', 'assessments', projectId],
    queryFn: () => read<ListAssessmentsResult>('list_assessments', { projectId }),
    enabled,
  })
}

/** Evaluates now, read-only. Runs only once a scenario and a nature are chosen. */
export function useApplicability(input: {
  projectId: string
  item: string | undefined
  scenario: string | undefined
  element: string | undefined
  nature: Nature | undefined
}) {
  const { projectId, item, scenario, element, nature } = input
  return useQuery({
    queryKey: ['knowledge', 'assess', projectId, item, scenario, element, nature],
    queryFn: () =>
      read<AssessmentResult & { readAs: ReadAs }>('assess_applicability', {
        projectId,
        item,
        scenario,
        ...(element ? { element } : {}),
        nature,
      }),
    enabled: Boolean(item && scenario && nature),
    retry: false,
  })
}
