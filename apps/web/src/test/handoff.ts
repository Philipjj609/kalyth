import type {
  AgentTokenSummary,
  ContextItem,
  ContextPackage,
  ContextPackageResult,
  DecisionSummary,
  ImpactStep,
  Proposal,
} from '@kalyth/contracts'
import {
  ALT_A,
  ALT_B,
  CRUD_PY,
  DECISION,
  ITEM,
  id,
  MODELS_PY,
  PERSON,
  PROJECT,
  QUESTION,
} from './navigator.ts'

/** Handoff fixtures (ADR 0011): a context package, decisions, agent tokens and proposals. */

export const PACKAGE_ID = `ctx_${'ab'.repeat(16)}`
export const INVARIANT = id('obj', 501)
export const CONSTRAINT = id('obj', 502)
export const LIB = id('obj', 503)
export const AGENT = id('pcp', 7)
export const TOKEN_ID = id('tok', 1)
export const OMITTED = [id('obj', 601), id('obj', 602), id('obj', 603)]

// Built at runtime so secret scanners do not mistake this fixture for a credential.
export const FAKE_AGENT_TOKEN = ['kalyth', 'at', `${'T'.repeat(21)}-${'q'.repeat(21)}`].join('_')

export function item(
  overrides: Partial<ContextItem> & Pick<ContextItem, 'id' | 'type' | 'label' | 'role'>,
): ContextItem {
  return {
    kind: 'object',
    distance: 0,
    stance: 'asIs',
    basis: 'observed',
    confidence: null,
    freshness: 'current',
    attributes: {},
    from: null,
    to: null,
    path: [],
    evidence: [],
    ...overrides,
  }
}

const contains: ImpactStep = {
  relationId: id('rel', 401),
  type: 'contains',
  from: ITEM,
  to: MODELS_PY,
  direction: 'reverse',
  rule: 'definition',
}
const dependsOn: ImpactStep = {
  relationId: id('rel', 402),
  type: 'dependsOn',
  from: MODELS_PY,
  to: CRUD_PY,
  direction: 'reverse',
  rule: 'relation',
}

/** A ready package for the accepted tenancy decision, with every section filled. */
export function readyPackage(overrides: Partial<ContextPackage> = {}): ContextPackage {
  return {
    id: PACKAGE_ID,
    sha256: 'ab'.repeat(32),
    projectId: PROJECT,
    revision: 7,
    snapshots: [{ repo: 'demo/fastapi-app', commit: '1a2b3c4d5e6f7a8b9c0d1e2f' }],
    focus: [DECISION],
    task: {
      title: 'Add tenant isolation',
      acceptanceCriteria: ['Every query filters by tenant', 'Existing tests pass'],
    },
    status: 'ready',
    blocked: null,
    mandatory: {
      invariants: [
        item({
          id: INVARIANT,
          type: 'core.Constraint',
          label: 'No plaintext secrets',
          role: 'invariant',
          basis: 'stated',
          freshness: 'not-applicable',
          attributes: {
            title: 'No plaintext secrets',
            statement: 'Secrets never reach logs or the database in plaintext.',
            severity: 'must',
            appliesTo: 'project',
          },
        }),
      ],
      constraints: [
        item({
          id: CONSTRAINT,
          type: 'core.Constraint',
          label: 'Queries filter by tenant',
          role: 'constraint',
          basis: 'stated',
          freshness: 'not-applicable',
          attributes: {
            title: 'Queries filter by tenant',
            statement: 'Every read is scoped to one tenant.',
            severity: 'should',
            appliesTo: 'elements',
          },
          evidence: [{ id: id('evd', 9), location: 'docs/tenancy.md (Scope)', excerpt: null }],
        }),
      ],
      decisions: [
        item({
          id: DECISION,
          type: 'core.Decision',
          label: 'Tenancy model',
          role: 'decision',
          stance: 'toBe',
          basis: 'stated',
          freshness: 'not-applicable',
          attributes: {
            title: 'Tenancy model',
            question: 'How should tenants be isolated?',
            status: 'accepted',
            statusRationale: 'Cheapest to run for the first customers.',
          },
        }),
        item({
          id: ALT_A,
          type: 'core.Alternative',
          label: 'Tenant column',
          role: 'alternative',
          stance: 'toBe',
          basis: 'inferred',
          confidence: { level: 'medium', rationale: 'Two modules already scope by owner.' },
          freshness: 'not-applicable',
          attributes: {
            title: 'Tenant column',
            summary: 'Add tenant_id to every table.',
            status: 'accepted',
          },
        }),
        item({
          id: id('rel', 303),
          kind: 'relation',
          type: 'impacts',
          label: 'Tenant column -impacts-> Item',
          role: 'directChange',
          stance: 'toBe',
          basis: 'inferred',
          freshness: 'not-applicable',
          from: ALT_A,
          to: ITEM,
          attributes: { change: 'Add a tenant_id column.' },
        }),
      ],
      acceptanceCriteria: ['Every query filters by tenant', 'Existing tests pass'],
      policy: [
        'Agents read and propose. People commit proposals and accept decisions in Kalyth.',
        'Propose changes with propose_change at baseRevision equal to this package revision.',
      ],
    },
    items: [
      item({
        id: ITEM,
        type: 'software.DataEntity',
        label: 'Item',
        role: 'focus',
        evidence: [
          {
            id: id('evd', 1),
            location: 'app/models.py:10-24 @ 1a2b3c4',
            excerpt: 'class Item(SQLModel, table=True):\n    id: int | None',
          },
        ],
      }),
      item({
        id: QUESTION,
        type: 'core.Question',
        label: 'Do tenants share users?',
        role: 'question',
        distance: 1,
        basis: 'inferred',
        confidence: { level: 'low', rationale: 'Nothing in the source says either way.' },
        freshness: 'not-applicable',
        attributes: { text: 'Do tenants share users?', inquiryRole: 'blocking', status: 'open' },
      }),
      item({
        id: MODELS_PY,
        type: 'software.Module',
        label: 'app/models.py',
        role: 'impacted',
        distance: 1,
        freshness: 'stale',
        path: [contains],
        evidence: [{ id: id('evd', 2), location: 'app/models.py:1-80 @ 1a2b3c4', excerpt: null }],
      }),
      item({
        id: LIB,
        type: 'software.Library',
        label: 'sqlmodel',
        role: 'dependency',
        distance: 1,
      }),
      item({
        id: CRUD_PY,
        type: 'software.Module',
        label: 'app/crud.py',
        role: 'impacted',
        distance: 2,
        path: [contains, dependsOn],
      }),
    ],
    omissions: [
      { reason: 'size_limit', count: 12, ids: OMITTED },
      { reason: 'traversal_limit', count: 0, ids: [] },
    ],
    retrieval: [
      {
        tool: 'query_objects',
        arguments: { projectId: PROJECT, revision: 7, ids: OMITTED },
        purpose: 'Read omitted elements, nearest first.',
      },
    ],
    size: { chars: 18_240, maxChars: 60_000, mandatoryChars: 6_400 },
    ...overrides,
  }
}

