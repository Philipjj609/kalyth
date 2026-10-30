import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Caller, ClaimInput, OperationInput, ProjectSummary } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, SqliteStore, stateSha256, supportGroupKey } from '../src/index.ts'
import { errorOf, evidenceOp, setup, tool, unwrap } from './helpers.ts'

type Ctx = ReturnType<typeof setup>

// ---------- fixtures ----------

const meta = (extra: Record<string, unknown> = {}) => ({
  title: 'A networking book',
  authors: ['A. Author'],
  licence: 'unknown',
  quotePolicy: 'none',
  ...extra,
})

/** A document source with SourceMeta, as a library needs (ADR 0026 §7). */
function source(
  ref: string,
  options: {
    uri?: string
    meta?: Record<string, unknown>
    excerpt?: string
    locator?: string
  } = {},
): OperationInput {
  return {
    op: 'recordEvidence',
    ref,
    evidence: {
      source: {
        kind: 'document',
        uri: options.uri ?? 'urn:isbn:9780000000001',
        ...(options.locator === '' ? {} : { locator: options.locator ?? 'chapter 3' }),
        meta: meta(options.meta),
      },
      ...(options.excerpt === undefined ? {} : { excerpt: options.excerpt }),
      collectedBy: tool,
    },
  } as OperationInput
}

const imported = (...groups: string[][]): ClaimInput => ({
  basis: 'imported',
  supports: groups.map((allOf) => ({ allOf })),
})

const object = (
  ref: string,
  type: string,
  attributes: Record<string, unknown>,
  claim: ClaimInput,
): OperationInput =>
  ({ op: 'createObject', ref, type, stance: 'asIs', attributes, claim }) as OperationInput

const relation = (
  type: string,
  from: string,
  to: string,
  claim: ClaimInput,
  properties: Record<string, unknown> = {},
  ref?: string,
): OperationInput =>
  ({
    op: 'createRelation',
    ...(ref ? { ref } : {}),
    type,
    from,
    to,
    stance: 'asIs',
    properties,
    claim,
  }) as OperationInput

const concept = (ref: string, name: string, extra: Record<string, unknown>, s = '$s1') =>
  object(
    ref,
    'knowledge.Concept',
    { name, definition: `${name}, as the source defines it.`, ...extra },
    imported([s]),
  )

const pattern = (
  ref: string,
  name: string,
  claim: ClaimInput,
  extra: Record<string, unknown> = {},
) =>
  object(
    ref,
    'knowledge.Pattern',
    {
      name,
      problem: 'Clients cannot be trusted with shared state.',
      solution: 'The server runs the simulation; clients send inputs.',
      structure: 'Clients send inputs; the server simulates and sends state.',
      consequences: 'Latency is visible unless hidden by prediction.',
      ...extra,
    },
    claim,
  )

function library(ctx: Ctx, name = 'Real-time networking'): ProjectSummary {
  return unwrap(ctx.services.createProject(ctx.owner, { name, kind: 'library' }))
}

function propose(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const head = ctx.store.getProject(projectId)?.headRevision ?? 0
  return ctx.services.proposeChange(caller, {
    projectId,
    baseRevision: head,
    ops,
    rationale: 'test',
  })
}

function commit(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const p = unwrap(propose(ctx, projectId, ops, caller))
  if (p.status !== 'pending') throw new Error(`proposal ${p.status}: ${JSON.stringify(p.issues)}`)
  return unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
}

function refused(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const p = unwrap(propose(ctx, projectId, ops, caller))
  expect(p.status).toBe('invalid')
  return p.issues.map((i) => i.code)
}

/** Two sources, three concepts and one pattern with a trade-off: a minimal valid library. */
function seeded(ctx: Ctx) {
  const lib = library(ctx)
  const { refs } = commit(ctx, lib.id, [
    source('$s1'),
    source('$s2', { uri: 'https://example.org/netcode', meta: { title: 'Netcode notes' } }),
    concept('$rtt', 'Round-trip time', { kind: 'quantity', dimension: 'time' }),
    concept('$cheat', 'Cheat resistance', { kind: 'quality' }),
    concept('$det', 'Deterministic simulation', { kind: 'property', dimension: 'boolean' }),
    pattern('$auth', 'Server-authoritative simulation', imported(['$s1'], ['$s2'])),
    relation(
      'affects',
      '$auth',
      '$cheat',
      imported(['$s1']),
      { effect: 'improves', note: 'The server decides.' },
      '$aff',
    ),
  ])
  const id = (ref: string) => refs[ref] as string
  return { lib, id }
}

const objectAt = (ctx: Ctx, projectId: string, id: string) =>
  unwrap(ctx.services.queryObjects(ctx.owner, { projectId, ids: [id] })).objects[0]

const status = (ctx: Ctx, projectId: string, id: string) =>
  unwrap(ctx.services.getKnowledgeStatus(ctx.owner, { projectId, ids: [id] })).items[0]

/** A second person, with exactly the scopes given on the library. */
function person(ctx: Ctx, projectId: string, scopes: Parameters<Ctx['services']['grant']>[1]) {
  const p = ctx.services.createPrincipal('human', 'Second person')
  ctx.services.grant(p.id, scopes, projectId)
  return { principalId: p.id, origin: 'human' } as Caller
}

// ---------- tests ----------

