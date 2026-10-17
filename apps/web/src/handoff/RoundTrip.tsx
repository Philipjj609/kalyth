import type { ContextPackage, Proposal } from '@kalyth/contracts'
import { ArrowRight, Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { MockBadge, OriginBadge } from '../components/badges.tsx'
import { CopyButton, EmptyState, Panel } from '../components/ui.tsx'
import { absoluteTime, plural, relativeTime, shortId } from '../model/format.ts'
import { agentPrompt, roundTripProposals } from '../model/handoff.ts'
import { hasMockOutput } from '../model/navigator.ts'

/** The prompt to give the agent, with a copy button. A blocked package has no prompt. */
export function AgentPromptPanel({
  pkg,
  headRevision,
}: {
  pkg: Pick<ContextPackage, 'id' | 'revision' | 'status'>
  headRevision: number
}) {
  if (pkg.status === 'blocked') {
    return (
      <Panel title="Prompt for the agent">
        <p className="px-4 py-3 text-fg-muted text-sm">
          A blocked package cannot be handed off. Compile one of the suggested parts, and its prompt
          appears here.
        </p>
      </Panel>
    )
  }
  const prompt = agentPrompt(pkg)
  return (
    <Panel
      title="Prompt for the agent"
      aside={
        <CopyButton text={prompt} label="Copy the prompt">
          Copy prompt
        </CopyButton>
      }
    >
      <div className="space-y-2 p-4">
        <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
          {prompt}
        </p>
        <p className="text-fg-muted text-xs">
          Give this to an agent connected with an agent token. It can read and propose; it cannot
          commit or decide.
        </p>
        {pkg.revision < headRevision && (
          <p className="tone-warning rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs">
            The head has moved to r{headRevision}. Proposals at r{pkg.revision} are re-checked when
            committed; compile again for a package at the head.
          </p>
        )}
      </div>
    </Panel>
  )
}

/**
 * What came back: pending proposals at the package revision, with their origin and a link to
 * review each. Presentational; the review link and token labels are passed in.
 */
export function RoundTripList({
  proposals,
  packageId,
  revision,
  tokenLabelOf,
  reviewLink,
}: {
  proposals: readonly Proposal[]
  packageId: string
  revision: number
  tokenLabelOf?: (principalId: string) => string | undefined
  reviewLink: (proposalId: string) => ReactNode
}) {
  const { linked, unlinked } = roundTripProposals(proposals, { id: packageId, revision })
  if (linked.length === 0 && unlinked.length === 0) {
    return (
      <EmptyState icon={<Inbox />} title="Nothing back yet" className="py-8">
        When the agent calls propose_change with this package, its proposal appears here for review.
      </EmptyState>
    )
  }
  return (
    <>
      <ProposalRows proposals={linked} tokenLabelOf={tokenLabelOf} reviewLink={reviewLink} />
      {unlinked.length > 0 && (
        <>
          <p className="border-border border-y bg-surface-2 px-4 py-1.5 text-fg-muted text-xs">
            Also pending at r{revision} without a package
          </p>
          <ProposalRows proposals={unlinked} tokenLabelOf={tokenLabelOf} reviewLink={reviewLink} />
        </>
      )}
    </>
  )
}

function ProposalRows({
  proposals,
  tokenLabelOf,
  reviewLink,
}: {
  proposals: readonly Proposal[]
  tokenLabelOf?: ((principalId: string) => string | undefined) | undefined
  reviewLink: (proposalId: string) => ReactNode
}) {
  if (proposals.length === 0) return null
  return (
    <ul className="divide-y divide-border">
      {proposals.map((p) => {
        const via = tokenLabelOf?.(p.proposedBy)
        return (
          <li key={p.id} className="space-y-1 px-4 py-2.5">
            <p className="line-clamp-2 break-words font-medium text-sm" title={p.rationale}>
              {p.rationale}
            </p>
            <p className="flex flex-wrap items-center gap-1.5 text-fg-muted text-xs">
              <OriginBadge origin={p.origin} size="sm" />
              {hasMockOutput(p.ops) && <MockBadge size="sm" />}
              <span>
                {via ? (
                  <>
                    via token <span className="font-medium text-fg">{via}</span>
                  </>
                ) : (
                  <>
                    by <span className="font-mono">{shortId(p.proposedBy)}</span>
                  </>
                )}
              </span>
              <span>{plural(p.ops.length, 'operation')}</span>
              <time dateTime={p.createdAt} title={absoluteTime(p.createdAt)}>
                {relativeTime(p.createdAt)}
              </time>
              <span className="ml-auto">{reviewLink(p.id)}</span>
            </p>
          </li>
        )
      })}
    </ul>
  )
}

export function ReviewLinkLabel() {
  return (
    <span className="inline-flex items-center gap-0.5">
      Review in Proposals <ArrowRight aria-hidden className="size-3" />
    </span>
  )
}
