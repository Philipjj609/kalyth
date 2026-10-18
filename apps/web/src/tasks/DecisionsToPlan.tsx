import type { DecisionSummary, TaskView } from '@kalyth/contracts'
import { Gavel, ListPlus } from 'lucide-react'
import { Button, EmptyState, Panel, Skeleton } from '../components/ui.tsx'
import { plural } from '../model/format.ts'
import { acceptedAlternatives } from '../model/handoff.ts'

/** Tasks that implement a decision or one of its alternatives. */
export function tasksImplementing(
  decision: Pick<DecisionSummary, 'id' | 'alternatives'>,
  tasks: readonly Pick<TaskView, 'implements'>[],
): number {
  const ids = new Set([decision.id, ...decision.alternatives.map((a) => a.id)])
  return tasks.filter((t) => t.implements.some((i) => ids.has(i.id))).length
}

/**
 * Accepted decisions, as the Handoff view lists them, each with how many tasks already implement
 * it and a way to plan another. Presentational: `decisions` is undefined while loading and null
 * when the server has no decisions route.
 */
export function DecisionsToPlan({
  decisions,
  tasks,
  onPlan,
}: {
  decisions: readonly DecisionSummary[] | null | undefined
  tasks: readonly Pick<TaskView, 'implements'>[]
  onPlan: (decision: DecisionSummary) => void
}) {
  return (
    <Panel
      title="Plan from an accepted decision"
      aside={
        decisions ? (
          <span className="text-fg-subtle text-xs">{plural(decisions.length, 'decision')}</span>
        ) : undefined
      }
    >
      {decisions === undefined ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : decisions === null ? (
        <p className="px-4 py-3 text-fg-muted text-sm">
          This server has no decisions route. Update and restart the Kalyth server.
        </p>
      ) : decisions.length === 0 ? (
        <EmptyState icon={<Gavel />} title="No accepted decisions yet" className="py-8">
          Tasks carry out accepted decisions. Accept an alternative in the Navigator first.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {decisions.map((d) => {
            const count = tasksImplementing(d, tasks)
            const accepted = acceptedAlternatives(d)
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium text-sm">{d.title}</p>
                  <p className="text-fg-muted text-xs">
                    {accepted.length > 0 && (
                      <>
                        Accepted:{' '}
                        <span className="text-fg">{accepted.map((a) => a.title).join(', ')}</span> ·{' '}
                      </>
                    )}
                    {count === 0 ? 'no task yet' : plural(count, 'task')}
                  </p>
                </div>
                <Button size="sm" onClick={() => onPlan(d)}>
                  <ListPlus aria-hidden />
                  Create a task
                  <span className="sr-only"> for {d.title}</span>
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
