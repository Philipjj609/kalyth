import { AlternativeStatus, DecisionStatus } from '@kalyth/contracts'
import { z } from 'zod'
import type { ObjectTypeDef, RelationTypeDef } from './types.ts'

const title = z.string().min(1).max(300)
const text = z.string().min(1).max(8000)
const optionalText = z.string().max(8000).optional()

// ---------- core pack: domain-neutral engineering knowledge ----------

export const corePack: ObjectTypeDef[] = [
  {
    type: 'core.Requirement',
    version: 1,
    pack: 'core',
    description: 'Something the system must do or a quality it must have.',
    attributes: z.strictObject({
      title,
      statement: text,
      priority: z.enum(['must', 'should', 'could']).optional(),
    }),
  },
  {
    type: 'core.Constraint',
    version: 1,
    pack: 'core',
    description:
      'A rule that limits acceptable designs. Mandatory constraints are never dropped from context.',
    attributes: z.strictObject({
      title,
      statement: text,
      severity: z.enum(['must', 'should']),
      appliesTo: z.enum(['project', 'elements']).default('elements'),
    }),
  },
  {
    type: 'core.Decision',
    version: 1,
    pack: 'core',
    description:
      'A question that needs a choice. Its status changes only through setDecisionStatus.',
    attributes: z.strictObject({
      title,
      question: text,
      status: DecisionStatus.default('open'),
      statusRationale: z.string().max(2000).optional(),
    }),
    reserved: { status: 'open' },
  },
  {
    type: 'core.Alternative',
    version: 1,
    pack: 'core',
    description: 'One candidate answer to a Decision, linked by alternativeOf.',
    attributes: z.strictObject({
      title,
      summary: text,
      tradeoffs: optionalText,
      status: AlternativeStatus.default('proposed'),
      statusRationale: z.string().max(2000).optional(),
    }),
    reserved: { status: 'proposed' },
  },
  {
    type: 'core.Question',
    version: 1,
    pack: 'core',
    description: 'An open question, classified by how it affects decisions.',
    attributes: z.strictObject({
      text,
      inquiryRole: z.enum(['blocking', 'decision-sensitive', 'model-sensitive', 'exploratory']),
      status: z.enum(['open', 'answered', 'deferred', 'delegated']).default('open'),
      answer: optionalText,
    }),
  },
  {
    type: 'core.Assertion',
    version: 1,
    pack: 'core',
    description: 'A statement that does not fit a typed object or relation.',
    attributes: z.strictObject({ statement: text }),
  },
  {
    type: 'core.Verification',
    version: 1,
    pack: 'core',
    description: 'The outcome of a check against a requirement, claim or element.',
    attributes: z.strictObject({
      method: title,
      outcome: z.enum(['pass', 'fail', 'inconclusive']),
      summary: optionalText,
    }),
  },
]

// ---------- software pack ----------

const name = z.string().min(1).max(300)

export const softwarePack: ObjectTypeDef[] = [
  {
    type: 'software.System',
    version: 1,
    pack: 'software',
    description: 'A whole software system.',
    attributes: z.strictObject({ name, description: optionalText }),
  },
  {
    type: 'software.Container',
    version: 1,
    pack: 'software',
    description: 'A separately deployable or runnable unit, such as a backend service or web app.',
    attributes: z.strictObject({
      name,
      technology: z.string().max(200).optional(),
      description: optionalText,
    }),
  },
  {
    type: 'software.Component',
    version: 1,
    pack: 'software',
    description: 'A cohesive group of code with a responsibility.',
    attributes: z.strictObject({ name, responsibility: optionalText }),
  },
  {
    type: 'software.Module',
    version: 1,
    pack: 'software',
    description: 'A source file or package.',
    attributes: z.strictObject({
      path: z.string().min(1).max(1000),
      language: z.string().max(50).optional(),
    }),
  },
  {
    type: 'software.Endpoint',
    version: 1,
    pack: 'software',
    description: 'A network-facing operation such as an HTTP route.',
    attributes: z.strictObject({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']),
      path: z.string().min(1).max(1000),
      handler: z.string().max(500).optional(),
    }),
  },
  {
    type: 'software.DataEntity',
    version: 1,
    pack: 'software',
    description: 'A persisted data structure such as a table or document type.',
    attributes: z.strictObject({ name, storage: z.string().max(200).optional() }),
  },
  {
    type: 'software.Library',
    version: 1,
    pack: 'software',
    description: 'An external dependency.',
    attributes: z.strictObject({
      name,
      version: z.string().max(100).optional(),
      ecosystem: z.string().max(50).optional(),
    }),
  },
]

