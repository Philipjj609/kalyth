import type {
  DecisionSummary,
  NavigatorRun,
  ObjectVersion,
  Proposal,
  RelationVersion,
} from '@kalyth/contracts'

/**
 * The change thread (ADR 0020): one change request followed from the question to reconciliation.
 * A change is a decision once a person commits the Navigator's proposal, and before that the run
 * whose proposal awaits review. Pure functions, unit-tested without a DOM.
 */

export type ChangeRef = { kind: 'decision'; id: string } | { kind: 'run'; id: string }

export interface ChangeItem {
  ref: ChangeRef
  title: string
  /** One line on where it stands, for the rail and the palette. */
  status: string
  /** Changes that need a person come first. */
  needsYou: boolean
  /** For sorting, newest first within a group. */
  sortKey: string
}

/** The open questions about a decision or one of its alternatives, from the model. */
export function openQuestions(
  model:
    | { objectById: ReadonlyMap<string, ObjectVersion>; relations: readonly RelationVersion[] }
    | undefined,
  decisionId: string,
): ObjectVersion[] {
  if (!model) return []
  const about = new Set([decisionId])
  for (const r of model.relations) {
    if (r.type === 'alternativeOf' && r.to === decisionId && r.lifecycle === 'active')
      about.add(r.from)
  }
  const seen = new Set<string>()
  const out: ObjectVersion[] = []
  for (const r of model.relations) {
    if (r.type !== 'concerns' || !about.has(r.to) || r.lifecycle !== 'active' || seen.has(r.from))
      continue
    const q = model.objectById.get(r.from)
    const status = (q?.attributes as Record<string, unknown> | undefined)?.status ?? 'open'
    if (q?.type === 'core.Question' && q.lifecycle === 'active' && status === 'open') {
      seen.add(r.from)
      out.push(q)
    }
  }
  return out
}

/** The run whose proposal created the decision, if it is in the list. */
export function runOfDecision(
  decisionId: string,
  runs: readonly NavigatorRun[],
  proposals: readonly Proposal[],
): NavigatorRun | undefined {
  const proposal = proposals.find((p) =>
    p.ops.some(
      (op) => op.op === 'createObject' && op.type === 'core.Decision' && op.id === decisionId,
    ),
  )
  if (!proposal) return undefined
  return runs.find((r) => r.proposalId === proposal.id)
}

