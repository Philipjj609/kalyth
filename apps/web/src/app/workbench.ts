import type { ProjectOverview } from '@kalyth/contracts'
import { createContext, useContext } from 'react'
import type { ClaimFreshness, FreshnessReport } from '../api/freshness.ts'
import type { RevisionModel } from '../api/queries.ts'
import type { View } from './location.ts'

/** Several relations drawn as one aggregated edge; the Inspector lists them. */
export interface RelationGroupSelection {
  title: string
  relationIds: string[]
}

export interface Workbench {
  projectId: string
  overview: ProjectOverview
  /** The revision being shown (the head unless a past revision was chosen). */
  revision: number
  headRevision: number
  isHistorical: boolean
  model: RevisionModel | undefined
  modelLoading: boolean
  modelError: Error | null
  freshness: {
    available: boolean
    report: FreshnessReport | null
    index: ReadonlyMap<string, ClaimFreshness>
  }
  selection: string | undefined
  group: RelationGroupSelection | null
  select: (id: string | undefined) => void
  selectGroup: (group: RelationGroupSelection) => void
  setView: (view: View) => void
  setRevision: (revision: number | undefined) => void
}

export const WorkbenchContext = createContext<Workbench | null>(null)

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench outside the workbench')
  return value
}
