import { readFileSync } from 'node:fs'
import type { ClaimInput, OperationInput } from '@kalyth/contracts'
import { type setup, tool, unwrap } from './helpers.ts'

type Ctx = ReturnType<typeof setup>
export type Seed = { name: string; description: string; rationale: string; ops: OperationInput[] }

export const networkingSeed: Seed = JSON.parse(
  readFileSync(
    new URL('../../../deploy/knowledge/real-time-networking.json', import.meta.url),
    'utf8',
  ),
)

export const expectedRun = JSON.parse(
  readFileSync(
    new URL('../../../deploy/knowledge/fixtures/multi-game-method-run.json', import.meta.url),
    'utf8',
  ),
)

const stated: ClaimInput = { basis: 'stated' }

/** Proposes as `by` and commits as the owner; returns the refs. */
export function commitOps(ctx: Ctx, projectId: string, ops: OperationInput[], by = ctx.owner) {
  const head = ctx.store.getProject(projectId)?.headRevision ?? 0
  const p = unwrap(
    ctx.services.proposeChange(by, { projectId, baseRevision: head, ops, rationale: 'fixture' }),
  )
  if (p.status !== 'pending') throw new Error(JSON.stringify(p.issues))
  return unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).refs
}

/** A library filed by an agent from a seed and committed by its owner. */
export function fileLibrary(ctx: Ctx, seed: Seed) {
  const lib = unwrap(
    ctx.services.createProject(ctx.owner, {
      name: seed.name,
      description: seed.description,
      kind: 'library',
    }),
  )
  const L = commitOps(ctx, lib.id, seed.ops, ctx.agent)
  return { lib, L }
}

export const pinOp = (library: string, ref: string, id: string, revision = 1): OperationInput => ({
  op: 'recordEvidence',
  ref,
  evidence: {
    source: { kind: 'knowledge', library, target: 'object', id, revision },
    collectedBy: tool,
  },
})

export const elementOp = (ref: string, type: string, name: string): OperationInput => ({
  op: 'createObject',
  ref,
  type,
  stance: 'toBe',
  attributes: { name },
  claim: stated,
})

export const scenarioOp = (
  ref: string,
  name: string,
  order: number,
  status: 'assumed' | 'planned' | 'committed',
  base?: string,
): OperationInput => ({
  op: 'createObject',
  ref,
  type: 'core.Scenario',
  stance: 'toBe',
  attributes: {
    name,
    order,
    description: `${name}.`,
    ...(base ? { base } : {}),
    status,
    rationale: `${name} is ${status}.`,
  },
  claim: stated,
})

export const parameterOp = (
  ref: string,
  concept: string,
  scenario: string,
  value: unknown,
  elements: string[] = [],
  nature = 'expected',
): OperationInput =>
  ({
    op: 'createObject',
    ref,
    type: 'core.Parameter',
    stance: 'toBe',
    attributes: { concept, scenario, elements, nature, value, provenance: 'stated', note: '' },
    claim: stated,
  }) as OperationInput

/**
 * The K3 worked example as ADR 0033 runs it: the RTS and the shooter, launch and expansion, with
 * only the method and the two concepts that have values pinned. Everything else is selected.
 */
export function multiGame(ctx: Ctx) {
  const { lib, L } = fileLibrary(ctx, networkingSeed)
  const id = (ref: string) => L[ref] as string
  const P = commitOps(ctx, ctx.project.id, [
    {
      op: 'createObject',
      ref: '$use',
      type: 'core.LibraryUse',
      stance: 'toBe',
      attributes: {
        library: lib.id,
        label: 'kalyth/real-time-networking',
        revision: 1,
        role: 'primary',
      },
      claim: stated,
    },
    pinOp(lib.id, '$method', id('$chooseSync')),
    pinOp(lib.id, '$deterministic', id('$deterministic')),
    pinOp(lib.id, '$predictable', id('$predictable')),
    elementOp('$platform', 'software.System', 'Game platform'),
    elementOp('$rts', 'software.Container', 'RTS'),
    elementOp('$shooter', 'software.Container', 'Arena shooter'),
    {
      op: 'createRelation',
      type: 'contains',
      from: '$platform',
      to: '$rts',
      stance: 'toBe',
      claim: stated,
    },
    {
      op: 'createRelation',
      type: 'contains',
      from: '$platform',
      to: '$shooter',
      stance: 'toBe',
      claim: stated,
    },
    scenarioOp('$launch', 'Launch', 1, 'committed'),
    scenarioOp('$expansion', 'Expansion', 2, 'planned', '$launch'),
  ])
  const p = (ref: string) => P[ref] as string
  commitOps(ctx, ctx.project.id, [
    parameterOp('$engine', p('$deterministic'), p('$launch'), { kind: 'boolean', value: true }),
    parameterOp(
      '$physics',
      p('$deterministic'),
      p('$expansion'),
      { kind: 'boolean', value: false },
      [p('$shooter')],
    ),
    parameterOp('$motion', p('$predictable'), p('$expansion'), { kind: 'boolean', value: false }, [
      p('$shooter'),
    ]),
  ])
  const input = {
    projectId: ctx.project.id,
    method: p('$method'),
    elements: [p('$rts'), p('$shooter')],
    scenarios: [p('$launch'), p('$expansion')],
    natures: ['expected'] as const,
    question: expectedRun.input.question as string,
  }
  /** Names for ids, so results read like the fixture. */
  const names = new Map<string, string>([
    [p('$rts'), 'RTS'],
    [p('$shooter'), 'Arena shooter'],
    [p('$launch'), 'Launch'],
    [p('$expansion'), 'Expansion'],
  ])
  return { lib, L, P, input, names }
}
