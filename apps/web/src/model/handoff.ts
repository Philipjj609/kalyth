import type {
  AgentTokenSummary,
  ContextItem,
  ContextPackage,
  DecisionSummary,
  ImpactedElement,
  Proposal,
} from '@kalyth/contracts'
import type { CompileContextBody } from '../api/client.ts'
import { plural, shortId } from './format.ts'
import { impactPathText } from './navigator.ts'
import type { Tone } from './semantics.ts'

/**
 * Pure display and request logic for handing work to a coding agent (ADR 0011): the draft a person
 * edits, the compile request it becomes, how a package's sections are grouped, the setup snippets
 * and the prompt. Package content is data written by tools, models and people; the UI renders it
 * as text only.
 */

// ---------- limits (mirroring the contracts) ----------

export const MAX_CHARS = { min: 4_000, max: 400_000, default: 60_000, step: 1_000 } as const
export const MAX_FOCUS = 50
export const MAX_TITLE = 300
export const MAX_CRITERIA = 20
export const MAX_CRITERION = 1_000
export const TOKEN_LABEL_MAX = 120
export const TOKEN_DAYS = { min: 1, max: 30, default: 7 } as const

/** A rough token count for a size in characters: about four characters per token. */
export const approxTokens = (chars: number): number => Math.round(chars / 4)

/** "60,000 characters (≈ 15,000 tokens)". */
export function sizeText(chars: number): string {
  return `${plural(chars, 'character')} (≈ ${approxTokens(chars).toLocaleString('en')} tokens)`
}

// ---------- the draft: what to hand off ----------

export type FocusMode = 'decision' | 'elements'

export interface HandoffDraft {
  mode: FocusMode
  decisionId: string | null
  elements: string[]
  title: string
  /** The title last filled in from a decision; the next choice replaces it unless it was edited. */
  prefilledTitle: string
  criteria: string[]
  maxChars: number
}

export const EMPTY_DRAFT: HandoffDraft = {
  mode: 'decision',
  decisionId: null,
  elements: [],
  title: '',
  prefilledTitle: '',
  criteria: [],
  maxChars: MAX_CHARS.default,
}

export type DraftAction =
  | { type: 'mode'; mode: FocusMode }
  | { type: 'chooseDecision'; decision: Pick<DecisionSummary, 'id' | 'title'> }
  | { type: 'elements'; elements: string[] }
  | { type: 'title'; title: string }
  | { type: 'addCriterion'; text: string }
  | { type: 'editCriterion'; index: number; text: string }
  | { type: 'removeCriterion'; index: number }
  | { type: 'moveCriterion'; index: number; by: -1 | 1 }
  | { type: 'maxChars'; value: number }

export function draftReducer(draft: HandoffDraft, action: DraftAction): HandoffDraft {
  switch (action.type) {
    case 'mode':
      return { ...draft, mode: action.mode }
    case 'chooseDecision': {
      const untouched = draft.title.trim() === '' || draft.title === draft.prefilledTitle
      const title = action.decision.title.slice(0, MAX_TITLE)
      return {
        ...draft,
        mode: 'decision',
        decisionId: action.decision.id,
        ...(untouched ? { title, prefilledTitle: title } : {}),
      }
    }
    case 'elements':
      return { ...draft, elements: [...new Set(action.elements)].slice(0, MAX_FOCUS) }
    case 'title':
      return { ...draft, title: action.title }
    case 'addCriterion': {
      const text = action.text.trim()
      if (!text || draft.criteria.length >= MAX_CRITERIA) return draft
      return { ...draft, criteria: [...draft.criteria, text.slice(0, MAX_CRITERION)] }
    }
    case 'editCriterion':
      return {
        ...draft,
        criteria: draft.criteria.map((c, i) => (i === action.index ? action.text : c)),
      }
    case 'removeCriterion':
      return { ...draft, criteria: draft.criteria.filter((_, i) => i !== action.index) }
    case 'moveCriterion': {
      const to = action.index + action.by
      if (to < 0 || to >= draft.criteria.length) return draft
      const criteria = [...draft.criteria]
      const [moved] = criteria.splice(action.index, 1)
      criteria.splice(to, 0, moved as string)
      return { ...draft, criteria }
    }
    case 'maxChars':
      return { ...draft, maxChars: action.value }
  }
}

/** The ids the package is about: the chosen decision, or the picked elements. */
export function draftFocus(draft: HandoffDraft): string[] {
  if (draft.mode === 'decision') return draft.decisionId ? [draft.decisionId] : []
  return draft.elements
}

const filledCriteria = (draft: HandoffDraft) =>
  draft.criteria.map((c) => c.trim()).filter((c) => c !== '')

