import type { TaskRepositoryView } from '@kalyth/contracts'
import { FolderGit2, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { useSetTaskRepository, useTaskRepository } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { useToast } from '../components/toast.tsx'
import { Button, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { absoluteTime, relativeTime, shortId } from '../model/format.ts'
import { ErrorNotice } from '../views/shared.tsx'

export const TASK_REPOSITORY_INPUT_ID = 'task-repository-path'
const MAX_PATH = 1000

/**
 * The local git repository agents commit their work to. Kalyth only reads it, to verify execution
 * reports. Presentational: `repository` is undefined while loading and null when the server has
 * no task routes.
 */
export function TaskRepositoryForm({
  repository,
  saving,
  error,
  onSave,
}: {
  repository: TaskRepositoryView | null | undefined
  saving: boolean
  error: unknown
  onSave: (path: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [path, setPath] = useState('')
  const hintId = useId()
  if (repository === undefined) return <Skeleton className="m-4 h-12" />
  if (repository === null) {
    return (
      <p className="px-4 py-3 text-fg-muted text-sm">
        This server has no task routes. Update and restart the Kalyth server to register a task
        repository.
      </p>
    )
  }
  const current = repository.path
  const showForm = current === null || editing
  const trimmed = path.trim()
  return (
    <div className="space-y-3 p-4">
      {current === null ? (
        <p className="tone-warning flex items-start gap-2 rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>Not set: reports cannot be verified until you register one.</span>
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-muted">Path</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
            <code className="break-all font-mono text-fg">{current}</code>
          </dd>
          {(repository.setBy || repository.setAt) && (
            <>
              <dt className="text-fg-muted">Set</dt>
              <dd className="text-fg-muted">
                {repository.setBy && (
                  <>
                    by{' '}
                    <span className="font-mono" title={repository.setBy}>
                      {shortId(repository.setBy)}
                    </span>{' '}
                  </>
                )}
                {repository.setAt && (
                  <time dateTime={repository.setAt} title={absoluteTime(repository.setAt)}>
                    {relativeTime(repository.setAt)}
                  </time>
                )}
              </dd>
            </>
          )}
        </dl>
      )}
      {showForm ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!trimmed || saving) return
            onSave(trimmed)
          }}
        >
          <label htmlFor={TASK_REPOSITORY_INPUT_ID} className="block font-medium text-xs">
            {current === null ? 'Repository path' : 'New repository path'}
          </label>
          <div className="flex gap-2">
            <input
              id={TASK_REPOSITORY_INPUT_ID}
              value={path}
              maxLength={MAX_PATH}
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
              aria-describedby={hintId}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/me/src/my-app"
              className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 font-mono text-xs placeholder:text-fg-subtle disabled:bg-surface-2"
            />
            <Button type="submit" variant="primary" disabled={!trimmed || saving}>
              {saving && (
                <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Registering" />
              )}
              Register
            </Button>
            {current !== null && (
              <Button onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
          <p id={hintId} className="text-fg-subtle text-xs">
            A local git repository on the machine running the Kalyth server. Kalyth reads it, never
            writes to it.
          </p>
        </form>
      ) : (
        <Button
          size="sm"
          onClick={() => {
            setPath(current ?? '')
            setEditing(true)
          }}
        >
          Change
        </Button>
      )}
      {error ? <ErrorNotice error={error} title="The task repository was not registered" /> : null}
    </div>
  )
}

export function TaskRepositoryPanel() {
  const wb = useWorkbench()
  const repository = useTaskRepository(wb.projectId)
  const save = useSetTaskRepository(wb.projectId)
  const notify = useToast()
  return (
    <Panel
      title="Task repository"
      aside={<span className="text-fg-subtle text-xs">where agents commit</span>}
    >
      {repository.error ? (
        <div className="p-4">
          <ErrorNotice error={repository.error} title="The task repository could not be read" />
        </div>
      ) : (
        <TaskRepositoryForm
          // A new key after each save closes the form on the registered path.
          key={repository.data?.path ?? 'unset'}
          repository={repository.data}
          saving={save.isPending}
          error={save.error}
          onSave={(path) =>
            save.mutate(path, {
              onSuccess: (view) =>
                notify({
                  tone: 'success',
                  title: 'Task repository registered',
                  body: view.path ?? path,
                }),
            })
          }
        />
      )}
    </Panel>
  )
}
