import type { ProjectSummary } from '@kalyth/contracts'
import { ArrowRight, FolderGit2 } from 'lucide-react'
import { EmptyState, Skeleton } from '../components/ui.tsx'
import { absoluteTime, relativeTime } from '../model/format.ts'
import { ErrorNotice, ViewHeader } from './shared.tsx'

export function ProjectsLanding({
  projects,
  loading,
  error,
  onOpen,
}: {
  projects: ProjectSummary[] | undefined
  loading: boolean
  error: unknown
  onOpen: (id: string) => void
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-4xl p-8">
        <ViewHeader
          title="Projects"
          description="Each project is a revisioned, evidence-backed model that people and coding agents share."
        />
        <div className="mt-6">
          {error ? (
            <ErrorNotice error={error} title="Projects could not be loaded" />
          ) : loading ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          ) : !projects || projects.length === 0 ? (
            <div className="rounded-lg border border-border border-dashed bg-surface">
              <EmptyState icon={<FolderGit2 />} title="No projects yet">
                <p>
                  Create one through the API or an agent over MCP, or load the sample with{' '}
                  <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
                    pnpm dev:seed
                  </code>{' '}
                  and reload.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="group flex h-full w-full flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-left shadow-panel transition-colors hover:border-border-strong"
                  >
                    <span className="flex w-full items-center gap-2">
                      <FolderGit2 aria-hidden className="size-4 text-fg-subtle" />
                      <span className="truncate font-semibold text-fg">{p.name}</span>
                      <ArrowRight
                        aria-hidden
                        className="ml-auto size-4 text-fg-subtle transition-transform group-hover:translate-x-0.5"
                      />
                    </span>
                    {p.description && (
                      <span className="line-clamp-2 text-fg-muted">{p.description}</span>
                    )}
                    <span className="mt-auto flex items-center gap-3 text-fg-subtle text-xs">
                      <span className="font-mono">head r{p.headRevision}</span>
                      <span title={absoluteTime(p.createdAt)}>
                        created {relativeTime(p.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