// ---------- relation types ----------

const STRUCTURAL = [
  'software.System',
  'software.Container',
  'software.Component',
  'software.Module',
]
const CODE_UNITS = ['software.Container', 'software.Component', 'software.Module']
const SOFTWARE_ELEMENTS = [
  ...STRUCTURAL,
  'software.Endpoint',
  'software.DataEntity',
  'software.Library',
]

const base = { version: 1, acyclic: false, symmetric: false, temporal: false } as const

export const relationTypes: RelationTypeDef[] = [
  {
    ...base,
    type: 'contains',
    pack: 'software',
    description: 'Structural containment. Each element has at most one container.',
    from: STRUCTURAL,
    to: [...STRUCTURAL, 'software.Endpoint', 'software.DataEntity'],
    acyclic: true,
    maxIncomingPerTarget: 1,
    impact: 'none',
  },
  {
    ...base,
    type: 'dependsOn',
    pack: 'software',
    description: 'The source uses the target; a change to the target may affect the source.',
    from: CODE_UNITS,
    to: [...CODE_UNITS, 'software.Library'],
    impact: 'targetToSource',
  },
  {
    ...base,
    type: 'exposes',
    pack: 'software',
    description: 'The source provides the target interface.',
    from: CODE_UNITS,
    to: ['software.Endpoint'],
    impact: 'both',
  },
  {
    ...base,
    type: 'reads',
    pack: 'software',
    description: 'The source reads the target data.',
    from: [...CODE_UNITS, 'software.Endpoint'],
    to: ['software.DataEntity'],
    impact: 'targetToSource',
  },
  {
    ...base,
    type: 'writes',
    pack: 'software',
    description: 'The source writes the target data.',
    from: [...CODE_UNITS, 'software.Endpoint'],
    to: ['software.DataEntity'],
    impact: 'both',
  },
  {
    ...base,
    type: 'realizes',
    pack: 'core',
    description: 'An existing element implements an intended design element or requirement.',
    from: SOFTWARE_ELEMENTS,
    to: [...SOFTWARE_ELEMENTS, 'core.Requirement'],
    fromStance: 'asIs',
    impact: 'targetToSource',
  },
  {
    ...base,
    type: 'satisfies',
    pack: 'core',
    description: 'The source meets the target requirement.',
    from: [...SOFTWARE_ELEMENTS, 'core.Alternative'],
    to: ['core.Requirement'],
    impact: 'sourceToTarget',
  },
  {
    ...base,
    type: 'constrains',
    pack: 'core',
    description: 'The constraint limits the target.',
    from: ['core.Constraint'],
    to: ['*'],
    impact: 'sourceToTarget',
  },
  {
    ...base,
    type: 'decides',
    pack: 'core',
    description: 'The decision determines the target.',
    from: ['core.Decision'],
    to: ['*'],
    impact: 'sourceToTarget',
  },
  {
    ...base,
    type: 'alternativeOf',
    pack: 'core',
    description: 'The alternative is a candidate answer to the decision.',
    from: ['core.Alternative'],
    to: ['core.Decision'],
    maxOutgoingPerSource: 1,
    impact: 'none',
  },
  {
    ...base,
    type: 'supersedes',
    pack: 'core',
    description: 'The source decision replaces the target decision.',
    from: ['core.Decision'],
    to: ['core.Decision'],
    acyclic: true,
    temporal: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'contradicts',
    pack: 'core',
    description:
      'The two claims cannot both hold. Raises a review item; does not propagate impact.',
    from: ['*'],
    to: ['*'],
    symmetric: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'precedes',
    pack: 'core',
    description: 'Temporal order.',
    from: ['*'],
    to: ['*'],
    acyclic: true,
    temporal: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'verifies',
    pack: 'core',
    description: 'The verification checked the target.',
    from: ['core.Verification'],
    to: ['*'],
    impact: 'none',
  },
  {
    ...base,
    type: 'concerns',
    pack: 'core',
    description: 'The question or assertion is about the target.',
    from: ['core.Question', 'core.Assertion'],
    to: ['*'],
    impact: 'none',
  },
]
