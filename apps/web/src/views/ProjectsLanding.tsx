import type { ProjectSummary } from '@kalyth/contracts'
import { ArrowRight, FolderGit2, Plus } from 'lucide-react'
import { useState } from 'react'
import { useCreateProject } from '../api/queries.ts'
import { Button, EmptyState, Skeleton } from '../components/ui.tsx'
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
        <NewProject onCreated={onOpen} />
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
                  Start one above from an idea, or load the sample with{' '}
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

/**
 * A new, empty project. The description is the idea in the person's words; the Navigator can then
 * propose a first model from it (ADR 0022).
 */
function NewProject({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useCreateProject()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  if (!open) {
    return (
      <div className="mt-6">
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus aria-hidden />
          New project
        </Button>
      </div>
    )
  }
  const trimmed = name.trim()
  return (
    <form
      aria-label="New project"
      className="mt-6 space-y-3 rounded-lg border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!trimmed || create.isPending) return
        create.mutate(
          { name: trimmed, description: description.trim() },
          { onSuccess: (project) => onCreated(project.id) },
        )
      }}
    >
      <label className="block space-y-1">
        <span className="font-medium text-sm">Name</span>
        <input
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-medium text-sm">The idea</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What should it do, and for whom? You can ask the Navigator for a first model next."
          className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
        />
      </label>
      {create.error ? (
        <ErrorNotice error={create.error} title="The project was not created" />
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!trimmed || create.isPending}>
          Create project
        </Button>
        <Button onClick={() => setOpen(false)} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
