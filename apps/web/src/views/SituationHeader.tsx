import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'
import { useDecisions, useNavigatorRuns, useProposals } from '../api/queries.ts'
import type { AppLocation } from '../app/location.ts'
import { useSessionMode } from '../app/session.ts'
import { useWorkbench } from '../app/workbench.ts'
import { changeItems, nextStep, openQuestions } from '../change/model.ts'
import { cn } from '../lib/cn.ts'
import { ButtonLink } from './shared.tsx'

interface Need {
  key: string
  title: string
  step: string
  detail?: string
  to: Partial<AppLocation>
  action: string
  tone: 'action' | 'attention'
}

const DECISIVE = new Set(['blocking', 'decision-sensitive'])

/**
 * The top of the Situation page (ADR 0020): what needs a person now, each with its next action,
 * then what the system is. The counts below it are details.
 */
export function SituationHeader() {
  const wb = useWorkbench()
  const decisions = useDecisions(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId)
  const proposals = useProposals(wb.projectId)
  const demo = useSessionMode() === 'demo'

  const needs = useMemo((): Need[] => {
    const list: Need[] = []
    const items = changeItems(
      decisions.data?.decisions ?? [],
      runs.data?.runs ?? [],
      proposals.data?.proposals ?? [],
      (id) => openQuestions(wb.model, id).length,
    )
    for (const item of items) {
      if (!item.needsYou) continue
      if (item.ref.kind === 'run') {
        list.push({
          key: item.ref.id,
          title: item.title,
          step: 'Review the proposed alternatives and commit them',
          to: { view: 'change', run: item.ref.id, decision: undefined },
          action: 'Review',
          tone: 'action',
        })
        continue
      }
      const d = decisions.data?.decisions.find((x) => x.id === item.ref.id)
      if (!d) continue
      const open = openQuestions(wb.model, d.id)
      const step = nextStep({
        decision: d,
        decisiveOpen: open.filter((q) =>
          DECISIVE.has(String((q.attributes as Record<string, unknown>).inquiryRole)),
        ).length,
        questionsOpen: open.length,
        hasPackage: false,
      })
      if (step.tone === 'done') continue
      list.push({
        key: d.id,
        title: d.title || d.question,
        step: step.text,
        ...(step.detail ? { detail: step.detail } : {}),
        to: { view: 'change', decision: d.id, run: undefined },
        action: 'Open the change',
        tone: step.tone,
      })
    }
    const pendingOther = (proposals.data?.proposals ?? []).filter(
      (p) => p.status === 'pending' && !(runs.data?.runs ?? []).some((r) => r.proposalId === p.id),
    ).length
    if (pendingOther > 0) {
      list.push({
        key: 'proposals',
        title: `${pendingOther} proposal${pendingOther === 1 ? '' : 's'} waiting for review`,
        step: 'Nothing changes the model until a person commits it',
        to: { view: 'proposals' },
        action: 'Review',
        tone: 'action',
      })
    }
    const s = wb.freshness.report?.summary
    const stale = (s?.stale ?? 0) + (s?.['derived-stale'] ?? 0)
    if (stale > 0) {
      list.push({
        key: 'stale',
        title: `${stale} claim${stale === 1 ? '' : 's'} no longer match the source`,
        step: 'See where on the canvas, then refresh or retire them',
        to: { view: 'graph', lens: 'freshness' },
        action: 'Show on the canvas',
        tone: 'attention',
      })
    }
    return list
  }, [decisions.data, runs.data, proposals.data, wb.model, wb.freshness.report])

  // A project created from an idea, before any run: no software elements and no change.
  const empty =
    !Object.entries(wb.overview.objectCounts).some(
      ([type, n]) => type.startsWith('software.') && n > 0,
    ) && (runs.data?.runs ?? []).length === 0

  const system = useMemo(() => {
    const objects = wb.model?.objects ?? []
    const of = (type: string) => objects.filter((o) => o.type === type && o.lifecycle === 'active')
    const containers = of('software.Container').map((c) => {
      const a = c.attributes as Record<string, unknown>
      const contained = (wb.model?.relations ?? []).filter(
        (r) => r.type === 'contains' && r.from === c.id && r.lifecycle === 'active',
      ).length
      return `${String(a.name)}${a.technology ? ` (${String(a.technology)}, ${contained})` : ` (${contained})`}`
    })
    const snapshot = of('core.SourceSnapshot')[0]?.attributes as Record<string, unknown> | undefined
    return {
      containers,
      endpoints: of('software.Endpoint').length,
      entities: of('software.DataEntity').length,
      proposed: objects.filter((o) => o.stance === 'toBe' && o.type.startsWith('software.')).length,
      source: snapshot
        ? [snapshot.ref, snapshot.commit ? `(${String(snapshot.commit).slice(0, 7)})` : '']
            .filter(Boolean)
            .join(' ')
        : null,
    }
  }, [wb.model])

  return (
    <div className="space-y-4">
      <section aria-labelledby="needs-you" className="space-y-2">
        <h2 id="needs-you" className="k-eyebrow">
          Needs you
        </h2>
        {needs.length === 0 && empty ? (
          <div className="flex flex-wrap items-center gap-4 border border-accent bg-accent-soft px-5 py-3.5">
            <div className="min-w-0 flex-[1_1_360px]">
              <p className="text-fg-muted text-sm">Your idea has no model yet</p>
              <p className="font-semibold text-[17px] leading-snug">
                Sketch the first designs from your idea
              </p>
              <p className="text-fg-muted text-sm">
                The Navigator proposes two to four ways to build it and the questions that decide
                between them. Nothing is added until you accept it.
              </p>
            </div>
            <ButtonLink to={{ view: 'navigator' }} primary>
              Sketch from the idea
              <ArrowRight aria-hidden className="ml-1.5 inline size-4" />
            </ButtonLink>
          </div>
        ) : needs.length === 0 && demo ? (
          // A first visit to the hosted demo: what Kalyth does, and the quickest way to see it.
          <div className="flex flex-wrap items-center gap-4 border border-accent bg-accent-soft px-5 py-3.5">
            <div className="min-w-0 flex-[1_1_360px] space-y-1">
              <p className="text-fg-muted text-sm">Start here</p>
              <p className="font-semibold text-[17px] leading-snug">
                Kalyth keeps an evidence-backed engineering model of a codebase
              </p>
              <p className="text-fg-muted text-sm">
                Everything below was read from the FastAPI template’s source, each fact pinned to
                the lines it came from. Ask for a change: Kalyth proposes alternatives with what
                each one affects and the questions that decide between them. You compare and decide,
                and it compiles what a coding agent needs. Recorded runs are free and instant.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ButtonLink to={{ view: 'navigator' }} primary>
                Try a recorded change request
                <ArrowRight aria-hidden className="ml-1.5 inline size-4" />
              </ButtonLink>
              <ButtonLink to={{ view: 'graph' }}>Explore the canvas</ButtonLink>
            </div>
          </div>
        ) : needs.length === 0 ? (
          <div className="flex flex-wrap items-center gap-4 border border-border bg-surface px-5 py-4">
            <p className="flex-[1_1_320px] font-medium">
              Nothing waits on you. Describe a change, or explore the model on the canvas.
            </p>
            <ButtonLink to={{ view: 'navigator' }} primary>
              New change
            </ButtonLink>
            <ButtonLink to={{ view: 'graph' }}>Open the canvas</ButtonLink>
          </div>
        ) : (
          <ul className="space-y-2">
            {needs.map((n, i) => (
              <li
                key={n.key}
                className={cn(
                  'flex flex-wrap items-center gap-4 border px-5 py-3.5',
                  i === 0
                    ? n.tone === 'attention'
                      ? 'border-revision bg-revision-soft'
                      : 'border-accent bg-accent-soft'
                    : 'border-border bg-surface',
                )}
              >
                <div className="min-w-0 flex-[1_1_360px]">
                  <p className="text-fg-muted text-sm">{n.title}</p>
                  <p className={cn('font-semibold leading-snug', i === 0 && 'text-[17px]')}>
                    {n.step}
                  </p>
                  {n.detail && <p className="text-fg-muted text-sm">{n.detail}</p>}
                </div>
                <ButtonLink to={n.to} primary={i === 0}>
                  {n.action}
                  <ArrowRight aria-hidden className="ml-1.5 inline size-4" />
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="max-w-4xl text-sm">
        <span className="k-eyebrow mr-2">The system</span>
        {system.containers.length > 0 ? system.containers.join(' · ') : 'No containers yet'}
        {' · '}
        {system.endpoints} endpoint{system.endpoints === 1 ? '' : 's'} · {system.entities} data
        entit
        {system.entities === 1 ? 'y' : 'ies'}
        {system.proposed > 0 ? ` · ${system.proposed} proposed, not in the code yet` : ''}
        {system.source ? ` · analysed at ${system.source}` : ''}
      </p>
    </div>
  )
}