/** Why the draft cannot be compiled yet, as sentences; empty when it can. */
export function draftProblems(draft: HandoffDraft): string[] {
  const problems: string[] = []
  if (draftFocus(draft).length === 0) {
    problems.push(
      draft.mode === 'decision' ? 'Choose an accepted decision.' : 'Pick at least one element.',
    )
  }
  const title = draft.title.trim()
  if (title.length > MAX_TITLE) problems.push(`Keep the task title to ${MAX_TITLE} characters.`)
  if (!title && filledCriteria(draft).length > 0) {
    problems.push('Acceptance criteria need a task title.')
  }
  if (
    !Number.isInteger(draft.maxChars) ||
    draft.maxChars < MAX_CHARS.min ||
    draft.maxChars > MAX_CHARS.max
  ) {
    problems.push(
      `Set a size limit from ${MAX_CHARS.min.toLocaleString('en')} to ${MAX_CHARS.max.toLocaleString('en')} characters.`,
    )
  }
  return problems
}

/** The POST /context body for a draft. A task is sent only when it has a title. */
export function compileBody(draft: HandoffDraft): CompileContextBody {
  const title = draft.title.trim()
  return {
    focus: draftFocus(draft),
    maxChars: draft.maxChars,
    ...(title ? { task: { title, acceptanceCriteria: filledCriteria(draft) } } : {}),
  }
}

/** One compile body per suggested split of a blocked package, with the same task and limit. */
export function splitBodies(
  pkg: Pick<ContextPackage, 'blocked' | 'task' | 'size'>,
): CompileContextBody[] {
  return (pkg.blocked?.splits ?? []).map((focus) => ({
    focus,
    maxChars: pkg.size.maxChars,
    ...(pkg.task ? { task: pkg.task } : {}),
  }))
}

export function acceptedAlternatives(
  decision: Pick<DecisionSummary, 'alternatives'>,
): DecisionSummary['alternatives'] {
  return decision.alternatives.filter((a) => a.status === 'accepted')
}

// ---------- reading a package ----------

/** Labels for ids a package mentions: its own items first, then the model's names, then ids. */
export function packageLabeller(
  pkg: Pick<ContextPackage, 'mandatory' | 'items'>,
  nameOf: (id: string) => string | undefined,
): (id: string) => string {
  const labels = new Map<string, string>()
  const { invariants, constraints, decisions } = pkg.mandatory
  for (const item of [...invariants, ...constraints, ...decisions, ...pkg.items]) {
    if (item.kind === 'object' && item.label) labels.set(item.id, item.label)
  }
  return (id) => labels.get(id) || nameOf(id) || shortId(id)
}

/** A string attribute of an item (or a relation property), or '' when absent. */
export function itemText(item: Pick<ContextItem, 'attributes'>, key: string): string {
  const v = item.attributes[key]
  return typeof v === 'string' ? v : ''
}

export interface AlternativeGroup {
  alternative: ContextItem | null
  changes: ContextItem[]
}

export interface DecisionGroup {
  decision: ContextItem | null
  alternatives: AlternativeGroup[]
}

/**
 * The mandatory decisions section is one list in compiler order: each decision, then its accepted
 * alternatives, each followed by its direct changes. Groups them back, matching a direct change to
 * its alternative by the relation's source; anything out of place is kept, never dropped.
 */
export function groupDecisions(items: readonly ContextItem[]): DecisionGroup[] {
  const groups: DecisionGroup[] = []
  const current = (): DecisionGroup => {
    const last = groups.at(-1)
    if (last) return last
    const group: DecisionGroup = { decision: null, alternatives: [] }
    groups.push(group)
    return group
  }
  for (const item of items) {
    if (item.role === 'decision') {
      groups.push({ decision: item, alternatives: [] })
    } else if (item.role === 'alternative') {
      current().alternatives.push({ alternative: item, changes: [] })
    } else {
      const group = current()
      const owner =
        group.alternatives.find((a) => a.alternative !== null && a.alternative.id === item.from) ??
        group.alternatives.at(-1)
      if (owner) owner.changes.push(item)
      else group.alternatives.push({ alternative: null, changes: [item] })
    }
  }
  return groups
}

export const OPTIONAL_ROLES = ['focus', 'question', 'impacted', 'dependency'] as const

export const ROLE_META: Record<string, { label: string; description: string }> = {
  focus: { label: 'Focus', description: 'The elements the task is about, with pinned excerpts.' },
  question: { label: 'Open questions', description: 'Open questions about the focus.' },
  impacted: {
    label: 'Impacted',
    description: 'Elements a change to the focus may reach, with the typed path that gets there.',
  },
  dependency: {
    label: 'Dependencies',
    description: 'What the focus elements depend on directly.',
  },
}

export interface RoleGroup {
  role: string
  items: ContextItem[]
}

/** Optional items by role, in the package's order (nearest first); unknown roles follow. */
export function groupItems(items: readonly ContextItem[]): RoleGroup[] {
  const byRole = new Map<string, ContextItem[]>()
  for (const item of items) byRole.set(item.role, [...(byRole.get(item.role) ?? []), item])
  const known: readonly string[] = OPTIONAL_ROLES
  const roles = [
    ...OPTIONAL_ROLES.filter((r) => byRole.has(r)),
    ...[...byRole.keys()].filter((r) => !known.includes(r)),
  ]
  return roles.map((role) => ({ role, items: byRole.get(role) ?? [] }))
}