describe('library projects (ADR 0026 §1, ADR 0030 C3)', () => {
  it('creates a library with a version 2 creation event, and keeps its kind fixed', () => {
    const ctx = setup()
    const lib = library(ctx)
    expect(lib.kind).toBe('library')
    expect(ctx.project.kind).toBe('project')
    const [event] = ctx.store.listEvents(lib.id)
    expect(event).toMatchObject({
      type: 'project.created',
      schemaVersion: 2,
      payload: { kind: 'library' },
    })
    expect(() =>
      ctx.store.db.prepare("UPDATE projects SET kind = 'project' WHERE id = ?").run(lib.id),
    ).toThrow(/kind never changes/)
  })

  it('opens a schema 3 store with every project as an ordinary project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalyth-kind-'))
    try {
      const path = join(dir, 'old.db')
      const first = new SqliteStore(path)
      // What a schema 3 store looked like: no kind column, no trigger, and a project.
      first.db.exec('ALTER TABLE proposals DROP COLUMN curation')
      first.db.exec('DROP TRIGGER projects_kind_fixed')
      first.db.exec('ALTER TABLE projects DROP COLUMN kind')
      first.setMeta('schema_version', '3')
      first.db
        .prepare(
          "INSERT INTO projects (id, name, description, created_at, created_by, head_revision) VALUES (?, 'Old', '', '2026-01-01T00:00:00.000Z', ?, 0)",
        )
        .run(`prj_${'1'.repeat(32)}`, `pcp_${'2'.repeat(32)}`)
      first.close()
      const reopened = new SqliteStore(path)
      try {
        expect(reopened.getMeta('schema_version')).toBe('5')
        expect(reopened.getProject(`prj_${'1'.repeat(32)}`)?.kind).toBe('project')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps knowledge out of projects, and code and software out of libraries (I1)', () => {
    const ctx = setup()
    const lib = library(ctx)
    expect(
      refused(ctx, ctx.project.id, [source('$s1'), pattern('$p', 'Lockstep', imported(['$s1']))]),
    ).toContain('knowledge.library_only')
    expect(
      refused(ctx, lib.id, [
        evidenceOp('$code'),
        object('$m', 'software.Module', { path: 'a.py', language: 'python' }, imported(['$code'])),
      ]),
    ).toEqual(
      expect.arrayContaining(['library.source_span_not_allowed', 'library.software_not_allowed']),
    )
    expect(
      refused(ctx, ctx.project.id, [
        {
          op: 'setMaturity',
          id: 'obj_00000000000000000000000000000001',
          maturity: 'proposed',
          reason: 'x',
        },
      ]),
    ).toContain('knowledge.not_a_library')
  })
})

describe('sources and quotes (ADR 0026 §7, ADR 0030 A5)', () => {
  it('requires SourceMeta and a locator, and applies the quote policy', () => {
    const ctx = setup()
    const lib = library(ctx)
    const cite = (ev: OperationInput) => [ev, concept('$c', 'Jitter', { kind: 'quality' }, '$e')]
    const bare: OperationInput = {
      op: 'recordEvidence',
      ref: '$e',
      evidence: {
        source: { kind: 'document', uri: 'urn:x:1', locator: 'p. 1' },
        collectedBy: tool,
      },
    }
    expect(refused(ctx, lib.id, cite(bare))).toContain('library.source_meta_required')
    expect(refused(ctx, lib.id, cite(source('$e', { locator: '' })))).toContain(
      'library.locator_required',
    )
    expect(refused(ctx, lib.id, cite(source('$e', { excerpt: 'a quote' })))).toContain(
      'library.quote_not_allowed',
    )
    expect(
      refused(
        ctx,
        lib.id,
        cite(source('$e', { excerpt: 'x'.repeat(601), meta: { quotePolicy: 'excerpt' } })),
      ),
    ).toContain('library.quote_too_long')
    const quotes = ['$q1', '$q2', '$q3', '$q4'].map((r, i) =>
      source(r, { excerpt: `quote ${i}`, meta: { quotePolicy: 'excerpt' } }),
    )
    expect(
      refused(ctx, lib.id, [
        ...quotes,
        object(
          '$c',
          'knowledge.Concept',
          { name: 'Jitter', definition: 'd', kind: 'quality' },
          imported(['$q1', '$q2', '$q3', '$q4']),
        ),
      ]),
    ).toContain('library.too_many_quotes')
  })

  it('refuses uncited knowledge (I2)', () => {
    const ctx = setup()
    const lib = library(ctx)
    expect(
      refused(ctx, lib.id, [
        object(
          '$c',
          'knowledge.Concept',
          { name: 'Jitter', definition: 'd', kind: 'quality' },
          { basis: 'stated' },
        ),
      ]),
    ).toContain('library.support_required')
  })

  it('lets only a curator confirm a licence: an agent records unknown only', () => {
    const ctx = setup()
    const lib = library(ctx)
    const error = errorOf(
      propose(ctx, lib.id, [source('$e', { meta: { licence: 'proprietary' } })], ctx.agent),
    )
    expect(error).toMatchObject({ code: 'unauthorized', requiredScopes: ['knowledge.curate'] })
    expect(unwrap(propose(ctx, lib.id, [source('$e')], ctx.agent)).status).toBe('pending')
    // Outside libraries, evidence keeps its ordinary permissions (A10).
    const inProject = unwrap(
      propose(ctx, ctx.project.id, [source('$e', { meta: { licence: 'proprietary' } })], ctx.agent),
    )
    expect(inProject.status).toBe('pending')
    const committer = person(ctx, ctx.project.id, ['project.read', 'proposal.commit'])
    unwrap(ctx.services.commitProposal(committer, { proposalId: inProject.proposalId }))
  })

  it('never reports a verified locator as a matched quotation (A9)', () => {
    const ctx = setup()
    const lib = library(ctx)
    const { refs } = commit(ctx, lib.id, [
      source('$q', { excerpt: 'Never trust the client.', meta: { quotePolicy: 'excerpt' } }),
      concept('$c', 'Trust boundary', { kind: 'quality' }, '$q'),
      source('$p', { uri: 'urn:x:p' }),
      concept('$d', 'Authority', { kind: 'quality' }, '$p'),
    ])
    commit(ctx, lib.id, [
      {
        op: 'verifySource',
        evidence: refs.$q as string,
        status: 'verified',
        method: 'manual',
        note: 'n',
      },
      {
        op: 'verifySource',
        evidence: refs.$p as string,
        status: 'verified',
        method: 'manual',
        note: 'n',
      },
    ])
    const quoted = status(ctx, lib.id, refs.$c as string)?.groups[0]?.sources[0]
    expect(quoted).toMatchObject({
      quote: 'stored',
      quoteMatch: 'unchecked',
      locatorVerification: 'verified',
    })
    const paraphrase = status(ctx, lib.id, refs.$d as string)?.groups[0]?.sources[0]
    expect(paraphrase).toMatchObject({
      quote: 'none',
      quoteMatch: 'notApplicable',
      locatorVerification: 'verified',
    })
  })
})

