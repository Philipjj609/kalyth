import {
  AlternativeStatus,
  ContextPackageId,
  DecisionStatus,
  ParameterValue,
  PrincipalId,
  TaskFinding,
  TaskLease,
  TaskStatus,
  TestRun,
  Verdict,
} from '@kalyth/contracts'
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
      /** Suggested answers a person can pick from; they may still answer in their own words. */
      options: z.array(z.string().min(1).max(200)).max(4).optional(),
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
  {
    type: 'core.Task',
    version: 1,
    pack: 'core',
    description:
      'Work for a person or coding agent. Status and lease change only through setTaskStatus (ADR 0013).',
    attributes: z.strictObject({
      title,
      description: optionalText,
      acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(20).default([]),
      status: TaskStatus.default('proposed'),
      statusRationale: z.string().max(2000).optional(),
      lease: TaskLease.nullable().default(null),
      contextPackageId: ContextPackageId.optional(),
      baseCommit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
      // Still version 1: `finding` is optional, so every earlier version is valid as it stands.
      // Only setTaskStatus writes it (ADR 0013, amendment of 2026-10-20).
      finding: TaskFinding.optional(),
    }),
    reserved: { status: 'proposed', lease: null, finding: null },
  },
  {
    type: 'core.ExecutionReport',
    version: 1,
    pack: 'core',
    description:
      'What an agent says it did for a task. Stated, not verified; a Verification records what git confirms.',
    attributes: z.strictObject({
      outcome: z.enum(['succeeded', 'failed', 'partial']),
      summary: z.string().min(1).max(4000),
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
      filesChanged: z.array(z.string().min(1).max(1000)).max(500).default([]),
      tests: z.array(TestRun).max(20).default([]),
      // Still version 1: an agent's report names its lease; a report a person files themselves
      // names that person instead (ADR 0024). Both stay optional, so earlier versions are valid.
      leaseId: z.string().min(1).max(100).optional(),
      filedBy: PrincipalId.optional(),
      idempotencyKey: z.string().min(8).max(200),
    }),
  },
  {
    type: 'core.SourceSnapshot',
    version: 1,
    pack: 'core',
    description:
      'The source revision a project currently reflects for one repository, with the git blob of every analysed file. Evidence is fresh while its path still has the same blob here.',
    attributes: z.strictObject({
      repo: z.string().min(1).max(500),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      ref: z.string().max(200).optional(),
      coverage: z.string().min(1).max(4000),
      files: z.record(z.string().min(1).max(1000), z.string().regex(/^[0-9a-f]{40}$/)),
      /**
       * Set while an ingest of a newer commit is committed in parts and not yet complete (ADR
       * 0025): the model then mixes this snapshot's commit with part of the newer one. The final
       * part clears it. Still version 1: optional and additive.
       */
      pending: z
        .strictObject({ commit: z.string().regex(/^[0-9a-f]{40}$/), parts: z.int().min(2) })
        .optional(),
    }),
  },
  {
    type: 'core.Scenario',
    version: 1,
    pack: 'core',
    description:
      'A situation the system is assessed in, from small to large, with its own certainty (ADR 0028 §2).',
    attributes: z.strictObject({
      name: title,
      order: z.int().min(0),
      description: text,
      base: z.string().optional(),
      status: z.enum(['assumed', 'planned', 'committed']),
      rationale: text,
    }),
    references: ['base'],
  },
  {
    type: 'core.Parameter',
    version: 1,
    pack: 'core',
    description:
      'A value of a pinned concept in a scenario, for some elements or the whole system (ADR 0028 §3).',
    attributes: z
      .strictObject({
        /** The project's pin of a quantity or property Concept. */
        concept: z.string(),
        scenario: z.string(),
        /** Empty for the whole system. */
        elements: z.array(z.string()).max(50).default([]),
        nature: z.enum(['current', 'expected', 'target', 'limit']),
        value: ParameterValue,
        provenance: z.enum(['stated', 'sourceObserved', 'runtimeMeasured']),
        note: z.string().max(2000).default(''),
      })
      .superRefine((p, ctx) => {
        const v = p.value
        if (v.kind === 'interval') {
          if (v.min === undefined && v.max === undefined)
            ctx.addIssue({
              code: 'custom',
              message: 'an interval has at least one end',
              path: ['value'],
            })
          if (v.min !== undefined && v.max !== undefined && Number(v.min) > Number(v.max))
            ctx.addIssue({
              code: 'custom',
              message: 'an interval needs min <= max',
              path: ['value'],
            })
        }
      }),
    references: [{ key: 'concept', kind: 'evidence' }, 'scenario', 'elements'],
  },
  {
    type: 'core.Assessment',
    version: 1,
    pack: 'core',
    description:
      'A computed verdict on declared conditions, with its explanation and what it read (ADR 0029 §1). Never edited; a newer one supersedes it.',
    attributes: z.strictObject({
      /** The project's pin of the pattern or principle assessed. */
      item: z.string(),
      scenario: z.string(),
      element: z.string().optional(),
      // Records stored before nature was required were about expected values.
      nature: z.enum(['current', 'expected', 'target', 'limit']).default('expected'),
      verdict: Verdict,
      explanation: z.json(),
      inputs: z.json(),
      producedBy: z.strictObject({ kind: z.literal('evaluator'), evaluatorVersion: z.string() }),
    }),
    references: [{ key: 'item', kind: 'evidence' }, 'scenario', 'element'],
  },
  {
    type: 'core.Correspondence',
    version: 1,
    pack: 'core',
    description:
      'An explicit relation between items of two libraries, owned by the project (ADR 0027 §5). Without one, items of different libraries are never treated as one.',
    attributes: z.strictObject({
      /** Two of the project's pins, of different libraries. */
      a: z.string(),
      b: z.string(),
      relation: z.enum(['sameAs', 'broader', 'narrower', 'related', 'conflictsWith']),
      note: z.string().max(2000).default(''),
    }),
    references: [
      { key: 'a', kind: 'evidence' },
      { key: 'b', kind: 'evidence' },
    ],
  },
  {
    type: 'core.LibraryUse',
    version: 1,
    pack: 'core',
    description:
      'A library this project uses, at a revision (ADR 0027 §4). Pins cite that revision or an earlier one.',
    attributes: z.strictObject({
      library: z.string().regex(/^prj_[0-9a-f]{32}$/, 'expected a project id'),
      label: title,
      revision: z.int().min(0),
      role: z.enum(['primary', 'supplementary']),
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
    // Still version 1: `parameters` is optional and additive, so every earlier version of an
    // endpoint is valid as it stands (ADR 0021).
    version: 1,
    pack: 'software',
    description: 'A network-facing operation such as an HTTP route.',
    attributes: z.strictObject({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']),
      path: z.string().min(1).max(1000),
      handler: z.string().max(500).optional(),
      /** Set only when another endpoint has this method and path: the handler that is this one. */
      scope: z.string().max(1000).optional(),
      /** Request parameters from the handler's signature, in order; dependencies are left out. */
      parameters: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(200),
            in: z.enum(['path', 'query', 'body', 'header', 'cookie', 'unknown']),
            /** The type annotation as written. */
            type: z.string().min(1).max(300).optional(),
          }),
        )
        .max(100)
        .optional(),
    }),
  },
  {
    type: 'software.DataEntity',
    // Still version 1: `fields` is optional and additive, as endpoint parameters are (ADR 0021).
    version: 1,
    pack: 'software',
    description: 'A persisted data structure such as a table or document type.',
    attributes: z.strictObject({
      name,
      storage: z.string().max(200).optional(),
      /**
       * Fields as declared in source, in order: the annotation, the key a field holds (`user.id`),
       * the entity a relationship points at, and the base class a field is inherited from.
       * Annotations, not the schema at run time. At most 200; `fieldsOmitted` counts the rest.
       */
      fields: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(200),
            type: z.string().max(200).optional(),
            references: z.string().max(200).optional(),
            relationship: z.string().max(200).optional(),
            inheritedFrom: z.string().max(200).optional(),
          }),
        )
        .max(200)
        .optional(),
      fieldsOmitted: z.int().min(1).optional(),
      /** Set only when another entity of this name is declared elsewhere: where this one is. */
      scope: z.string().max(1000).optional(),
    }),
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

