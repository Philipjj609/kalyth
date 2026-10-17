import { ArrowRight, PackageOpen } from 'lucide-react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import {
  useAgentTokens,
  useCompileContext,
  useContextPackage,
  useContextPackages,
  useProposals,
} from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { Button, EmptyState, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { shortId } from '../model/format.ts'
import { packageLabeller, splitBodies, tokenLabeller } from '../model/handoff.ts'
import { AppLink, ErrorNotice, ViewHeader } from '../views/shared.tsx'
import { AgentConnect } from './AgentConnect.tsx'
import { HandoffSource } from './HandoffSource.tsx'
import { type PackageLookup, PackageView } from './PackageView.tsx'
import { RecentPackages } from './RecentPackages.tsx'
import { AgentPromptPanel, ReviewLinkLabel, RoundTripList } from './RoundTrip.tsx'

/**
 * Hands work to a coding agent (ADR 0011): choose an accepted decision or elements, compile a
 * context package, connect an agent over MCP, give it the prompt, and review what it proposes.
 * The package is deep-linkable as ?view=handoff&package=ctx_…; agent tokens never are.
 */
export function HandoffView() {
  const [loc, navigate] = useAppLocation()
  const wb = useWorkbench()
  const recent = useContextPackages(wb.projectId)
  const focusOnLoad = useRef(false)
  return (
    <div className="@container mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <ViewHeader
        title="Handoff"
        description="Compile a context package from an accepted decision or chosen elements, connect a coding agent over MCP, and review what it proposes. Agents read and propose; people commit and decide."
      />
      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <HandoffSource
          onCompiled={(result) => {
            focusOnLoad.current = true
            navigate({ package: result.package.id })
          }}
        />
        <AgentConnect />
      </div>
      <RecentPackages packages={recent.data?.packages ?? []} openId={loc.package} />
      {loc.package ? (
        <PackageSection key={loc.package} packageId={loc.package} focusOnLoad={focusOnLoad} />
      ) : (
        <div className="rounded-lg border border-border border-dashed bg-surface">
          <EmptyState icon={<PackageOpen />} title="No package open">
            Compile a context package above. A package can also be opened by its link, which ends in
            ?view=handoff&amp;package= and its id.
          </EmptyState>
        </div>
      )}
    </div>
  )
}

function PackageSection({
  packageId,
  focusOnLoad,
}: {
  packageId: string
  focusOnLoad: RefObject<boolean>
}) {
  const wb = useWorkbench()
  const query = useContextPackage(packageId)
  const proposals = useProposals(wb.projectId)
  const tokens = useAgentTokens(wb.projectId)
  const compile = useCompileContext(wb.projectId)
  const [splitPending, setSplitPending] = useState<number | null>(null)
  const [splitPackages, setSplitPackages] = useState<Record<number, string>>({})
  const ref = useRef<HTMLDivElement>(null)
  const result = query.data
  const pkg = result?.package

  // Bring a package compiled here into view and move focus to its heading.
  useEffect(() => {
    if (!pkg || !focusOnLoad.current) return
    focusOnLoad.current = false
    const heading = ref.current?.querySelector<HTMLElement>('[data-package-view] h2')
    heading?.focus({ preventScroll: true })
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [pkg, focusOnLoad])

  const lookup = useMemo<PackageLookup | undefined>(
    () =>
      pkg
        ? { labelOf: packageLabeller(pkg, (id) => wb.model?.nameOf(id)), onInspect: wb.select }
        : undefined,
    [pkg, wb.model, wb.select],
  )
  const tokenLabelOf = useMemo(() => tokenLabeller(tokens.data?.tokens), [tokens.data])

  if (query.error) {
    return (
      <ErrorNotice
        error={query.error}
        title={`Package ${shortId(packageId)} could not be loaded`}
      />
    )
  }
  if (!result || !pkg || !lookup) return <Skeleton className="h-48" />
  if (pkg.projectId !== wb.projectId) {
    return (
      <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
        Package <span className="font-mono">{shortId(pkg.id)}</span> belongs to another project.
      </p>
    )
  }
  const splits = splitBodies(pkg)

  return (
    <div ref={ref} className="scroll-mt-4">
      <PackageView
        result={result}
        headRevision={wb.headRevision}
        lookup={lookup}
        renderSplitAction={(_, i) => {
          const done = splitPackages[i]
          const body = splits[i]
          return (
            <span className="flex items-center gap-2">
              {done && (
                <AppLink to={{ package: done }} className="inline-flex items-center gap-1 text-xs">
                  Open part {i + 1} <ArrowRight aria-hidden className="size-3" />
                </AppLink>
              )}
              <Button
                size="sm"
                variant={done ? 'ghost' : 'primary'}
                disabled={!body || compile.isPending}
                onClick={() => {
                  if (!body) return
                  setSplitPending(i)
                  compile.mutate(body, {
                    onSuccess: (r) => setSplitPackages((prev) => ({ ...prev, [i]: r.package.id })),
                    onSettled: () => setSplitPending(null),
                  })
                }}
              >
                {splitPending === i && <Spinner label={`Compiling part ${i + 1}`} />}
                {done ? 'Compile again' : `Compile part ${i + 1}`}
              </Button>
            </span>
          )
        }}
      >
        {compile.isError && <ErrorNotice error={compile.error} title="The part was not compiled" />}
        <div className="grid items-start gap-4 @4xl:grid-cols-2">
          <AgentPromptPanel pkg={pkg} headRevision={wb.headRevision} />
          {pkg.status === 'ready' && (
            <Panel
              title="What came back"
              aside={
                <span className="text-fg-subtle text-xs">
                  pending at <span className="font-mono">r{pkg.revision}</span>
                </span>
              }
            >
              {proposals.error ? (
                <div className="p-4">
                  <ErrorNotice error={proposals.error} title="Proposals could not be loaded" />
                </div>
              ) : !proposals.data ? (
                <div className="p-4">
                  <Skeleton className="h-16" />
                </div>
              ) : (
                <>
                  <p className="border-border border-b px-4 py-2 text-fg-muted text-xs">
                    Pending proposals that name this package, then any others at r{pkg.revision}
                    that name none. Checked every 15 seconds.
                  </p>
                  <RoundTripList
                    proposals={proposals.data.proposals}
                    packageId={pkg.id}
                    revision={pkg.revision}
                    tokenLabelOf={tokenLabelOf}
                    reviewLink={(proposalId) => (
                      <AppLink to={{ view: 'proposals', proposal: proposalId }}>
                        <ReviewLinkLabel />
                      </AppLink>
                    )}
                  />
                </>
              )}
            </Panel>
          )}
        </div>
      </PackageView>
    </div>
  )
}