describe('types and relations (ADR 0026 §2 to §5, ADR 0028 §7)', () => {
  it('refuses isA and refines cycles (I6)', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const { refs } = commit(ctx, lib.id, [
      source('$s'),
      concept('$a', 'Latency', { kind: 'quality' }, '$s'),
      relation('isA', id('$cheat'), '$a', imported(['$s'])),
      pattern('$p2', 'Authority with prediction', imported(['$s']), {}),
      relation('refines', '$p2', id('$auth'), imported(['$s'])),
      relation('affects', '$p2', id('$cheat'), imported(['$s']), { effect: 'improves', note: 'n' }),
    ])
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        relation('isA', refs.$a as string, id('$cheat'), imported(['$s'])),
      ]),
    ).toContain('relation.cycle')
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        relation('refines', id('$auth'), refs.$p2 as string, imported(['$s'])),
      ]),
    ).toContain('relation.cycle')
  })

  it('needs a trade-off on every pattern, or an open question about it, and a scope on principles', () => {
    const ctx = setup()
    const lib = library(ctx)
    expect(
      refused(ctx, lib.id, [source('$s1'), pattern('$p', 'Lockstep', imported(['$s1']))]),
    ).toContain('pattern.tradeoff_required')
    commit(ctx, lib.id, [
      source('$s1'),
      pattern('$p', 'Lockstep', imported(['$s1'])),
      object(
        '$q',
        'core.Question',
        { text: 'What does lockstep trade away?', inquiryRole: 'exploratory' },
        { basis: 'stated' },
      ),
      relation('concerns', '$q', '$p', { basis: 'stated' }),
    ])
    expect(
      refused(ctx, lib.id, [
        source('$s1'),
        object(
          '$r',
          'knowledge.Principle',
          { statement: 'Never trust the client.', rationale: 'Clients can be modified.' },
          imported(['$s1']),
        ),
      ]),
    ).toContain('attribute.invalid')
  })

  it('checks a condition against its concept, and refuses conditions that can never hold together', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const condition = (ref: string, test: Record<string, unknown>, subject = id('$rtt')) =>
      object(ref, 'knowledge.Condition', { subject, test, text: 'a condition' }, imported(['$s']))
    expect(
      refused(ctx, lib.id, [source('$s'), condition('$c', { op: 'gt', value: '100', unit: 'MB' })]),
    ).toContain('condition.test_invalid')
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        condition('$c', { op: 'is', value: true }, id('$cheat')),
      ]),
    ).toContain('condition.subject_invalid')
    // 0.1 s and 150 ms: no value is below the first and above the second.
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        condition('$low', { op: 'lt', value: '0.1', unit: 's' }),
        condition('$high', { op: 'gt', value: '150', unit: 'ms' }),
        relation('appliesWhen', id('$auth'), '$low', imported(['$s'])),
        relation('appliesWhen', id('$auth'), '$high', imported(['$s'])),
      ]),
    ).toContain('condition.unsatisfiable')
    // A condition may name a concept created in the same proposal, by local ref.
    const { refs } = commit(ctx, lib.id, [
      source('$s'),
      concept('$players', 'Players per match', { kind: 'quantity', dimension: 'count' }, '$s'),
      condition('$few', { op: 'le', value: '8.0', unit: '1' }, '$players'),
      relation('appliesWhen', id('$auth'), '$few', imported(['$s'])),
    ])
    const few = objectAt(ctx, lib.id, refs.$few as string)
    expect(few?.attributes).toMatchObject({ subject: refs.$players, test: { value: '8' } })
  })

  it('validates affects properties and concept kinds', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        relation('affects', id('$auth'), id('$cheat'), imported(['$s']), { effect: 'helps' }),
      ]),
    ).toContain('relation.properties_invalid')
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        relation('affects', id('$auth'), id('$rtt'), imported(['$s']), {
          effect: 'worsens',
          note: 'n',
        }),
      ]),
    ).toContain('relation.concept_kind')
  })
})

