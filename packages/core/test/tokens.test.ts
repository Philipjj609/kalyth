import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Caller } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import {
  ensureLocalAgent,
  ensureLocalOwner,
  findSecretRule,
  KalythServices,
  SCHEMA_VERSION,
  SqliteStore,
} from '../src/index.ts'
import { errorOf, unwrap } from './helpers.ts'

function setup() {
  let now = Date.UTC(2026, 9, 17, 9, 0, 0)
  const clock = () => new Date(now++).toISOString()
  const services = new KalythServices({ store: new SqliteStore(':memory:'), clock })
  const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
  const project = unwrap(services.createProject(owner, { name: 'Tokens' }))
  const other = unwrap(services.createProject(owner, { name: 'Other' }))
  const advanceDays = (days: number) => {
    now += days * 86_400_000
  }
  return { services, owner, project, other, advanceDays }
}

describe('agent tokens (ADR 0011)', () => {
  it('issues a once-shown token for an agent that may read and propose in one project only', () => {
    const { services, owner, project, other } = setup()
    const issued = unwrap(
      services.issueAgentToken(owner, { projectId: project.id, label: 'Claude Code' }),
    )
    expect(issued.token).toMatch(/^kalyth_at_[A-Za-z0-9_-]{43}$/)
    expect(issued.summary).toMatchObject({
      projectId: project.id,
      scopes: ['project.read', 'proposal.create'],
    })
    expect(
      JSON.stringify(unwrap(services.listAgentTokens(owner, { projectId: project.id }))),
    ).not.toContain(issued.token)

    const auth = services.authenticateAgentToken(issued.token)
    expect(auth).toEqual({ principalId: issued.summary.principalId, projectId: project.id })
    const agent: Caller = { principalId: issued.summary.principalId, origin: 'agent' }
    expect(services.getProjectOverview(agent, { projectId: project.id }).ok).toBe(true)
    expect(errorOf(services.getProjectOverview(agent, { projectId: other.id })).code).toBe(
      'unauthorized',
    )
    expect(
      services.listProjects(agent).ok &&
        unwrap(services.listProjects(agent)).projects.map((p) => p.id),
    ).toEqual([project.id])

    const proposal = unwrap(
      services.proposeChange(agent, {
        projectId: project.id,
        baseRevision: 0,
        rationale: 'agent proposal',
        ops: [
          {
            op: 'createObject',
            type: 'core.Requirement',
            stance: 'toBe',
            attributes: {
              title: 'Tenant isolation',
              statement: 'Every query is scoped to a tenant.',
            },
            claim: { basis: 'stated' },
          },
        ],
      }),
    )
    expect(proposal.status).toBe('pending')
    expect(errorOf(services.commitProposal(agent, { proposalId: proposal.proposalId })).code).toBe(
      'unauthorized',
    )
  })

  it('is managed only by a person acting directly with grant.manage', () => {
    const { services, owner, project } = setup()
    const relayed: Caller = { ...owner, origin: 'relayed' }
    const agent: Caller = { principalId: ensureLocalAgent(services).id, origin: 'agent' }
    for (const caller of [relayed, agent]) {
      expect(
        errorOf(services.issueAgentToken(caller, { projectId: project.id, label: 'x' })).code,
      ).toBe('unauthorized')
      expect(errorOf(services.listAgentTokens(caller, { projectId: project.id })).code).toBe(
        'unauthorized',
      )
    }
    expect(
      errorOf(
        services.issueAgentToken(owner, { projectId: project.id, label: 'x', expiresInDays: 31 }),
      ).code,
    ).toBe('invalid')
  })

  it('stops working when revoked or expired, and rejects anything malformed', () => {
    const { services, owner, project, advanceDays } = setup()
    const a = unwrap(
      services.issueAgentToken(owner, { projectId: project.id, label: 'a', expiresInDays: 1 }),
    )
    const b = unwrap(
      services.issueAgentToken(owner, { projectId: project.id, label: 'b', expiresInDays: 7 }),
    )
    expect(
      unwrap(services.revokeAgentToken(owner, { tokenId: b.summary.id })).revokedAt,
    ).not.toBeNull()
    expect(services.authenticateAgentToken(b.token)).toBeUndefined()
    expect(services.authenticateAgentToken(a.token)).toBeDefined()
    advanceDays(2)
    expect(services.authenticateAgentToken(a.token)).toBeUndefined()
    const agent: Caller = { principalId: a.summary.principalId, origin: 'agent' }
    expect(errorOf(services.getProjectOverview(agent, { projectId: project.id })).code).toBe(
      'unauthorized',
    )
    for (const bad of ['', 'kalyth_at_', `${a.token}x`, a.token.toUpperCase(), 'Bearer x']) {
      expect(services.authenticateAgentToken(bad)).toBeUndefined()
    }
  })

  it('keeps token rows: no deletes, and a revocation happens once', () => {
    const { services, owner, project } = setup()
    const t = unwrap(services.issueAgentToken(owner, { projectId: project.id, label: 'a' }))
    const db = services.store.db
    expect(() => db.prepare('DELETE FROM agent_tokens').run()).toThrow(/never deleted/)
    expect(() =>
      db.prepare("UPDATE agent_tokens SET expires_at = '2099-01-01T00:00:00.000Z'").run(),
    ).toThrow(/only be revoked/)
    unwrap(services.revokeAgentToken(owner, { tokenId: t.summary.id }))
    expect(() =>
      db.prepare("UPDATE agent_tokens SET revoked_at = '2026-01-01T00:00:00.000Z'").run(),
    ).toThrow(/only be revoked/)
  })

  it('treats tokens found in analysed excerpts as secrets', () => {
    const { services, owner, project } = setup()
    const t = unwrap(services.issueAgentToken(owner, { projectId: project.id, label: 'a' }))
    expect(findSecretRule(`MCP_TOKEN = "${t.token}"`)).toBeDefined()
  })

  it('migrates a version 1 database to version 2 in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalyth-migrate-'))
    try {
      const path = join(dir, 'k.db')
      const first = new SqliteStore(path)
      first.db.exec('DROP TABLE agent_tokens')
      first.setMeta('schema_version', '1')
      first.close()
      const reopened = new SqliteStore(path)
      expect(reopened.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
      expect(
        reopened.db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_tokens'").get(),
      ).toBeDefined()
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('decisions read model', () => {
  it('lists decisions with alternatives and their direct changes, filtered by status', () => {
    const { services, owner, project } = setup()
    const claim = { basis: 'stated' as const }
    const committed = unwrap(
      services.proposeChange(owner, {
        projectId: project.id,
        baseRevision: 0,
        rationale: 'seed',
        ops: [
          {
            op: 'createObject',
            ref: '$m',
            type: 'software.Module',
            stance: 'asIs',
            attributes: { path: 'app/models.py' },
            claim,
          },
          {
            op: 'createObject',
            ref: '$d',
            type: 'core.Decision',
            stance: 'toBe',
            attributes: { title: 'Tenancy', question: 'How?' },
            claim,
          },
          {
            op: 'createObject',
            ref: '$a',
            type: 'core.Alternative',
            stance: 'toBe',
            attributes: { title: 'Row level', summary: 'tenant_id' },
            claim,
          },
          {
            op: 'createRelation',
            type: 'alternativeOf',
            from: '$a',
            to: '$d',
            stance: 'toBe',
            claim,
          },
          {
            op: 'createRelation',
            type: 'impacts',
            from: '$a',
            to: '$m',
            stance: 'toBe',
            properties: { change: 'add tenant_id' },
            claim,
          },
        ],
      }),
    )
    unwrap(services.commitProposal(owner, { proposalId: committed.proposalId }))
    const all = unwrap(services.listDecisions(owner, { projectId: project.id }))
    expect(all.decisions).toEqual([
      expect.objectContaining({
        title: 'Tenancy',
        status: 'open',
        alternatives: [
          expect.objectContaining({
            title: 'Row level',
            directChanges: [
              expect.objectContaining({ label: 'app/models.py', change: 'add tenant_id' }),
            ],
          }),
        ],
      }),
    ])
    expect(
      unwrap(services.listDecisions(owner, { projectId: project.id, status: 'accepted' }))
        .decisions,
    ).toEqual([])
  })
})
