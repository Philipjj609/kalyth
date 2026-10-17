import type {
  Claim,
  ImpactResult,
  NavigatorRun,
  NavigatorStatus,
  ResolvedOperation,
} from '@kalyth/contracts'
import { claim } from './records.ts'

/** Navigator fixtures: ids that look real, a mock-provider status, runs and proposals. */
const hex = (n: number) => n.toString(16).padStart(32, '0')
export const id = (prefix: string, n: number) => `${prefix}_${hex(n)}`

export const PROJECT = id('prj', 1)
export const PERSON = id('pcp', 2)

export function navigatorStatus(overrides: Partial<NavigatorStatus> = {}): NavigatorStatus {
  return {
    provider: { id: 'mock', external: false, paid: false },
    models: { summarize: 'mock-small', alternatives: 'mock-large' },
    budget: {
      capMicroUsd: 0,
      capNote: null,
      capSetAt: null,
      spentMicroUsd: 0,
      reservedMicroUsd: 0,
      remainingMicroUsd: 0,
      calls: 0,
      thresholds: [
        { fraction: 0.5, reached: false },
        { fraction: 0.8, reached: false },
      ],
    },
    consent: { required: false, granted: false, grantedBy: null, grantedAt: null },
    ...overrides,
  }
}

export function navigatorRun(overrides: Partial<NavigatorRun> = {}): NavigatorRun {
  return {
    id: id('nav', 1),
    projectId: PROJECT,
    input: { kind: 'alternatives', projectId: PROJECT, request: 'add multi-tenancy', focus: [] },
    status: 'running',
    requestedBy: PERSON,
    baseRevision: 4,
    startedAt: '2026-10-16T10:00:00.000Z',
    finishedAt: null,
    calls: [],
    costMicroUsd: 0,
    grounding: null,
    output: null,
    proposalId: null,
    error: null,
    ...overrides,
  }
}

const inferred = (provider: string, evidence: string[][] = []): Claim =>
  claim('inferred', {
    method: 'navigator.alternatives',
    model: { provider, model: `${provider}-large` },
    confidence: { level: 'medium', rationale: 'Two modules already scope by owner.' },
    supports: evidence.map((allOf) => ({ allOf })),
  })

/** Existing elements the alternatives refer to. */
export const ITEM = id('obj', 101)
export const MODELS_PY = id('obj', 102)
export const CRUD_PY = id('obj', 103)

export const DECISION = id('obj', 201)
export const ALT_A = id('obj', 202)
export const ALT_B = id('obj', 203)
export const QUESTION = id('obj', 204)

/**
 * The resolved operations of an alternatives run's proposal (ADR 0010), deliberately not in
 * the order a reader wants: relations before some objects, and an alternative before the decision.
 */
export function alternativesOps(provider = 'mock'): ResolvedOperation[] {
  const c = (evidence: string[][] = []) => inferred(provider, evidence)
  return [
    {
      op: 'createObject',
      id: ALT_B,
      type: 'core.Alternative',
      stance: 'toBe',
      attributes: {
        title: 'Database per tenant',
        summary: 'One database each.',
        tradeoffs: 'Costly.',
      },
      claim: c(),
    },
    {
      op: 'createObject',
      id: DECISION,
      type: 'core.Decision',
      stance: 'toBe',
      attributes: { title: 'Tenancy model', question: 'How should tenants be isolated?' },
      claim: c(),
    },
    {
      op: 'createObject',
      id: ALT_A,
      type: 'core.Alternative',
      stance: 'toBe',
      attributes: {
        title: 'Tenant column',
        summary: 'Add tenant_id to every table.',
        tradeoffs: 'Cheap; every query must filter.',
      },
      claim: c([[id('evd', 1), id('evd', 2)], [id('evd', 3)]]),
    },
    {
      op: 'createRelation',
      id: id('rel', 301),
      type: 'alternativeOf',
      from: ALT_A,
      to: DECISION,
      stance: 'toBe',
      properties: {},
      claim: c(),
    },
    {
      op: 'createRelation',
      id: id('rel', 302),
      type: 'alternativeOf',
      from: ALT_B,
      to: DECISION,
      stance: 'toBe',
      properties: {},
      claim: c(),
    },
    {
      op: 'createRelation',
      id: id('rel', 303),
      type: 'impacts',
      from: ALT_A,
      to: ITEM,
      stance: 'toBe',
      properties: { change: 'Add a tenant_id column.' },
      claim: c([[id('evd', 1)]]),
    },
    {
      op: 'createRelation',
      id: id('rel', 304),
      type: 'impacts',
      from: ALT_A,
      to: MODELS_PY,
      stance: 'toBe',
      properties: { change: 'Filter by tenant in the base query.' },
      claim: c([[id('evd', 2), id('evd', 4)]]),
    },
    {
      op: 'createObject',
      id: QUESTION,
      type: 'core.Question',
      stance: 'asIs',
      attributes: { text: 'Do tenants share users?', inquiryRole: 'blocking', status: 'open' },
      claim: c(),
    },
    {
      op: 'createRelation',
      id: id('rel', 305),
      type: 'concerns',
      from: QUESTION,
      to: DECISION,
      stance: 'asIs',
      properties: {},
      claim: c(),
    },
  ]
}

/**
 * Impact from Item (a data entity): its defining module, then a module that depends on it.
 * Labels come from the result itself.
 */
export function impactResult(): ImpactResult {
  const contains = {
    relationId: id('rel', 401),
    type: 'contains',
    from: ITEM,
    to: MODELS_PY,
    direction: 'reverse' as const,
    rule: 'definition' as const,
  }
  const dependsOn = {
    relationId: id('rel', 402),
    type: 'dependsOn',
    from: MODELS_PY,
    to: CRUD_PY,
    direction: 'reverse' as const,
    rule: 'relation' as const,
  }
  return {
    projectId: PROJECT,
    revision: 4,
    seeds: [ITEM],
    truncated: false,
    elements: [
      { id: ITEM, type: 'software.DataEntity', label: 'Item', depth: 0, seed: ITEM, path: [] },
      {
        id: CRUD_PY,
        type: 'software.Module',
        label: 'app/crud.py',
        depth: 2,
        seed: ITEM,
        path: [contains, dependsOn],
      },
      {
        id: MODELS_PY,
        type: 'software.Module',
        label: 'app/models.py',
        depth: 1,
        seed: ITEM,
        path: [contains],
      },
    ],
  }
}