describe('maturity (ADR 0026 §4, ADR 0030 C7 and I3)', () => {
  it('never creates an item as established, and changes maturity only through setMaturity', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        concept('$x', 'Jitter', { kind: 'quality', maturity: 'established' }, '$s'),
      ]),
    ).toContain('attribute.reserved')
    expect(
      refused(ctx, lib.id, [
        source('$s'),
        concept('$x', 'Jitter', { kind: 'quality', maturityReason: 'because' }, '$s'),
      ]),
    ).toContain('attribute.reserved')
    const p = unwrap(
      propose(ctx, lib.id, [
        { op: 'updateObject', id: id('$auth'), set: { maturity: 'deprecated' } },
      ]),
    )
    expect(p.issues[0]).toMatchObject({
      code: 'attribute.reserved',
      message: expect.stringContaining('setMaturity'),
    })
    expect(
      refused(ctx, lib.id, [
        { op: 'setMaturity', id: id('$cheat'), maturity: 'hypothesis', reason: 'r' },
      ]),
    ).toContain('maturity.transition_invalid')
  })

  it('establishes an item only when every group is reviewed and every source verified', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    const establish: OperationInput = {
      op: 'setMaturity',
      id: auth,
      maturity: 'established',
      reason: 'reviewed',
    }
    expect(refused(ctx, lib.id, [establish])).toContain('maturity.established_gaps')

    const groups = objectAt(ctx, lib.id, auth)?.claim.supports.map((g) => g.allOf) ?? []
    const evidence = groups.flat()
    const verify = (e: string): OperationInput => ({
      op: 'verifySource',
      evidence: e,
      status: 'verified',
      method: 'manual',
      note: 'Opened the cited chapter; the locator points to the passage.',
    })
    const review = (allOf: string[]): OperationInput => ({
      op: 'reviewSupport',
      target: auth,
      group: { allOf },
      verdict: 'supports',
      note: 'The passage states this.',
    })
    // Reviewed but unverified is not enough.
    expect(refused(ctx, lib.id, [...groups.map(review), establish])).toContain(
      'maturity.established_gaps',
    )
    commit(ctx, lib.id, [...groups.map(review), ...evidence.map(verify), establish])
    const s = status(ctx, lib.id, auth)
    expect(s).toMatchObject({ maturity: 'established', supported: true, establishedGaps: [] })
    expect(
      s?.groups.every(
        (g) =>
          g.review === 'supports' && g.sources.every((x) => x.locatorVerification === 'verified'),
      ),
    ).toBe(true)
    expect(objectAt(ctx, lib.id, auth)?.attributes.maturityReason).toBe('reviewed')

    // A failed verification needs curation that takes the item back to proposed (A3, A7): the
    // proposal is filed for a curator, and its commit is refused until the curation is given.
    const fail: OperationInput = {
      op: 'verifySource',
      evidence: evidence[0] as string,
      status: 'failed',
      method: 'manual',
      note: 'The chapter does not say this.',
    }
    const p = unwrap(propose(ctx, lib.id, [fail]))
    expect(p.status).toBe('pending')
    expect(p.curation?.gaps.map((g) => g.id)).toEqual([auth])
    const missing = errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    expect(missing.issues.map((i) => i.code)).toEqual(['curation.required'])
    expect(unwrap(ctx.services.getProposal(ctx.owner, { proposalId: p.proposalId })).status).toBe(
      'pending',
    )
    unwrap(
      ctx.services.commitProposal(ctx.owner, {
        proposalId: p.proposalId,
        curation: [
          { op: 'setMaturity', id: auth, maturity: 'proposed', reason: 'a source failed' },
        ],
      }),
    )
    const after = status(ctx, lib.id, auth)
    expect(after?.maturity).toBe('proposed')
    expect(after?.groups.map((g) => g.counts)).toContain(false)
    // In one proposal, the set-back still works as before.
    commit(ctx, lib.id, [
      { ...fail, status: 'verified', note: 'Re-checked: the passage is there.' } as OperationInput,
    ])
  })

  it('needs a verified, attributable source reviewed as fully supporting (A8)', () => {
    const ctx = setup()
    const lib = library(ctx)
    const statement: OperationInput = {
      op: 'recordEvidence',
      ref: '$st',
      evidence: {
        source: { kind: 'statement', statedBy: ctx.ownerPrincipal.id },
        excerpt: 'In my experience this holds.',
        collectedBy: tool,
      },
    }
    const { refs } = commit(ctx, lib.id, [
      statement,
      concept('$j', 'Jitter', { kind: 'quality' }, '$st'),
      source('$s'),
      concept('$k', 'Packet loss', { kind: 'quality' }, '$s'),
    ])
    const establish = (id: string): OperationInput => ({
      op: 'setMaturity',
      id,
      maturity: 'established',
      reason: 'r',
    })
    // Statement-only support, reviewed as supporting, is not enough.
    const onlyStatement = refused(ctx, lib.id, [
      {
        op: 'reviewSupport',
        target: refs.$j as string,
        group: { allOf: [refs.$st as string] },
        verdict: 'supports',
        note: 'n',
      },
      establish(refs.$j as string),
    ])
    expect(onlyStatement).toContain('maturity.established_gaps')
    // A verified source reviewed only as partly supporting is not enough either.
    const k = refs.$k as string
    const s = refs.$s as string
    const verify: OperationInput = {
      op: 'verifySource',
      evidence: s,
      status: 'verified',
      method: 'manual',
      note: 'n',
      targets: [k],
    }
    expect(
      refused(ctx, lib.id, [
        verify,
        {
          op: 'reviewSupport',
          target: k,
          group: { allOf: [s] },
          verdict: 'partly',
          scopeLimit: 'LAN play',
          note: 'n',
        },
        establish(k),
      ]),
    ).toContain('maturity.established_gaps')
    commit(ctx, lib.id, [
      verify,
      { op: 'reviewSupport', target: k, group: { allOf: [s] }, verdict: 'supports', note: 'n' },
      establish(k),
    ])
    expect(status(ctx, lib.id, k)?.maturity).toBe('established')
  })
})

/** Reviews and verifies both groups of the seeded pattern, and establishes it. */
function establishAuth(ctx: Ctx, libId: string, auth: string) {
  const groups = objectAt(ctx, libId, auth)?.claim.supports.map((g) => g.allOf) ?? []
  commit(ctx, libId, [
    ...groups.map(
      (allOf): OperationInput => ({
        op: 'reviewSupport',
        target: auth,
        group: { allOf },
        verdict: 'supports',
        note: 'n',
      }),
    ),
    ...groups.flat().map(
      (e): OperationInput => ({
        op: 'verifySource',
        evidence: e,
        status: 'verified',
        method: 'manual',
        note: 'n',
      }),
    ),
    { op: 'setMaturity', id: auth, maturity: 'established', reason: 'reviewed' },
  ])
}

