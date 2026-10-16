import type { Caller, ClaimInput, OperationInput, Result } from '@kalyth/contracts'
import {
  ensureLocalAgent,
  ensureLocalOwner,
  type FaultInjector,
  KalythServices,
  SqliteStore,
} from '../src/index.ts'

export function setup(options: { faults?: FaultInjector } = {}) {
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 9, 16, 12, 0, 0) + tick++).toISOString()
  const store = new SqliteStore(':memory:')
  const services = new KalythServices({
    store,
    clock,
    ...(options.faults ? { faults: options.faults } : {}),
  })
  const ownerPrincipal = ensureLocalOwner(services)
  const agentPrincipal = ensureLocalAgent(services)
  const owner: Caller = { principalId: ownerPrincipal.id, origin: 'human' }
  const agent: Caller = { principalId: agentPrincipal.id, origin: 'agent' }
  const project = unwrap(
    services.createProject(owner, { name: 'Fixture', description: 'test project' }),
  )
  return { store, services, owner, agent, ownerPrincipal, agentPrincipal, project }
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.issues)}`,
    )
  return result.value
}

export function errorOf<T>(result: Result<T>) {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`)
  return result.error
}

export const COMMIT = 'a'.repeat(40)
export const BLOB = 'b'.repeat(40)

export const tool = { tool: 'test-analyzer', toolVersion: '0.0.1' }

export function evidenceOp(
  ref: string,
  path = 'app/main.py',
  excerpt = 'def main():\n    pass',
): OperationInput {
  return {
    op: 'recordEvidence',
    ref,
    evidence: {
      source: {
        kind: 'sourceSpan',
        repo: 'fixture',
        commit: COMMIT,
        path,
        blobSha: BLOB,
        span: { startLine: 1, endLine: 2 },
      },
      excerpt,
      collectedBy: tool,
    },
  }
}

export const observed = (...evidenceRefs: string[]): ClaimInput => ({
  basis: 'observed',
  observation: { ...tool, coverage: 'fixture files only' },
  supports: [{ allOf: evidenceRefs }],
})

export const stated: ClaimInput = { basis: 'stated' }

/** Proposes and commits as the owner; returns the commit result. */
export function commitAsOwner(
  ctx: ReturnType<typeof setup>,
  ops: OperationInput[],
  baseRevision?: number,
) {
  const base =
    baseRevision ??
    unwrap(ctx.services.getProjectOverview(ctx.owner, { projectId: ctx.project.id })).project
      .headRevision
  const proposed = unwrap(
    ctx.services.proposeChange(ctx.owner, {
      projectId: ctx.project.id,
      baseRevision: base,
      ops,
      rationale: 'test',
    }),
  )
  if (proposed.status !== 'pending')
    throw new Error(`proposal ${proposed.status}: ${JSON.stringify(proposed.issues)}`)
  return {
    proposalId: proposed.proposalId,
    commit: unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId })),
  }
}

/** A small system: a container with a module that exposes an endpoint. */
export function seedSystem(ctx: ReturnType<typeof setup>) {
  const { commit } = commitAsOwner(ctx, [
    evidenceOp('$ev'),
    {
      op: 'createObject',
      ref: '$api',
      type: 'software.Container',
      stance: 'asIs',
      attributes: { name: 'backend' },
      claim: observed('$ev'),
    },
    {
      op: 'createObject',
      ref: '$mod',
      type: 'software.Module',
      stance: 'asIs',
      attributes: { path: 'app/main.py', language: 'python' },
      claim: observed('$ev'),
    },
    {
      op: 'createRelation',
      ref: '$c',
      type: 'contains',
      from: '$api',
      to: '$mod',
      stance: 'asIs',
      claim: observed('$ev'),
    },
  ])
  const objects = unwrap(
    ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }),
  ).objects
  const byType = (t: string) => objects.find((o) => o.type === t)?.id as string
  return { commit, apiId: byType('software.Container'), moduleId: byType('software.Module') }
}