/** An impacted item as an impact element: its path starts at the seed the change reaches it from. */
export function itemPathElement(
  item: Pick<ContextItem, 'id' | 'label' | 'path'>,
): Pick<ImpactedElement, 'seed' | 'path' | 'label'> {
  return { seed: item.path[0]?.from ?? item.id, path: item.path, label: item.label }
}

/** The typed path of an impacted item as text, in the Navigator's path notation. */
export function itemPathText(
  item: Pick<ContextItem, 'id' | 'label' | 'path'>,
  labelOf: (id: string) => string,
): string {
  return impactPathText(itemPathElement(item), labelOf)
}

/** An omission in plain words, e.g. "12 items left out at the size limit". */
export function omissionText(
  omission: Pick<ContextPackage['omissions'][number], 'reason' | 'count'>,
): string {
  if (omission.reason === 'size_limit') {
    return `${plural(omission.count, 'item')} left out at the size limit`
  }
  return omission.count > 0
    ? `${plural(omission.count, 'item')} left out at the traversal limit`
    : 'The traversal stopped at its limit, so more elements may be affected than are listed'
}

/** Share of the limit used, 0 to 1. */
export const sizeShare = (chars: number, maxChars: number): number =>
  maxChars > 0 ? Math.min(1, Math.max(0, chars / maxChars)) : 0

export const packageJson = (pkg: ContextPackage): string => `${JSON.stringify(pkg, null, 2)}\n`

// ---------- connecting an agent ----------

export const TOKEN_PLACEHOLDER = '<agent token>'
export const CODEX_TOKEN_ENV = 'KALYTH_AGENT_TOKEN'

/** The Streamable HTTP endpoint agents connect to: this page's origin plus /mcp. */
export const mcpUrl = (origin: string): string => `${origin.replace(/\/+$/, '')}/mcp`

const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Claude Code: adds the server with the token as a header (verified with `claude mcp list`). */
export function claudeCodeCommand(origin: string, token: string | null): string {
  return `claude mcp add --transport http kalyth ${mcpUrl(origin)} --header "Authorization: Bearer ${token ?? TOKEN_PLACEHOLDER}"`
}

/** Codex, in ~/.codex/config.toml. The token itself comes from an environment variable. */
export function codexConfig(origin: string): string {
  return [
    '[mcp_servers.kalyth]',
    `url = ${tomlString(mcpUrl(origin))}`,
    `bearer_token_env_var = ${tomlString(CODEX_TOKEN_ENV)}`,
    '',
  ].join('\n')
}

/** Sets the Codex token variable in the shell that runs Codex. */
export function codexEnvCommands(token: string | null): { posix: string; powershell: string } {
  const value = token ?? TOKEN_PLACEHOLDER
  return {
    posix: `export ${CODEX_TOKEN_ENV}="${value}"`,
    powershell: `$env:${CODEX_TOKEN_ENV} = "${value}"`,
  }
}

/** What to tell the agent: which package to read and the base revision to propose against. */
export function agentPrompt(pkg: Pick<ContextPackage, 'id' | 'revision'>): string {
  return `Use the kalyth MCP server. Call get_context_package with packageId ${pkg.id}, follow everything under mandatory, and propose your changes with propose_change at baseRevision ${pkg.revision}. A person reviews them in Kalyth.`
}

export type TokenState = 'active' | 'expired' | 'revoked'

export function tokenState(
  token: Pick<AgentTokenSummary, 'expiresAt' | 'revokedAt'>,
  now: number = Date.now(),
): TokenState {
  if (token.revokedAt !== null) return 'revoked'
  return Date.parse(token.expiresAt) <= now ? 'expired' : 'active'
}

export const TOKEN_STATE_META: Record<
  TokenState,
  { label: string; tone: Tone; description: string }
> = {
  active: {
    label: 'Active',
    tone: 'success',
    description: 'Accepted on /mcp until it expires or is revoked.',
  },
  expired: { label: 'Expired', tone: 'neutral', description: 'Past its expiry; refused.' },
  revoked: { label: 'Revoked', tone: 'neutral', description: 'Revoked by a person; refused.' },
}

// ---------- round trip ----------

/**
 * Pending proposals based on the package revision, newest first. A proposal does not record which
 * package it answers, so this is every pending proposal at that base revision.
 */
export function roundTripProposals(proposals: readonly Proposal[], revision: number): Proposal[] {
  return proposals
    .filter((p) => p.status === 'pending' && p.baseRevision === revision)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

/** The label of the agent token whose principal made a proposal, when it is one of these. */
export function tokenLabeller(
  tokens: readonly Pick<AgentTokenSummary, 'principalId' | 'label'>[] | undefined,
): (principalId: string) => string | undefined {
  const labels = new Map((tokens ?? []).map((t) => [t.principalId, t.label]))
  return (principalId) => labels.get(principalId)
}