describe('changes to established knowledge (ADR 0030 A7)', () => {
  it('files an agent change for a curator, who commits it with the curation it needs', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    establishAuth(ctx, lib.id, auth)
    const groups = (objectAt(ctx, lib.id, auth)?.claim.supports ?? []).map((g) => ({
      allOf: g.allOf,
    }))
    // An agent proposes a new source for the established pattern.
    const p = unwrap(
      propose(
        ctx,
        lib.id,
        [
          source('$new', { uri: 'urn:x:new' }),
          {
            op: 'updateObject',
            id: auth,
            set: {},
            claim: { basis: 'imported', supports: [...groups, { allOf: ['$new'] }] },
          },
        ],
        ctx.agent,
      ),
    )
    expect(p.status).toBe('pending')
    expect(p.issues).toEqual([])
    expect(p.curation?.required).toEqual([auth])
    expect(p.curation?.gaps[0]?.gaps.join(' ')).toMatch(/unreviewed/)

    // A person who may commit, but not curate, cannot accept it.
    const committer = person(ctx, lib.id, ['project.read', 'proposal.commit'])
    expect(
      errorOf(ctx.services.commitProposal(committer, { proposalId: p.proposalId })),
    ).toMatchObject({
      code: 'unauthorized',
      requiredScopes: ['knowledge.curate'],
    })
    // Nor can that person give curation with the commit.
    const newEvidence = unwrap(
      ctx.services.getProposal(ctx.owner, { proposalId: p.proposalId }),
    ).ops.find((op) => op.op === 'recordEvidence')
    const e = newEvidence?.op === 'recordEvidence' ? newEvidence.id : ''
    const curation = [
      {
        op: 'reviewSupport',
        target: auth,
        group: { allOf: [e] },
        verdict: 'supports',
        note: 'Checked.',
      },
      {
        op: 'verifySource',
        evidence: e,
        status: 'verified',
        method: 'manual',
        note: 'Found it.',
        targets: [auth],
      },
    ]
    expect(
      errorOf(ctx.services.commitProposal(committer, { proposalId: p.proposalId, curation })).code,
    ).toBe('unauthorized')
    // The curator, without curation, is told what is missing; the proposal stays pending.
    expect(
      errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).issues[0]?.code,
    ).toBe('curation.required')
    const result = unwrap(
      ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId, curation }),
    )
    expect(result.curation).toHaveLength(2)
    const after = objectAt(ctx, lib.id, auth)
    expect(after?.attributes.maturity).toBe('established')
    expect(after?.claim.supports.at(-1)?.review).toMatchObject({
      verdict: 'supports',
      reviewer: ctx.ownerPrincipal.id,
    })
    // The curation is in the same change set: one event wrote it all.
    const event = ctx.store.listEvents(lib.id).at(-1)
    expect(event?.type === 'changeSet.committed' && event.payload.proposedBy).toBe(
      ctx.agentPrincipal.id,
    )
    expect(event?.actor).toBe(ctx.ownerPrincipal.id)
  })

  it('needs a curator for any change to accepted knowledge, but not for a challenge', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    establishAuth(ctx, lib.id, auth)
    const committer = person(ctx, lib.id, ['project.read', 'proposal.commit'])
    const filed = (ops: OperationInput[]) => unwrap(propose(ctx, lib.id, ops, ctx.agent))

    const rename = filed([{ op: 'updateObject', id: auth, set: { aliases: ['server authority'] } }])
    expect(rename.curation).toEqual({ required: [auth], gaps: [] })
    expect(
      errorOf(ctx.services.commitProposal(committer, { proposalId: rename.proposalId })).code,
    ).toBe('unauthorized')

    const retire = filed([{ op: 'retireRelation', id: id('$aff'), reason: 'disputed' }])
    expect(retire.curation?.required).toEqual([auth])

    // A challenge leaves the item unchanged: an ordinary committer may accept it.
    const challenge = filed([
      source('$c', { uri: 'urn:x:c' }),
      pattern('$alt', 'Client authority with audits', imported(['$c'])),
      relation('affects', '$alt', id('$cheat'), imported(['$c']), { effect: 'worsens', note: 'n' }),
      relation('contradicts', '$alt', auth, imported(['$c'])),
    ])
    expect(challenge.curation).toBeUndefined()
    unwrap(ctx.services.commitProposal(committer, { proposalId: challenge.proposalId }))
    expect(status(ctx, lib.id, auth)).toMatchObject({
      maturity: 'established',
      dispute: { status: 'disputed' },
    })

    // The curator accepts the rename; the item stays established.
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: rename.proposalId }))
    expect(objectAt(ctx, lib.id, auth)?.attributes).toMatchObject({
      maturity: 'established',
      aliases: ['server authority'],
    })
  })
})

