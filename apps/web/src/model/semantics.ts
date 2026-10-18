import type { Basis, InstructionOrigin, Lifecycle, ProposalStatus, Stance } from '@kalyth/contracts'
import type { FreshnessStatus } from '../api/freshness.ts'
import { humanize, typeParts } from './format.ts'

/**
 * The visual language for epistemic and review status. Every status has a text label and a
 * description; colour (tone) and line pattern only reinforce the label, never replace it.
 * Tones map to CSS classes `tone-<name>` that set --tone-fg, --tone-bg and --tone-bd.
 */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'caution'
  | 'danger'
  | 'observed'
  | 'inferred'
  | 'stated'
  | 'imported'

export interface StatusMeta {
  label: string
  tone: Tone
  description: string
}

/** SVG dash patterns per basis; also used for node borders. undefined is a solid line. */
export interface BasisMeta extends StatusMeta {
  short: string
  dash: string | undefined
  border: 'solid' | 'dashed' | 'dotted' | 'double'
}

export const BASIS_META: Record<Basis, BasisMeta> = {
  observed: {
    label: 'Observed',
    short: 'obs',
    tone: 'observed',
    dash: undefined,
    border: 'solid',
    description:
      'A tool saw this in pinned source, within the coverage it states. A fact about the source, not runtime verification.',
  },
  inferred: {
    label: 'Inferred',
    short: 'inf',
    tone: 'inferred',
    dash: '7 5',
    border: 'dashed',
    description: 'A hypothesis from a model or heuristic, with a stated confidence and rationale.',
  },
  stated: {
    label: 'Stated',
    short: 'sta',
    tone: 'stated',
    dash: '1.5 4.5',
    border: 'dotted',
    description: 'Asserted by a principal, usually a person.',
  },
  imported: {
    label: 'Imported',
    short: 'imp',
    tone: 'imported',
    dash: '12 4 2 4',
    border: 'double',
    description: 'Taken from an external document or tool, with provenance.',
  },
}

export const BASIS_ORDER: readonly Basis[] = ['observed', 'inferred', 'stated', 'imported']

export function basisMeta(basis: string): BasisMeta {
  return (
    BASIS_META[basis as Basis] ?? {
      label: humanize(basis || 'unknown'),
      short: '?',
      tone: 'neutral',
      dash: '2 3',
      border: 'dashed',
      description: 'A basis this version of the UI does not know.',
    }
  )
}

export const FRESHNESS_META: Record<FreshnessStatus, StatusMeta> = {
  current: {
    label: 'Current',
    tone: 'success',
    description: 'At least one evidence group still matches the latest source snapshot.',
  },
  weakened: {
    label: 'Weakened',
    tone: 'warning',
    description: 'Some supporting evidence changed, but an alternative evidence group still holds.',
  },
  stale: {
    label: 'Stale',
    tone: 'danger',
    description: 'Every evidence group has at least one item that changed in the latest snapshot.',
  },
  'derived-stale': {
    label: 'Derived stale',
    tone: 'caution',
    description: 'A claim this one derives from is stale.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'neutral',
    description: 'Freshness could not be determined, for example outside snapshot coverage.',
  },
  'not-applicable': {
    label: 'N/A',
    tone: 'neutral',
    description: 'Freshness does not apply, for example to stated claims without source evidence.',
  },
}

export const PROPOSAL_STATUS_META: Record<ProposalStatus, StatusMeta> = {
  pending: {
    label: 'Pending',
    tone: 'warning',
    description: 'Waiting for a person to commit or reject it.',
  },
  committed: {
    label: 'Committed',
    tone: 'success',
    description: 'Applied; it produced a revision.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'neutral',
    description: 'A person declined it. It stays readable.',
  },
  invalid: {
    label: 'Invalid',
    tone: 'danger',
    description: 'It failed validation when it was submitted.',
  },
  stale: {
    label: 'Stale',
    tone: 'caution',
    description: 'State it relied on changed after its base revision. Re-read and propose again.',
  },
  conflicting: {
    label: 'Conflicting',
    tone: 'danger',
    description: 'Valid alone, but it violates an invariant at the current head.',
  },
}

export const PROPOSAL_STATUS_ORDER: readonly ProposalStatus[] = [
  'pending',
  'committed',
  'rejected',
  'invalid',
  'stale',
  'conflicting',
]