/** The same request with only its mandatory part, which exceeds the limit. */
export function blockedPackage(): ContextPackage {
  return readyPackage({
    status: 'blocked',
    blocked: {
      code: 'context_overflow',
      mandatoryChars: 72_000,
      maxChars: 60_000,
      splits: [[ITEM, MODELS_PY], [CRUD_PY]],
    },
    items: [],
    omissions: [],
    retrieval: [],
    size: { chars: 72_480, maxChars: 60_000, mandatoryChars: 72_000 },
  })
}

export function packageResult(pkg: ContextPackage = readyPackage()): ContextPackageResult {
  return {
    package: pkg,
    uri: `kalyth://context/${pkg.id}`,
    callerScopes: ['grant.manage', 'project.read', 'proposal.create'],
  }
}

export function acceptedDecision(): DecisionSummary {
  return {
    id: DECISION,
    title: 'Tenancy model',
    question: 'How should tenants be isolated?',
    status: 'accepted',
    statusRationale: 'Cheapest to run for the first customers.',
    basis: 'stated',
    alternatives: [
      {
        id: ALT_B,
        title: 'Database per tenant',
        summary: 'One database each.',
        status: 'rejected',
        directChanges: [],
      },
      {
        id: ALT_A,
        title: 'Tenant column',
        summary: 'Add tenant_id to every table.',
        status: 'accepted',
        directChanges: [
          {
            relationId: id('rel', 303),
            target: ITEM,
            label: 'Item',
            change: 'Add a tenant_id column.',
          },
          {
            relationId: id('rel', 304),
            target: MODELS_PY,
            label: 'app/models.py',
            change: 'Filter by tenant in the base query.',
          },
        ],
      },
    ],
    decides: [],
  }
}

export function tokenSummary(overrides: Partial<AgentTokenSummary> = {}): AgentTokenSummary {
  return {
    id: TOKEN_ID,
    projectId: PROJECT,
    principalId: AGENT,
    label: 'Claude Code on my laptop',
    scopes: ['project.read', 'proposal.create'],
    createdBy: PERSON,
    createdAt: '2026-10-17T08:00:00.000Z',
    expiresAt: '2026-10-24T08:00:00.000Z',
    revokedAt: null,
    ...overrides,
  }
}

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: id('prp', 1),
    projectId: PROJECT,
    baseRevision: 7,
    proposedBy: AGENT,
    origin: 'agent',
    ops: [],
    rationale: 'Add tenant_id to Item and filter the base query',
    readSet: [],
    writeSet: [],
    predicates: [],
    idempotencyKey: null,
    contextPackageId: null,
    status: 'pending',
    issues: [],
    result: null,
    createdAt: '2026-10-17T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    ...overrides,
  }
}