describe('support reviews (ADR 0026 §6, ADR 0030 A1, C6)', () => {
  it('addresses groups by key; doesNotSupport removes a group but never the last', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    const [g1, g2] = objectAt(ctx, lib.id, auth)?.claim.supports ?? []
    const key1 = supportGroupKey(g1?.allOf ?? [])
    const review = (
      group: string,
      verdict: string,
      extra: Record<string, unknown> = {},
    ): OperationInput =>
      ({ op: 'reviewSupport', target: auth, group, verdict, note: 'n', ...extra }) as OperationInput
    expect(refused(ctx, lib.id, [review(key1, 'partly')])).toContain('support.scope_limit_required')
    expect(refused(ctx, lib.id, [review(`sg_${'0'.repeat(32)}`, 'supports')])).toContain(
      'support.group_not_found',
    )
    commit(ctx, lib.id, [review(key1, 'partly', { scopeLimit: 'two-player games only' })])
    expect(status(ctx, lib.id, auth)?.groups[0]).toMatchObject({
      review: 'partly',
      scopeLimit: 'two-player games only',
    })

    commit(ctx, lib.id, [review(supportGroupKey(g2?.allOf ?? []), 'doesNotSupport')])
    expect(objectAt(ctx, lib.id, auth)?.claim.supports).toHaveLength(1)
    expect(refused(ctx, lib.id, [review(key1, 'doesNotSupport')])).toContain(
      'claim.support_required',
    )
  })

  it('keeps the reviews of unchanged groups when a claim is replaced, and drops reviews a client sends', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    const [g1, g2] = (objectAt(ctx, lib.id, auth)?.claim.supports ?? []).map((g) => g.allOf)
    commit(ctx, lib.id, [
      {
        op: 'reviewSupport',
        target: auth,
        group: { allOf: g1 ?? [] },
        verdict: 'supports',
        note: 'n',
      },
      {
        op: 'reviewSupport',
        target: auth,
        group: { allOf: g2 ?? [] },
        verdict: 'supports',
        note: 'n',
      },
    ])
    const smuggled = {
      basis: 'imported',
      supports: [
        {
          allOf: g1,
          review: {
            verdict: 'supports',
            reviewer: ctx.agentPrincipal.id,
            reviewedAt: '2026-01-01T00:00:00.000Z',
            note: 'forged',
          },
        },
        { allOf: [...(g2 ?? []), '$s3'] },
      ],
    } as unknown as ClaimInput
    commit(ctx, lib.id, [
      source('$s3', { uri: 'urn:x:3' }),
      { op: 'updateObject', id: auth, set: {}, claim: smuggled },
    ])
    const [kept, changed] = objectAt(ctx, lib.id, auth)?.claim.supports ?? []
    expect(kept?.review).toMatchObject({
      verdict: 'supports',
      reviewer: ctx.ownerPrincipal.id,
      note: 'n',
    })
    expect(changed?.review).toBeUndefined()

    // Nothing an agent submits in a new claim is stored as a review.
    const { refs } = commit(
      ctx,
      lib.id,
      [
        source('$s4', { uri: 'urn:x:4' }),
        {
          ...(concept('$j', 'Jitter', { kind: 'quality' }, '$s4') as object),
          claim: {
            basis: 'imported',
            supports: [{ allOf: ['$s4'], review: { verdict: 'supports' } }],
          },
        } as unknown as OperationInput,
      ],
      ctx.agent,
    )
    expect(objectAt(ctx, lib.id, refs.$j as string)?.claim.supports[0]?.review).toBeUndefined()
  })

  it('goes stale when the reviewed record changed after the proposal was made', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    const [g1] = objectAt(ctx, lib.id, auth)?.claim.supports ?? []
    const p = unwrap(
      propose(ctx, lib.id, [
        {
          op: 'reviewSupport',
          target: auth,
          group: supportGroupKey(g1?.allOf ?? []),
          verdict: 'supports',
          note: 'n',
        },
      ]),
    )
    commit(ctx, lib.id, [
      { op: 'updateObject', id: auth, set: { aliases: ['authoritative server'] } },
    ])
    expect(errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).code).toBe(
      'stale',
    )
  })
})

describe('source verification (ADR 0030 A3)', () => {
  it('verifies every citing claim when no targets are given, one version each', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const s1 = objectAt(ctx, lib.id, id('$rtt'))?.claim.supports[0]?.allOf[0] as string
    const p = unwrap(
      propose(ctx, lib.id, [
        { op: 'verifySource', evidence: s1, status: 'verified', method: 'manual', note: 'checked' },
      ]),
    )
    const proposal = unwrap(ctx.services.getProposal(ctx.owner, { proposalId: p.proposalId }))
    const op = proposal.ops[0]
    // Every claim citing $s1: three concepts, the pattern and the affects relation.
    expect(op).toMatchObject({ op: 'verifySource', allCiting: true })
    expect(op?.op === 'verifySource' && op.targets).toHaveLength(5)
    expect(proposal.writeSet).toHaveLength(5)
    const result = unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    const event = ctx.store.listEvents(lib.id).at(-1)
    expect(event?.type === 'changeSet.committed' && event.payload.writes).toHaveLength(5)
    expect(result.revision).toBe(2)
    expect(status(ctx, lib.id, id('$rtt'))?.groups[0]?.sources[0]?.locatorVerification).toBe(
      'verified',
    )
  })

  it('is conflicting when the citing claims changed between proposal and commit', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const s1 = objectAt(ctx, lib.id, id('$rtt'))?.claim.supports[0]?.allOf[0] as string
    const p = unwrap(
      propose(ctx, lib.id, [
        { op: 'verifySource', evidence: s1, status: 'verified', method: 'manual', note: 'checked' },
      ]),
    )
    commit(ctx, lib.id, [
      concept('$new', 'Tick rate', { kind: 'quantity', dimension: 'frequency' }, s1),
    ])
    const error = errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    expect(error.code).toBe('conflicting')
    expect(error.issues.map((i) => i.code)).toContain('verify.citing_claims_changed')
  })

  it('enforces methods and transitions', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const s1 = objectAt(ctx, lib.id, id('$rtt'))?.claim.supports[0]?.allOf[0] as string
    const v = (extra: Record<string, unknown>): OperationInput =>
      ({
        op: 'verifySource',
        evidence: s1,
        note: 'n',
        targets: [id('$rtt')],
        ...extra,
      }) as OperationInput
    expect(refused(ctx, lib.id, [v({ status: 'verified', method: 'retrievedHash' })])).toContain(
      'verify.hash_required',
    )
    expect(
      refused(ctx, lib.id, [
        v({ status: 'verified', method: 'manual', retrievedSha256: 'a'.repeat(64) }),
      ]),
    ).toContain('verify.hash_unexpected')
    expect(refused(ctx, lib.id, [v({ status: 'unverified', method: 'manual' })])).toContain(
      'verify.no_change',
    )
    const s2 = objectAt(ctx, lib.id, id('$auth'))?.claim.supports[1]?.allOf[0] as string
    expect(
      refused(ctx, lib.id, [v({ evidence: s2, status: 'verified', method: 'manual' })]),
    ).toContain('verify.not_cited')
    commit(ctx, lib.id, [v({ status: 'failed', method: 'manual' })])
    commit(ctx, lib.id, [v({ status: 'unverified', method: 'manual' })])
    expect(status(ctx, lib.id, id('$rtt'))?.groups[0]?.sources[0]?.locatorVerification).toBe(
      'unverified',
    )
    const statement: OperationInput = {
      op: 'recordEvidence',
      ref: '$st',
      evidence: {
        source: { kind: 'statement', statedBy: ctx.ownerPrincipal.id },
        excerpt: 'I say so.',
        collectedBy: tool,
      },
    }
    const { refs } = commit(ctx, lib.id, [
      statement,
      concept('$q', 'Fairness', { kind: 'quality' }, '$st'),
    ])
    expect(
      refused(ctx, lib.id, [
        {
          op: 'verifySource',
          evidence: refs.$st as string,
          status: 'verified',
          method: 'manual',
          note: 'n',
        },
      ]),
    ).toContain('verify.kind_not_verifiable')
  })
})

