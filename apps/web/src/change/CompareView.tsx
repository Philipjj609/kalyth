import type { DecisionSummary } from '@kalyth/contracts'
import { Check } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useAcceptAlternative, useDecisions, useEvidence, useImpacts } from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { ConfidenceBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, ScrollRegion, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { compareAlternatives, compareReach } from '../model/compare.ts'
import { AcceptDialog } from '../navigator/ProposedOutput.tsx'
import { AppLink, ButtonLink, RecordLink, withoutHandles } from '../views/shared.tsx'
import { LevelBars } from './ChangeThread.tsx'
import { lead, tradeoffLevels } from './model.ts'

const DECISIVE = new Set(['blocking', 'decision-sensitive'])

type Cell = { text: string; level?: 'low' | 'medium' | 'high' | null; none?: boolean }
interface Row {
  key: string
  label: ReactNode
  note?: ReactNode
  cells: Cell[]
  /** The same in every alternative, so "differences only" hides it. */
  same: boolean
  kind: 'interpretation' | 'evidence' | 'change'
}
interface Group {
  title: string
  note: string
  kind: Row['kind']
  rows: Row[]
}

/**
 * The alternatives of one decision side by side (ADR 0020). Every row says where its content comes
 * from: the model's interpretation (inferred, generated) is kept apart from the evidence Kalyth
 * observed or computed.
 */
export function CompareView() {
  const [loc] = useAppLocation()
  const wb = useWorkbench()
  const decisions = useDecisions(wb.projectId)
  const decision = decisions.data?.decisions.find((d) => d.id === loc.decision)
  if (!loc.decision)
    return <p className="p-8 text-fg-muted">Choose a change to compare its alternatives.</p>
  if (!decision) {
    return decisions.isLoading ? (
      <div className="p-8">
        <Spinner label="Loading the comparison" />
      </div>
    ) : (
      <p className="p-8 text-fg-muted">No decision with this id at the viewed revision.</p>
    )
  }
  return <Comparison key={decision.id} decision={decision} />
}

function Comparison({ decision }: { decision: DecisionSummary }) {
  const wb = useWorkbench()
  const accept = useAcceptAlternative(wb.projectId)
  const notify = useToast()
  const [diffOnly, setDiffOnly] = useState(false)
  // Nothing is chosen until the person chooses: a preselected column would read as advice.
  const [pick, setPick] = useState(() =>
    decision.alternatives.findIndex((a) => a.status === 'accepted'),
  )
  const [step, setStep] = useState<'idle' | 'warn'>('idle')
  const [choosing, setChoosing] = useState<{ id: string; title: string } | null>(null)

  const comparison = useMemo(
    () =>
      compareAlternatives(decision, {
        objectById: wb.model?.objectById ?? new Map(),
        relations: wb.model?.relations ?? [],
      }),
    [decision, wb.model],
  )
  const alts = comparison.alternatives
  const impacts = useImpacts(
    wb.projectId,
    alts.map((a) => a.targets),
    wb.headRevision,
  )
  const reach = compareReach(impacts.map((q) => q.data))

  // Where each direct change's own citations point, observed in the source.
  const changeRelations = useMemo(
    () => decision.alternatives.flatMap((a) => a.directChanges.map((c) => c.relationId)),
    [decision],
  )
  const evidenceIds = useMemo(() => {
    const ids: string[] = []
    for (const id of changeRelations) {
      const r = wb.model?.relations.find((x) => x.id === id)
      for (const g of r?.claim.supports ?? []) ids.push(...g.allOf)
    }
    return ids
  }, [changeRelations, wb.model])
  const evidence = useEvidence(wb.projectId, evidenceIds)
  const pathOf = (id: string) => {
    const e = evidence.data?.find((x) => x.id === id)
    if (e?.source.kind !== 'sourceSpan') return null
    const name = e.source.path.split('/').at(-1)
    return `${name}:${e.source.span.startLine}–${e.source.span.endLine}`
  }
  const citesOf = (altIndex: number) => {
    const alt = decision.alternatives[altIndex]
    const files = new Set<string>()
    let cited = 0
    for (const c of alt?.directChanges ?? []) {
      const r = wb.model?.relations.find((x) => x.id === c.relationId)
      const ids = (r?.claim.supports ?? []).flatMap((g) => g.allOf)
      if (ids.length > 0) cited++
      for (const id of ids) {
        const p = pathOf(id)
        if (p) files.add(p.split(':')[0] as string)
      }
    }
    return { cited, total: alt?.directChanges.length ?? 0, files: [...files] }
  }

  const questions = [...comparison.questions, ...alts.flatMap((a) => a.questions)].filter(
    (q, i, all) => all.findIndex((x) => x.id === q.id) === i,
  )
  const decisive = questions.filter((q) => q.status === 'open' && DECISIVE.has(q.inquiryRole))

  const groups: Group[] = [
    {
      title: 'Trade-offs',
      note: 'generated interpretation: the model’s judgement, not measured',
      kind: 'interpretation',
      rows: ['Cost', 'Risk', 'Reversibility', 'Migration', 'Operations'].map((label, li) => {
        const cells = alts.map((a) => {
          const level = tradeoffLevels(a.tradeoffs)[li]?.level ?? null
          return { text: level ?? '—', level }
        })
        return {
          key: `t-${label}`,
          label,
          note: label === 'Reversibility' ? 'higher is easier to undo' : undefined,
          cells,
          same: cells.every((c) => c.text === cells[0]?.text),
          kind: 'interpretation' as const,
        }
      }),
    },
    {
      title: 'What changes for people',
      note: 'generated interpretation, from each alternative’s own summary',
      kind: 'interpretation',
      rows: [
        {
          key: 'summary',
          label: 'In short',
          cells: alts.map((a) => ({ text: withoutHandles(lead(a.summary)) })),
          same: false,
          kind: 'interpretation',
        },
        {
          key: 'confidence',
          label: 'Why this confidence',
          cells: alts.map((a) => ({ text: withoutHandles(a.confidence?.rationale ?? '—') })),
          same: false,
          kind: 'interpretation',
        },
      ],
    },
    {
      title: 'Direct changes',
      note: 'each change is the model’s; the excerpt it cites is observed in the source',
      kind: 'change',
      rows: comparison.changes.map((row) => ({
        key: row.target,
        label: (
          <RecordLink id={row.target} className="font-mono text-[13px]">
            {row.label}
          </RecordLink>
        ),
        cells: row.cells.map((c) =>
          c ? { text: withoutHandles(c) } : { text: 'Not changed', none: true },
        ),
        same: row.cells.every((c) => (c === null) === (row.cells[0] === null)),
        kind: 'change',
      })),
    },
    {
      title: 'Evidence and reach',
      note: 'observed in the source, or computed by Kalyth from it',
      kind: 'evidence',
      rows: [
        {
          key: 'cites',
          label: 'Cited source',
          cells: alts.map((_, i) => {
            const c = citesOf(i)
            return {
              text:
                c.total === 0
                  ? '—'
                  : `${c.cited} of ${c.total} changes cite ${c.files.join(', ') || 'excerpts'}`,
            }
          }),
          same: false,
          kind: 'evidence',
        },
        {
          key: 'reach',
          label: 'Reach',
          note: 'elements reached through impact',
          cells: alts.map((_, i) => {
            const r = reach[i]
            return {
              text: r
                ? `${r.total} elements${r.only.length > 0 ? `; ${r.only.length} only by this one` : ''}${r.truncated ? ' (cut off)' : ''}`
                : '…',
            }
          }),
          same: false,
          kind: 'evidence',
        },
      ],
    },
  ]
  const hidden = diffOnly ? groups.flatMap((g) => g.rows).filter((r) => r.same).length : 0
  const chosen = pick >= 0 ? alts[pick] : undefined

  const startAccept = () => {
    if (!chosen) return
    if (decisive.length > 0 && step !== 'warn') {
      setStep('warn')
      return
    }
    accept.reset()
    setChoosing({ id: chosen.id, title: chosen.title })
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-4 px-8 pt-6 pb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-[1_1_520px]">
            <p className="k-eyebrow">
              Change · compare ·{' '}
              <AppLink to={{ view: 'change', decision: decision.id }}>back to the thread</AppLink>
            </p>
            <h1 className="font-semibold text-2xl leading-tight tracking-tight">
              {decision.title || decision.question}
            </h1>
            <p className="mt-1 max-w-3xl text-fg-muted text-sm">
              Pick a column to choose it. Rows marked with a dashed rule are the model’s
              interpretation; rows of evidence are observed in the source or computed by Kalyth.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={diffOnly}
              onChange={(e) => setDiffOnly(e.target.checked)}
              className="size-4 accent-[var(--k-accent)]"
            />
            Show only differences
          </label>
          {diffOnly && (
            <span className="font-mono text-fg-muted text-xs">
              {hidden} rows hidden: the same in all
            </span>
          )}
        </div>

        <ScrollRegion
          label="Comparison table"
          className="max-h-[calc(100vh-260px)] overflow-auto border border-fg bg-surface"
        >
          <table className="k-ctable" style={{ minWidth: 200 + alts.length * 230 }}>
            <caption className="sr-only">
              The alternatives of this decision, one column each; the chosen one is marked
            </caption>
            <colgroup>
              <col style={{ width: 200 }} />
              {alts.map((a) => (
                <col key={a.id} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="k-cth k-sticky-col">
                  <span className="k-eyebrow">Alternative</span>
                </th>
                {alts.map((a, i) => (
                  <th scope="col" key={a.id} className={cn('k-cth', i === pick && 'k-picked')}>
                    <button
                      type="button"
                      aria-pressed={i === pick}
                      onClick={() => {
                        setPick(i)
                        setStep('idle')
                      }}
                      className="flex w-full flex-col items-start gap-1 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <span className="k-key">A{i + 1}</span>
                        {a.confidence && <ConfidenceBadge level={a.confidence.level} size="sm" />}
                      </span>
                      <span className="font-semibold text-[13.5px] leading-snug">{a.title}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => {
              const rows = g.rows.filter((r) => !(diffOnly && r.same))
              if (rows.length === 0) return null
              return (
                <tbody key={g.title}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={alts.length + 1}
                      className={cn('k-cgroup', g.kind === 'interpretation' && 'k-cgroup-inferred')}
                    >
                      <span className="k-eyebrow text-fg-muted">{g.title}</span>
                      <span className="ml-2 font-normal text-fg-muted text-xs">{g.note}</span>
                    </th>
                  </tr>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row" className="k-ctd k-sticky-col font-medium">
                        <div>{r.label}</div>
                        {r.note && (
                          <div className="font-normal text-fg-muted text-xs">{r.note}</div>
                        )}
                      </th>
                      {r.cells.map((c, i) => (
                        <td
                          key={alts[i]?.id ?? i}
                          className={cn('k-ctd', i === pick && 'k-picked')}
                        >
                          <span
                            className={cn(
                              'flex items-center gap-2',
                              c.none ? 'text-fg-muted' : r.kind !== 'evidence' && 'k-inferred',
                            )}
                          >
                            {c.text}
                            {c.level !== undefined && <LevelBars level={c.level ?? null} />}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              )
            })}
          </table>
        </ScrollRegion>
      </div>

      {decision.status === 'open' && !chosen && (
        <div className="sticky bottom-0 z-[5] border-fg border-t bg-surface px-8 py-3 text-sm">
          <span className="k-eyebrow mr-3">Choose</span>
          Select an alternative's column to choose it, then accept it here.
        </div>
      )}
      {decision.status === 'open' && chosen && (
        <div className="sticky bottom-0 z-[5] space-y-3 border-fg border-t bg-surface px-8 py-3">
          {step === 'warn' && (
            <div
              role="alert"
              className="border border-revision border-l-4 bg-surface px-4 py-3 text-sm"
            >
              <p className="font-semibold">
                {decisive.length} question{decisive.length === 1 ? '' : 's'} that decide between
                these alternatives {decisive.length === 1 ? 'is' : 'are'} still open
              </p>
              <ul className="mt-1 list-disc pl-5">
                {decisive.map((q) => (
                  <li key={q.id}>{q.text.split('\nOptions:')[0]}</li>
                ))}
              </ul>
              <p className="mt-1 text-fg-muted">
                If you accept A{pick + 1} now, they stay open on the decision and go into the
                context package as mandatory items, so an agent cannot miss them.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <ButtonLink to={{ view: 'change', decision: decision.id }}>
                  Answer them first
                </ButtonLink>
                <Button variant="primary" onClick={startAccept}>
                  Accept A{pick + 1} with {decisive.length} open question
                  {decisive.length === 1 ? '' : 's'}
                </Button>
                <Button onClick={() => setStep('idle')}>Cancel</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <span className="k-eyebrow">Chosen</span>
            <span className="k-key">A{pick + 1}</span>
            <span className="font-medium">{chosen.title}</span>
            {decisive.length > 0 && (
              <span className="rounded-full border border-border px-2 text-xs">
                {decisive.length} open question{decisive.length === 1 ? '' : 's'}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <ButtonLink to={{ view: 'graph', lens: 'impact', alternative: chosen.id }}>
                See A{pick + 1} on the canvas
              </ButtonLink>
              <Button
                variant="primary"
                disabled={accept.isPending || wb.isHistorical}
                onClick={startAccept}
              >
                <Check aria-hidden />
                <span>Accept A{pick + 1}…</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      <AcceptDialog
        alternative={choosing}
        question={decision.question || decision.title}
        headRevision={wb.headRevision}
        pending={accept.isPending}
        error={accept.error}
        onClose={() => setChoosing(null)}
        onSubmit={(rationale) => {
          if (!choosing) return
          const picked = choosing
          accept.mutate(
            {
              decisionId: decision.id,
              chosenId: picked.id,
              alternativeIds: decision.alternatives.map((a) => a.id),
              rationale,
              baseRevision: wb.headRevision,
            },
            {
              onSuccess: (result) => {
                setChoosing(null)
                setStep('idle')
                if ('committed' in result)
                  notify({ tone: 'success', title: `Accepted: ${picked.title}`, body: rationale })
                else
                  notify({
                    tone: result.refused.body.code === 'stale' ? 'caution' : 'danger',
                    title: `Not committed: ${result.refused.body.code}`,
                    body: result.refused.body.message,
                  })
              },
            },
          )
        }}
      />
    </div>
  )
}