const KNOWLEDGE_ITEMS = [
  'knowledge.Concept',
  'knowledge.Principle',
  'knowledge.Pattern',
  'knowledge.Condition',
  'knowledge.Method',
]

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
    // A change to the data affects the code that writes it. Not the other way: through a writer
    // of two entities, one entity's impact would reach the other's readers (ADR 0021).
    impact: 'targetToSource',
  },
  {
    ...base,
    type: 'references',
    pack: 'software',
    description: 'The source data refers to the target, for example through a foreign key.',
    from: ['software.DataEntity'],
    to: ['software.DataEntity'],
    impact: 'targetToSource',
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
    type: 'combines',
    pack: 'core',
    description: 'The alternative is a hybrid that combines the target alternative with others.',
    from: ['core.Alternative'],
    to: ['core.Alternative'],
    acyclic: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'impacts',
    pack: 'core',
    description:
      'Choosing the alternative changes the target directly; properties.change says how. Propagated impact is computed by traversal, not stored (ADR 0010).',
    from: ['core.Alternative'],
    to: SOFTWARE_ELEMENTS,
    impact: 'none',
  },
  {
    ...base,
    type: 'implements',
    pack: 'core',
    description: 'The task carries out the decision, alternative or requirement.',
    from: ['core.Task'],
    to: ['core.Decision', 'core.Alternative', 'core.Requirement'],
    impact: 'none',
  },
  {
    ...base,
    // Version 2 lets a pattern require another (ADR 0026 §5, ADR 0028 §5).
    version: 2,
    type: 'requires',
    pack: 'core',
    description:
      'The task can start only when the target task is completed or decision accepted; a pattern needs the target pattern.',
    from: ['core.Task', 'knowledge.Pattern'],
    to: ['core.Task', 'core.Decision', 'knowledge.Pattern'],
    acyclic: true,
    impact: 'none',
  },
  {
    ...base,
    type: 'reports',
    pack: 'core',
    description: 'The execution report is about the task.',
    from: ['core.ExecutionReport'],
    to: ['core.Task'],
    maxOutgoingPerSource: 1,
    impact: 'none',
  },
  {
    ...base,
    // Version 2 adds knowledge items, which a library replaces the same way (ADR 0026 §5).
    version: 2,
    type: 'supersedes',
    pack: 'core',
    description: 'The source decision or knowledge item replaces the target of the same type.',
    from: ['core.Decision', 'core.Assessment', 'core.Parameter', ...KNOWLEDGE_ITEMS],
    to: ['core.Decision', 'core.Assessment', 'core.Parameter', ...KNOWLEDGE_ITEMS],
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