export const ORIGIN_META: Record<InstructionOrigin, StatusMeta> = {
  human: {
    label: 'Human',
    tone: 'accent',
    description: 'A person acting directly in a first-party interface.',
  },
  agent: { label: 'Agent', tone: 'neutral', description: 'A coding agent, for example over MCP.' },
  model: { label: 'Model', tone: 'neutral', description: 'Text computed by a model.' },
  tool: {
    label: 'Tool',
    tone: 'neutral',
    description: 'A deterministic tool such as the analyzer.',
  },
  relayed: {
    label: 'Relayed',
    tone: 'caution',
    description: 'Relayed from external content; it never carries a person’s authority.',
  },
}

export const STANCE_META: Record<Stance, StatusMeta> = {
  asIs: { label: 'As-is', tone: 'neutral', description: 'Describes existing reality.' },
  toBe: { label: 'To-be', tone: 'accent', description: 'Describes an intended design.' },
}

export const LIFECYCLE_META: Record<Lifecycle, StatusMeta> = {
  active: { label: 'Active', tone: 'neutral', description: 'Current in this revision.' },
  retired: {
    label: 'Retired',
    tone: 'neutral',
    description: 'No longer current; kept for history.',
  },
}

export const DECISION_STATUS_TONE: Record<string, Tone> = {
  open: 'warning',
  accepted: 'success',
  rejected: 'neutral',
  deferred: 'neutral',
  superseded: 'neutral',
  proposed: 'warning',
  withdrawn: 'neutral',
}

// ---------- relation and object types ----------

export interface RelationTypeMeta {
  label: string
  /** CSS custom property holding the stroke colour. */
  color: string
  description: string
}

const RELATION_DESCRIPTIONS: Record<string, string> = {
  contains: 'Structural containment',
  dependsOn: 'The source uses the target',
  exposes: 'The source provides the target interface',
  reads: 'The source reads the target data',
  writes: 'The source writes the target data',
  realizes: 'Implements an intended element or requirement',
  satisfies: 'Meets the target requirement',
  constrains: 'The constraint limits the target',
  decides: 'The decision determines the target',
  alternativeOf: 'A candidate answer to the decision',
  supersedes: 'Replaces the target decision',
  contradicts: 'The two claims cannot both hold',
  precedes: 'Temporal order',
  verifies: 'The verification checked the target',
  concerns: 'The question or assertion is about the target',
  implements: 'The task carries out the target decision, alternative or requirement',
  requires: 'The task can start only when the target is completed or accepted',
  reports: 'The execution report is about the target task',
}

const KNOWN_RELATION_COLORS = new Set([
  'contains',
  'dependsOn',
  'exposes',
  'reads',
  'writes',
  'realizes',
  'satisfies',
  'constrains',
  'decides',
  'alternativeOf',
  'concerns',
])

export function relationMeta(type: string): RelationTypeMeta {
  return {
    label: type,
    color: KNOWN_RELATION_COLORS.has(type) ? `var(--k-rel-${type})` : 'var(--k-rel-other)',
    description:
      RELATION_DESCRIPTIONS[type] ?? 'A relation type this version of the UI does not know.',
  }
}

/** Object type accents (CSS custom properties) and display order; unknown types sort last. */
const OBJECT_TYPE_ORDER = [
  'software.System',
  'software.Container',
  'software.Component',
  'software.Module',
  'software.Endpoint',
  'software.DataEntity',
  'software.Library',
  'core.SourceSnapshot',
  'core.Decision',
  'core.Alternative',
  'core.Requirement',
  'core.Constraint',
  'core.Question',
  'core.Assertion',
  'core.Verification',
  'core.Task',
  'core.ExecutionReport',
]

const OBJECT_TYPE_ACCENT: Record<string, string> = {
  'software.System': 'system',
  'software.Container': 'container',
  'software.Component': 'container',
  'software.Module': 'module',
  'software.Endpoint': 'endpoint',
  'software.DataEntity': 'data',
  'software.Library': 'library',
  'core.SourceSnapshot': 'snapshot',
  'core.Decision': 'decision',
  'core.Alternative': 'decision',
  'core.Requirement': 'requirement',
  'core.Constraint': 'requirement',
}

export function objectTypeMeta(type: string): { label: string; accent: string; rank: number } {
  const index = OBJECT_TYPE_ORDER.indexOf(type)
  return {
    label: humanize(typeParts(type).name),
    accent: `var(--k-type-${OBJECT_TYPE_ACCENT[type] ?? 'other'})`,
    rank: index < 0 ? OBJECT_TYPE_ORDER.length : index,
  }
}

export function compareTypes(a: string, b: string): number {
  return objectTypeMeta(a).rank - objectTypeMeta(b).rank || a.localeCompare(b)
}
