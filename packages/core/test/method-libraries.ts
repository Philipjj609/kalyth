import type { ClaimInput, OperationInput } from '@kalyth/contracts'
import type { Seed } from './method-fixture.ts'

const source = (ref: string, title: string, locator: string): OperationInput => ({
  op: 'recordEvidence',
  ref,
  evidence: {
    source: {
      kind: 'external',
      uri: `https://example.org/database-scaling/${ref.slice(1)}`,
      retrievedAt: '2026-10-30T07:00:00.000Z',
      meta: {
        title,
        authors: ['Test author'],
        locator: `section "${locator}"`,
        licence: 'unknown',
        quotePolicy: 'none',
      },
    },
    collectedBy: { tool: 'test-library', toolVersion: '1' },
  },
})
const from = (...refs: string[]): ClaimInput => ({ basis: 'imported', supports: [{ allOf: refs }] })
const object = (
  ref: string,
  type: string,
  attributes: Record<string, unknown>,
  evidence = '$s1',
): OperationInput =>
  ({
    op: 'createObject',
    ref,
    type,
    stance: 'asIs',
    attributes,
    claim: from(evidence),
  }) as OperationInput
const relation = (
  type: string,
  fromRef: string,
  to: string,
  properties: Record<string, unknown> = {},
): OperationInput =>
  ({
    op: 'createRelation',
    type,
    from: fromRef,
    to,
    stance: 'asIs',
    properties,
    claim: from('$s2'),
  }) as OperationInput

/**
 * A small library about scaling a database, to show that the method engine knows no discipline
 * (ADR 0033, Generalisation). Test data only: its sources are placeholders, not real articles.
 */
export function databaseSeed(
  options: { hypothesis?: boolean; dispute?: boolean; modelStep?: boolean } = {},
): Seed {
  const property = (ref: string, name: string) =>
    object(ref, 'knowledge.Concept', {
      name,
      definition: `${name}, as the project states it.`,
      kind: 'property',
      dimension: 'boolean',
    })
  const quality = (ref: string, name: string) =>
    object(ref, 'knowledge.Concept', { name, definition: `${name}.`, kind: 'quality' })
  const condition = (ref: string, subject: string, text: string) =>
    object(ref, 'knowledge.Condition', { subject, test: { op: 'is', value: true }, text })
  const pattern = (ref: string, name: string, extra: Record<string, unknown> = {}) =>
    object(ref, 'knowledge.Pattern', {
      name,
      problem: 'One database node no longer keeps up.',
      solution: `${name}: spread the load.`,
      structure: `${name} structure.`,
      consequences: `${name} consequences.`,
      ...extra,
    })
  const ops: OperationInput[] = [
    source('$s1', 'Scaling databases', 'Replication'),
    source('$s2', 'Scaling databases', 'Partitioning'),
    property('$readsDominate', 'Reads dominate writes'),
    property('$strong', 'Strong consistency required'),
    property('$writesExceed', 'Writes exceed one node'),
    quality('$freshness', 'Freshness of reads'),
    quality('$simplicity', 'Operational simplicity'),
    condition('$whenReads', '$readsDominate', 'Most of the load is reads.'),
    condition('$whenStrong', '$strong', 'Every read must see the latest write.'),
    condition('$whenWrites', '$writesExceed', 'One node cannot absorb the writes.'),
    pattern('$replicas', 'Read replicas'),
    pattern('$sharding', 'Sharding'),
    pattern('$cqrs', 'Command and query responsibility segregation'),
    relation('appliesWhen', '$replicas', '$whenReads'),
    relation('unsuitableWhen', '$replicas', '$whenStrong'),
    relation('affects', '$replicas', '$freshness', {
      effect: 'worsens',
      note: 'Replicas lag behind the primary.',
    }),
    relation('appliesWhen', '$sharding', '$whenWrites'),
    relation('affects', '$sharding', '$simplicity', {
      effect: 'worsens',
      note: 'Every query must know its shard.',
    }),
    relation('affects', '$cqrs', '$simplicity', {
      effect: 'worsens',
      note: 'Two models to keep in step.',
    }),
    relation('competesWith', '$cqrs', '$replicas'),
    object('$scale', 'knowledge.Method', {
      name: 'Choose a way to scale the database',
      purpose: 'Compare ways to scale a database under the load a project states.',
      appliesTo: { elementTypes: ['software.Container'], needsScenarios: true },
      needs: [],
      steps: [
        { id: 'select', title: 'Select', uses: [], reads: [], mode: 'deterministic', produces: [] },
        {
          id: 'assess',
          title: 'Assess',
          uses: [],
          reads: [],
          mode: 'deterministic',
          produces: ['assessment', 'question'],
        },
        ...(options.modelStep
          ? [
              {
                id: 'draft',
                title: 'Draft more alternatives',
                uses: [],
                reads: [],
                mode: 'model',
                produces: ['alternative'],
              },
            ]
          : []),
        {
          id: 'compare',
          title: 'Compare',
          uses: [],
          reads: [],
          mode: 'deterministic',
          produces: ['alternative'],
        },
      ],
      checks: [
        'alternatives-cite-assessments',
        'no-reliance-on-ruled-out',
        'disputed-flagged',
        'hypotheses-labelled',
        'worsens-disclosed',
        'unknowns-asked',
      ],
    }),
    relation('uses', '$scale', '$replicas'),
    relation('uses', '$scale', '$sharding'),
  ]
  if (options.hypothesis)
    ops.push(
      pattern('$cache', 'Read-through cache', { maturity: 'hypothesis' }),
      relation('competesWith', '$cache', '$replicas'),
      relation('affects', '$cache', '$freshness', {
        effect: 'worsens',
        note: 'Entries expire late.',
      }),
    )
  if (options.dispute)
    ops.push(
      object('$premature', 'knowledge.Principle', {
        statement: 'Do not shard before one node is exhausted.',
        rationale: 'Sharding is hard to undo.',
        scope: 'Relational databases.',
      }),
      relation('contradicts', '$premature', '$sharding'),
    )
  return {
    name: 'Database scaling (test)',
    description: 'A small test library about scaling databases.',
    rationale: 'Test data for the method engine.',
    ops,
  }
}