/** Alternatives runs whose proposal still waits for a person, newest first. */
export function pendingRuns(
  runs: readonly NavigatorRun[],
  proposals: readonly Proposal[],
): NavigatorRun[] {
  const pending = new Set(proposals.filter((p) => p.status === 'pending').map((p) => p.id))
  return runs
    .filter(
      (r) =>
        r.input.kind === 'alternatives' &&
        !r.input.decisionId &&
        r.status === 'completed' &&
        r.proposalId !== null &&
        pending.has(r.proposalId),
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

export function decisionStatusLine(d: DecisionSummary, questionsOpen: number): string {
  const { implementation, verification, freshness } = d.facets
  const parts: string[] = []
  if (d.status === 'open') {
    parts.push(
      `Open · ${d.alternatives.length} alternative${d.alternatives.length === 1 ? '' : 's'}`,
    )
    if (questionsOpen > 0)
      parts.push(`${questionsOpen} question${questionsOpen === 1 ? '' : 's'} open`)
  } else {
    parts.push(d.status[0]?.toUpperCase() + d.status.slice(1))
    if (implementation.state !== 'none')
      parts.push(IMPLEMENTATION_SHORT[implementation.state] ?? implementation.state)
    if (verification.state === 'passed') parts.push('verified')
    else if (verification.state === 'failed') parts.push('verification failed')
  }
  const moved = freshness.stale.filter((c) => !c.byVerifiedWork).length
  if (moved > 0) parts.push(`${moved} stale`)
  else if (freshness.status === 'stale') parts.push('evidence moved by the work')
  return parts.join(' · ')
}

const IMPLEMENTATION_SHORT: Record<string, string> = {
  planned: 'task planned',
  'in-progress': 'agent working',
  reported: 'task in review',
  partial: 'partly done',
  complete: 'done',
}

/**
 * The changes in a project for the rail: runs awaiting review, then open decisions, then the rest.
 * `questionsOpen` counts a decision's open questions (they live in the model, not the summary).
 */
export function changeItems(
  decisions: readonly DecisionSummary[],
  runs: readonly NavigatorRun[],
  proposals: readonly Proposal[],
  questionsOpen: (decisionId: string) => number,
): ChangeItem[] {
  const fromRuns: ChangeItem[] = pendingRuns(runs, proposals).map((r) => ({
    ref: { kind: 'run', id: r.id },
    title: r.input.kind === 'alternatives' ? r.input.request : 'Navigator run',
    status: 'Proposed · review the alternatives',
    needsYou: true,
    sortKey: r.startedAt,
  }))
  const fromDecisions: ChangeItem[] = decisions.map((d) => {
    const open = questionsOpen(d.id)
    const stale = d.facets.freshness.stale.some((c) => !c.byVerifiedWork)
    const review = d.facets.implementation.state === 'reported'
    return {
      ref: { kind: 'decision', id: d.id },
      title: d.title || d.question,
      status: decisionStatusLine(d, open),
      needsYou: d.status === 'open' || stale || review,
      sortKey: d.id,
    }
  })
  const rank = (c: ChangeItem) => (c.ref.kind === 'run' ? 0 : c.needsYou ? 1 : 2)
  return [...fromRuns, ...fromDecisions].sort(
    (a, b) => rank(a) - rank(b) || (a.sortKey < b.sortKey ? 1 : -1),
  )
}

// ---------- the next step ----------

export interface NextStep {
  /** What the person should do now, in one sentence. */
  text: string
  /** Why it matters, when that is not obvious. */
  detail?: string
  /** The stage the step belongs to; the thread scrolls to it. */
  stage: Stage
  tone: 'action' | 'attention' | 'done'
}

export const STAGES = [
  'ask',
  'alternatives',
  'questions',
  'decide',
  'handoff',
  'work',
  'reconcile',
] as const
export type Stage = (typeof STAGES)[number]

export interface ThreadState {
  decision: DecisionSummary
  /** Open questions that decide between alternatives (blocking or decision-sensitive). */
  decisiveOpen: number
  questionsOpen: number
  /** A context package was compiled for the decision. */
  hasPackage: boolean
  /** Tasks for the decision that are still proposed, so no agent can claim them yet. */
  proposedTasks?: number
}

/**
 * The single most useful next action for a decision, from its status and facets (ADR 0023). Stale
 * evidence comes first: nothing should be handed off or completed on knowledge that changed.
 */
export function nextStep(s: ThreadState): NextStep {
  const d = s.decision
  const { freshness, implementation, verification } = d.facets
  if (freshness.status === 'stale') {
    const moved = freshness.stale.filter((c) => !c.byVerifiedWork).length
    if (moved > 0) {
      return {
        text: `Review ${moved} change${moved === 1 ? '' : 's'} whose evidence moved`,
        detail:
          'The source changed since these were proposed. Check them before you rely on the decision or hand it off.',
        stage: d.status === 'open' ? 'alternatives' : 'decide',
        tone: 'attention',
      }
    }
    // Every stale change cites a file the verified work changed: the work landing moved them.
    if (implementation.state === 'reported') {
      const n = freshness.stale.length
      return {
        text: 'Check the work against the decision, then complete the task',
        detail: `The task’s verified commit changed the files behind ${n} change${n === 1 ? '' : 's'}, so the excerpts they cite show the code before it. Reconciling shows what the source says now.`,
        stage: 'reconcile',
        tone: 'action',
      }
    }
  }
  if (d.status === 'open') {
    if (d.alternatives.length === 0) {
      return { text: 'Ask the Navigator for alternatives', stage: 'ask', tone: 'action' }
    }
    if (s.decisiveOpen > 0) {
      return {
        text:
          s.decisiveOpen === 1
            ? 'Answer the question that decides between the alternatives'
            : `Answer ${s.decisiveOpen} questions that decide between the alternatives`,
        detail: 'Or compare them and accept one now; open questions travel with the decision.',
        stage: 'questions',
        tone: 'action',
      }
    }
    return { text: 'Compare the alternatives and accept one', stage: 'decide', tone: 'action' }
  }
  if (d.status !== 'accepted') {
    return { text: `This decision is ${d.status}`, stage: 'decide', tone: 'done' }
  }
  switch (implementation.state) {
    case 'none':
      return {
        text: s.hasPackage
          ? 'Create the task for a coding agent'
          : 'Hand off: compile a context package and create a task',
        stage: 'handoff',
        tone: 'action',
      }
    case 'planned':
      if ((s.proposedTasks ?? 0) > 0) {
        return {
          text: 'Mark the task ready for a coding agent',
          detail:
            'Agents cannot claim a proposed task. Once it is ready, copy its prompt into Claude Code or Codex connected over MCP.',
          stage: 'work',
          tone: 'action',
        }
      }
      return {
        text: 'Give the task to a coding agent',
        detail:
          'Copy the task prompt into Claude Code or Codex connected over MCP, or do the work yourself.',
        stage: 'work',
        tone: 'action',
      }
    case 'in-progress':
      return { text: 'An agent is working on the task', stage: 'work', tone: 'done' }
    case 'reported':
      return {
        text: 'Review the agent’s report and its verification',
        detail:
          verification.state === 'failed'
            ? 'Git did not confirm the latest report.'
            : 'Then complete the task, or return it with a note.',
        stage: 'work',
        tone: 'action',
      }
    case 'partial':
      return {
        text: 'Part of the work is done; finish or plan the rest',
        stage: 'work',
        tone: 'action',
      }
    case 'complete':
      return {
        text: 'Reconcile the model with what was built',
        detail:
          'Re-analyse the repository at the task commit, so the model shows the change as observed.',
        stage: 'reconcile',
        tone: 'action',
      }
  }
  return { text: 'Nothing waits on you', stage: 'decide', tone: 'done' }
}

// ---------- reading what the model wrote ----------

export type Level = 'low' | 'medium' | 'high'

export const TRADEOFF_KEYS = [
  ['Cost', 'cost'],
  ['Risk', 'risk'],
  ['Reversibility', 'reversibility'],
  ['Migration', 'migration effort'],
  ['Operations', 'operational burden'],
] as const

/**
 * Trade-off levels from the model's free text ("Cost: high — ..."). Only an explicit level after
 * the name counts; anything else stays unknown rather than guessed.
 */
export function tradeoffLevels(text: string | null): { label: string; level: Level | null }[] {
  const t = (text ?? '').toLowerCase()
  return TRADEOFF_KEYS.map(([label, key]) => {
    const m = new RegExp(`${key}\\s*:\\s*(low|medium|high)\\b`).exec(t)
    return { label, level: (m?.[1] as Level | undefined) ?? null }
  })
}

/**
 * The first one or two sentences of a summary, for a card's lead. A sentence ends at a stop
 * followed by a space, so a dotted name such as `app.current_org_id` stays inside its sentence.
 */
export function lead(summary: string, sentences = 2): string {
  return summary
    .trim()
    .split(/(?<=[.!?])\s+/)
    .slice(0, sentences)
    .join(' ')
}

/** The alternative accepted on a decision, if any. */
export function acceptedAlternative(d: DecisionSummary) {
  return d.alternatives.find((a) => a.status === 'accepted')
}
