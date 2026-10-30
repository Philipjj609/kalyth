import { readFileSync } from 'node:fs'
import type { Caller, ClaimInput, OperationInput } from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'

/**
 * The K3 multi-game example as data (K4): the real-time networking seed library, proposed by an
 * agent and committed by a person, and a game platform project that uses it, with an RTS and a
 * shooter, Launch and Expansion scenarios, stated parameters and two recorded assessments. Used
 * by the K4 tests and by `pnpm knowledge:example`. Nothing here calls a model.
 */
export function buildKnowledgeExample(services: KalythServices, owner: Caller, agent: Caller) {
  const seed = JSON.parse(
    readFileSync(
      new URL('../../../../deploy/knowledge/real-time-networking.json', import.meta.url),
      'utf8',
    ),
  ) as { name: string; description: string; rationale: string; ops: OperationInput[] }
  const stated: ClaimInput = { basis: 'stated' }
  const commit = (projectId: string, ops: OperationInput[], by: Caller, rationale: string) => {
    const head = services.store.getProject(projectId)?.headRevision ?? 0
    const p = services.proposeChange(by, { projectId, baseRevision: head, ops, rationale })
    if (!p.ok || p.value.status !== 'pending') throw new Error(JSON.stringify(p))
    const c = services.commitProposal(owner, { proposalId: p.value.proposalId })
    if (!c.ok) throw new Error(JSON.stringify(c.error))
    return c.value.refs
  }
  const created = (r: ReturnType<KalythServices['createProject']>) => {
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }

  const library = created(
    services.createProject(owner, {
      name: seed.name,
      description: seed.description,
      kind: 'library',
    }),
  )
  const L = commit(library.id, seed.ops, agent, seed.rationale)

  const project = created(
    services.createProject(owner, {
      name: 'Game platform',
      description: 'An RTS and an arena shooter on one platform.',
    }),
  )
  const pin = (ref: string, id: string): OperationInput => ({
    op: 'recordEvidence',
    ref,
    evidence: {
      source: { kind: 'knowledge', library: library.id, target: 'object', id, revision: 1 },
      collectedBy: { tool: 'knowledge-example', toolVersion: '1' },
    },
  })
  const element = (ref: string, type: string, name: string): OperationInput => ({
    op: 'createObject',
    ref,
    type,
    stance: 'toBe',
    attributes: { name },
    claim: stated,
  })
  const P = commit(
    project.id,
    [
      {
        op: 'createObject',
        ref: '$use',
        type: 'core.LibraryUse',
        stance: 'toBe',
        attributes: {
          library: library.id,
          label: 'kalyth/real-time-networking',
          revision: 1,
          role: 'primary',
        },
        claim: stated,
      },
      pin('$deterministic', L.$deterministic as string),
      pin('$predictable', L.$predictable as string),
      pin('$lockstep', L.$lockstep as string),
      pin('$deadReckoning', L.$deadReckoning as string),
      pin('$authServer', L.$authServer as string),
      element('$platform', 'software.System', 'Game platform'),
      element('$rts', 'software.Container', 'RTS'),
      element('$shooter', 'software.Container', 'Arena shooter'),
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
      {
        op: 'createObject',
        ref: '$launch',
        type: 'core.Scenario',
        stance: 'toBe',
        attributes: {
          name: 'Launch',
          order: 1,
          description: 'The RTS ships alone, on the shared fixed-point engine.',
          status: 'committed',
          rationale: 'Funded and scheduled.',
        },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$expansion',
        type: 'core.Scenario',
        stance: 'toBe',
        attributes: {
          name: 'Expansion',
          order: 2,
          description: 'The arena shooter joins, on physics middleware.',
          base: '$launch',
          status: 'planned',
          rationale: 'On the roadmap, not funded.',
        },
        claim: stated,
      },
    ],
    owner,
    'Model the platform and use the networking library',
  )
  const param = (
    ref: string,
    concept: string,
    scenario: string,
    value: boolean,
    elements: string[] = [],
  ): OperationInput =>
    ({
      op: 'createObject',
      ref,
      type: 'core.Parameter',
      stance: 'toBe',
      attributes: {
        concept: P[concept],
        scenario: P[scenario],
        elements: elements.map((e) => P[e]),
        nature: 'expected',
        value: { kind: 'boolean', value },
        provenance: 'stated',
        note: '',
      },
      claim: stated,
    }) as OperationInput
  const V = commit(
    project.id,
    [
      param('$engineDeterministic', '$deterministic', '$launch', true),
      param('$shooterPhysics', '$deterministic', '$expansion', false, ['$shooter']),
      param('$shooterMotion', '$predictable', '$expansion', false, ['$shooter']),
    ],
    owner,
    'State the expected values',
  )
  const record = (item: string, scenario: string, element: string) => {
    const p = services.proposeAssessment(owner, {
      projectId: project.id,
      item: P[item],
      scenario: P[scenario],
      element: P[element],
      nature: 'expected',
    })
    if (!p.ok) throw new Error(p.error.message)
    const c = services.commitProposal(owner, { proposalId: p.value.proposalId })
    if (!c.ok) throw new Error(c.error.message)
    return c.value.refs.$assessment as string
  }
  const assessments = {
    rtsLockstep: record('$lockstep', '$launch', '$rts'),
    shooterLockstep: record('$lockstep', '$expansion', '$shooter'),
  }
  return { library, project, L, P, V, assessments }
}