describe('curation permissions (ADR 0030 A2)', () => {
  const curationOps = (ctx: Ctx, libId: string, id: (r: string) => string): OperationInput[] => {
    const [g] = objectAt(ctx, libId, id('$auth'))?.claim.supports ?? []
    return [
      { op: 'setMaturity', id: id('$auth'), maturity: 'deprecated', reason: 'r' },
      {
        op: 'reviewSupport',
        target: id('$auth'),
        group: supportGroupKey(g?.allOf ?? []),
        verdict: 'supports',
        note: 'n',
      },
      {
        op: 'verifySource',
        evidence: g?.allOf[0] as string,
        status: 'verified',
        method: 'manual',
        note: 'n',
      },
    ]
  }

  it('refuses curation proposed by an agent, a relayed instruction or a person without the scope', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const relayed: Caller = { principalId: ctx.ownerPrincipal.id, origin: 'relayed' }
    const noCurate = person(ctx, lib.id, ['project.read', 'proposal.create', 'proposal.commit'])
    for (const op of curationOps(ctx, lib.id, id)) {
      for (const caller of [ctx.agent, relayed, noCurate]) {
        const error = errorOf(propose(ctx, lib.id, [op], caller))
        expect(error).toMatchObject({ code: 'unauthorized', requiredScopes: ['knowledge.curate'] })
      }
    }
  })

  it('checks the committer and the proposer again at commit', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const [op] = curationOps(ctx, lib.id, id)
    const committer = person(ctx, lib.id, ['project.read', 'proposal.commit'])
    const p = unwrap(propose(ctx, lib.id, [op as OperationInput]))
    expect(
      errorOf(ctx.services.commitProposal(committer, { proposalId: p.proposalId })),
    ).toMatchObject({
      code: 'unauthorized',
      requiredScopes: ['knowledge.curate'],
    })
    expect(
      errorOf(
        ctx.services.commitProposal(
          { ...ctx.owner, origin: 'agent' },
          { proposalId: p.proposalId },
        ),
      ).code,
    ).toBe('unauthorized')

    // A curator whose grant expires before the commit cannot have it committed by someone else.
    const curator = ctx.services.createPrincipal('human', 'Temporary curator')
    ctx.services.grant(curator.id, ['project.read', 'proposal.create', 'knowledge.curate'], lib.id)
    const q = unwrap(
      propose(ctx, lib.id, [op as OperationInput], { principalId: curator.id, origin: 'human' }),
    )
    expect(q.status).toBe('pending')
    ctx.store.db
      .prepare('UPDATE grants SET expires_at = ? WHERE principal_id = ?')
      .run('2000-01-01T00:00:00.000Z', curator.id)
    expect(errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: q.proposalId })).code).toBe(
      'unauthorized',
    )
    expect(unwrap(ctx.services.getProposal(ctx.owner, { proposalId: q.proposalId })).status).toBe(
      'pending',
    )
  })

  it('grants knowledge.curate to people only', () => {
    const ctx = setup()
    expect(() => ctx.services.grant(ctx.agentPrincipal.id, ['knowledge.curate'])).toThrow(
      /human principal/,
    )
  })
})

describe('dispute (ADR 0026 §4, ADR 0030 C4)', () => {
  it('is computed from contradicts and contradictedBy, and never changes maturity', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const { refs } = commit(ctx, lib.id, [
      source('$s'),
      pattern('$lock', 'Deterministic lockstep', imported(['$s']), {}),
      relation('affects', '$lock', id('$cheat'), imported(['$s']), { effect: 'mixed', note: 'n' }),
      object(
        '$h',
        'knowledge.Pattern',
        {
          name: 'A new idea',
          problem: 'p',
          solution: 's',
          structure: 's',
          consequences: 'c',
          maturity: 'hypothesis',
        },
        imported(['$s']),
      ),
      relation('affects', '$h', id('$cheat'), imported(['$s']), { effect: 'worsens', note: 'n' }),
      relation('contradicts', '$h', id('$auth'), imported(['$s'])),
    ])
    // A hypothesis does not dispute anything.
    expect(status(ctx, lib.id, id('$auth'))?.dispute.status).toBe('none')
    commit(ctx, lib.id, [
      source('$s'),
      relation('contradicts', refs.$lock as string, id('$auth'), imported(['$s'])),
    ])
    expect(status(ctx, lib.id, id('$auth'))?.dispute).toMatchObject({
      status: 'disputed',
      by: [refs.$lock],
    })
    commit(ctx, lib.id, [
      { op: 'setMaturity', id: refs.$lock as string, maturity: 'deprecated', reason: 'withdrawn' },
    ])
    expect(status(ctx, lib.id, id('$auth'))).toMatchObject({
      maturity: 'proposed',
      dispute: { status: 'none' },
    })

    const { refs: more } = commit(ctx, lib.id, [
      source('$s'),
      source('$against', { uri: 'urn:x:against' }),
      object(
        '$c',
        'knowledge.Concept',
        { name: 'Bandwidth', definition: 'd', kind: 'quality' },
        { basis: 'imported', supports: [{ allOf: ['$s'] }], contradictedBy: ['$against'] },
      ),
    ])
    expect(status(ctx, lib.id, more.$c as string)?.dispute.status).toBe('disputed')
    expect(objectAt(ctx, lib.id, more.$c as string)?.attributes).not.toHaveProperty('dispute')
  })
})

describe('replay, export and import (ADR 0030 §5, I5)', () => {
  it('round-trips a curated library, with reviews, verifications and SourceMeta', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const [g] = objectAt(ctx, lib.id, id('$auth'))?.claim.supports ?? []
    commit(ctx, lib.id, [
      {
        op: 'reviewSupport',
        target: id('$auth'),
        group: { allOf: g?.allOf ?? [] },
        verdict: 'supports',
        note: 'n',
      },
      {
        op: 'verifySource',
        evidence: g?.allOf[0] as string,
        status: 'verified',
        method: 'manual',
        licence: 'proprietary',
        note: 'n',
      },
    ])
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: lib.id }))
    expect(bundle.project.kind).toBe('library')
    expect(new Set(bundle.events.map((e) => e.schemaVersion))).toEqual(new Set([2]))
    const target = new SqliteStore(':memory:')
    const summary = unwrap(importProjectExport(target, JSON.parse(JSON.stringify(bundle))))
    expect(summary.stateSha256).toBe(stateSha256(ctx.store, lib.id))
    expect(stateSha256(target, lib.id)).toBe(bundle.stateSha256)
    expect(target.getProject(lib.id)?.kind).toBe('library')
  })

  it('replays curation given at commit exactly, from the events alone', () => {
    const ctx = setup()
    const { lib, id } = seeded(ctx)
    const auth = id('$auth')
    establishAuth(ctx, lib.id, auth)
    const p = unwrap(
      propose(
        ctx,
        lib.id,
        [{ op: 'updateObject', id: auth, set: { aliases: ['authority'] } }],
        ctx.agent,
      ),
    )
    unwrap(
      ctx.services.commitProposal(ctx.owner, {
        proposalId: p.proposalId,
        curation: [
          { op: 'setMaturity', id: auth, maturity: 'proposed', reason: 'renamed; re-review' },
        ],
      }),
    )
    expect(objectAt(ctx, lib.id, auth)?.attributes.maturity).toBe('proposed')
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: lib.id }))
    const target = new SqliteStore(':memory:')
    unwrap(importProjectExport(target, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(target, lib.id)).toBe(stateSha256(ctx.store, lib.id))
  })

  it('imports a v0.1.0 export of version 1 events, and replays a log of version 1 and 2 events', () => {
    const template = JSON.parse(
      readFileSync(new URL('../../../deploy/demo/template.json', import.meta.url), 'utf8'),
    )
    expect(new Set(template.events.map((e: { schemaVersion: number }) => e.schemaVersion))).toEqual(
      new Set([1]),
    )
    const ctx = setup()
    const imported1 = unwrap(importProjectExport(ctx.store, template))
    expect(imported1.stateSha256).toBe(template.stateSha256)
    const projectId = imported1.projectId
    expect(ctx.store.getProject(projectId)?.kind).toBe('project')
    // A new commit on the imported project adds a version 2 event to a version 1 log.
    commit(ctx, projectId, [
      {
        op: 'createObject',
        type: 'core.Requirement',
        stance: 'toBe',
        attributes: { title: 'T', statement: 'S' },
        claim: { basis: 'stated' },
      },
    ])
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId }))
    expect(new Set(bundle.events.map((e) => e.schemaVersion))).toEqual(new Set([1, 2]))
    const target = new SqliteStore(':memory:')
    unwrap(importProjectExport(target, bundle))
    expect(stateSha256(target, projectId)).toBe(stateSha256(ctx.store, projectId))
  })

  it('commits a record written twice in one proposal as its last version', () => {
    const ctx = setup()
    const lib = library(ctx)
    const { refs } = commit(ctx, lib.id, [
      source('$s'),
      concept('$c', 'Jitter', { kind: 'quality' }, '$s'),
      {
        op: 'reviewSupport',
        target: '$c',
        group: { allOf: ['$s'] },
        verdict: 'supports',
        note: 'n',
      },
    ])
    const c = objectAt(ctx, lib.id, refs.$c as string)
    expect(c?.claim.supports[0]?.review?.verdict).toBe('supports')
    expect(c?.revision).toBe(1)
  })

  it('refuses the status read model on an ordinary project', () => {
    const ctx = setup()
    expect(
      errorOf(ctx.services.getKnowledgeStatus(ctx.owner, { projectId: ctx.project.id })).code,
    ).toBe('invalid')
  })
})
