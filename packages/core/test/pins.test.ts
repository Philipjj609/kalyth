import type { Caller, ClaimInput, OperationInput, ProjectExport } from '@kalyth/contracts'
import { canonicalDecimal } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import {
  canonicalV1,
  importProjectExport,
  knowledgeVersion,
  SqliteStore,
  sha256Hex,
  stateSha256,
} from '../src/index.ts'
import { errorOf, evidenceOp, setup, tool, unwrap } from './helpers.ts'

type Ctx = ReturnType<typeof setup>

// ---------- canonical form v1 (ADR 0027 §2a, normative vectors) ----------

describe('canonical form v1', () => {
  const hash = (v: unknown) => sha256Hex(canonicalV1(v))
  it('reproduces the frozen vectors', () => {
    expect(canonicalV1({ b: 2, a: 1, c: [true, null, 'x'] })).toBe(
      '{"a":1,"b":2,"c":[true,null,"x"]}',
    )
    expect(hash({ b: 2, a: 1, c: [true, null, 'x'] })).toBe(
      'ee78b758140705c9412a940a152d297a342a670a702f44047a9baefea5579abb',
    )
    const nfc = '645fa443126a8954fc6d871912b8fc67bc2ee8feae417efe55546251962ca74d'
    expect(hash({ name: 'café' })).toBe(nfc)
    expect(hash({ name: 'café' })).toBe(nfc)
    expect(hash({ é: 1, z: 2, a: 3, '\u{1F600}': 4, '￿': 5 })).toBe(
      'e1abf7154a7a32ac09084702cc92b4b40b49f79d52e7037765805487abd60163',
    )
    expect(hash({ kind: 'point', value: canonicalDecimal('100.0'), unit: 'ms' })).toBe(
      '160785619d37a878bda7cd9778f67534b4a9e84ae3ce2cef0768081d703694a3',
    )
    const evidence = {
      kind: 'document',
      uri: 'urn:isbn:9780000000000',
      version: '2nd edition',
      locator: 'chapter 7',
      meta: {
        title: 'Example Networking Book',
        authors: ['A. Author'],
        licence: 'proprietary',
        quotePolicy: 'none',
      },
    }
    const evSha = hash(evidence)
    expect(evSha).toBe('85802ce60c18d2d21c9b2833a2624be58ce4542bb3863be315bf2b64aa34653e')
    expect(
      hash({
        type: 'knowledge.Pattern',
        typeVersion: 1,
        maturity: 'proposed',
        attributes: {
          name: 'Rollback netcode',
          aliases: [],
          problem: 'Hide latency in real-time play',
          solution: 'Predict, then roll back and replay on correction',
          structure: '',
          consequences: '',
        },
        claim: {
          basis: 'imported',
          supports: [
            {
              allOf: [{ evidence: 'evd_01a0000000000000000000000000000a', evidenceSha256: evSha }],
              review: { verdict: 'unreviewed' },
            },
          ],
        },
      }),
    ).toBe('a03662070ef94e049585876c25107cb33d6ab7c1048a1744d514407877a158bd')
    // The kernel's projection of a stored version gives the same text (V7).
    const version = knowledgeVersion(
      {
        id: `obj_${'1'.repeat(32)}`,
        type: 'knowledge.Pattern',
        typeVersion: 1,
        stance: 'asIs',
        lifecycle: 'active',
        attributes: {
          name: 'Rollback netcode',
          aliases: [],
          problem: 'Hide latency in real-time play',
          solution: 'Predict, then roll back and replay on correction',
          structure: '',
          consequences: '',
          maturity: 'proposed',
        },
        claim: {
          basis: 'imported',
          supports: [{ allOf: ['evd_01a0000000000000000000000000000a'] }],
          contradictedBy: [],
          derivedFrom: [],
        },
        revision: 3,
        retiredReason: null,
      },
      () => ({
        id: 'evd_01a0000000000000000000000000000a',
        source: evidence as never,
        excerpt: null,
        collectedBy: tool,
        collectedAt: '2026-10-30T00:00:00.000Z',
      }),
    )
    expect(version.sha256).toBe('a03662070ef94e049585876c25107cb33d6ab7c1048a1744d514407877a158bd')
  })

  it('normalises decimals, and refuses unpaired surrogates and unsafe numbers', () => {
    const pairs = [
      ['0.10', '0.1'],
      ['+5', '5'],
      ['-0.0', '0'],
      ['1.500', '1.5'],
      ['0100', '100'],
      ['-2.50', '-2.5'],
    ]
    for (const [input, out] of pairs) expect(canonicalDecimal(input as string)).toBe(out)
    expect(() => canonicalV1({ a: '\ud800' })).toThrow(/surrogate/)
    expect(() => canonicalV1({ a: 0.5 })).toThrow(/safe integer/)
    expect(() => canonicalV1({ a: 2 ** 53 })).toThrow(/safe integer/)
  })
})

// ---------- fixtures ----------

const meta = {
  title: 'A networking book',
  authors: ['A. Author'],
  licence: 'unknown',
  quotePolicy: 'none',
}
const doc = (ref: string): OperationInput =>
  ({
    op: 'recordEvidence',
    ref,
    evidence: {
      source: { kind: 'document', uri: 'urn:isbn:9780000000001', locator: 'ch. 3', meta },
      collectedBy: tool,
    },
  }) as OperationInput
const imported = (...refs: string[]): ClaimInput => ({
  basis: 'imported',
  supports: [{ allOf: refs }],
})

function run(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const head = ctx.store.getProject(projectId)?.headRevision ?? 0
  return ctx.services.proposeChange(caller, {
    projectId,
    baseRevision: head,
    ops,
    rationale: 'test',
  })
}
function commit(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const p = unwrap(run(ctx, projectId, ops, caller))
  if (p.status !== 'pending') throw new Error(`proposal ${p.status}: ${JSON.stringify(p.issues)}`)
  return unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
}
function refused(ctx: Ctx, projectId: string, ops: OperationInput[]) {
  const p = unwrap(run(ctx, projectId, ops))
  expect(p.status).toBe('invalid')
  return p.issues.map((i) => i.code)
}

/** A library at revision 1 with one concept and one pattern that affects it. */
function libraryWithPattern(ctx: Ctx) {
  const lib = unwrap(ctx.services.createProject(ctx.owner, { name: 'Networking', kind: 'library' }))
  const { refs } = commit(ctx, lib.id, [
    doc('$s'),
    {
      op: 'createObject',
      ref: '$q',
      type: 'knowledge.Concept',
      stance: 'asIs',
      attributes: { name: 'Cheat resistance', definition: 'd', kind: 'quality' },
      claim: imported('$s'),
    },
    {
      op: 'createObject',
      ref: '$p',
      type: 'knowledge.Pattern',
      stance: 'asIs',
      attributes: {
        name: 'Authoritative server',
        problem: 'p',
        solution: 's',
        structure: 's',
        consequences: 'c',
      },
      claim: imported('$s'),
    },
    {
      op: 'createRelation',
      ref: '$a',
      type: 'affects',
      from: '$p',
      to: '$q',
      stance: 'asIs',
      properties: { effect: 'improves', note: 'n' },
      claim: imported('$s'),
    },
  ])
  return { lib, pattern: refs.$p as string, affects: refs.$a as string, source: refs.$s as string }
}

const use = (library: string, revision: number, ref = '$use'): OperationInput => ({
  op: 'createObject',
  ref,
  type: 'core.LibraryUse',
  stance: 'toBe',
  attributes: { library, label: 'networking', revision, role: 'primary' },
  claim: { basis: 'stated' },
})
const pin = (
  ref: string,
  library: string,
  id: string,
  revision: number,
  target = 'object',
): OperationInput =>
  ({
    op: 'recordEvidence',
    ref,
    evidence: { source: { kind: 'knowledge', library, target, id, revision }, collectedBy: tool },
  }) as OperationInput
const citing = (ref: string, ...pins: string[]): OperationInput => ({
  op: 'createObject',
  ref,
  type: 'core.Assertion',
  stance: 'toBe',
  attributes: { statement: 'We follow the pinned pattern.' },
  claim: imported(...pins),
})

/** A project that uses the library at revision 1 and pins the pattern and its relation. */
function pinned(ctx: Ctx) {
  const l = libraryWithPattern(ctx)
  const result = commit(ctx, ctx.project.id, [
    use(l.lib.id, 1),
    pin('$pp', l.lib.id, l.pattern, 1),
    pin('$pa', l.lib.id, l.affects, 1, 'relation'),
    citing('$claim', '$pp', '$pa'),
  ])
  return {
    ...l,
    pinId: result.refs.$pp as string,
    relPinId: result.refs.$pa as string,
    useId: result.refs.$use as string,
  }
}

const pins = (ctx: Ctx, preview?: Record<string, number>) =>
  unwrap(
    ctx.services.getPinStatus(ctx.owner, {
      projectId: ctx.project.id,
      ...(preview ? { preview } : {}),
    }),
  ).pins

// ---------- pins and LibraryUse ----------

describe('pins (ADR 0027 §3, ADR 0030 §3)', () => {
  it('resolves, hashes and embeds the pinned version in the same transaction', () => {
    const ctx = setup()
    const { pinId, relPinId } = pinned(ctx)
    const [e] = unwrap(
      ctx.services.getEvidence(ctx.owner, { projectId: ctx.project.id, ids: [pinId] }),
    ).evidence
    expect(e?.source).toMatchObject({ kind: 'knowledge', versionHash: 'v1' })
    const sha = e?.source.kind === 'knowledge' ? (e.source.versionSha256 as string) : ''
    const copy = ctx.store.getContent(ctx.project.id, `cnt_${sha.slice(0, 32)}`)
    expect(sha256Hex(copy?.body ?? '')).toBe(sha)
    expect(JSON.parse(copy?.body ?? '{}')).toMatchObject({
      type: 'knowledge.Pattern',
      maturity: 'proposed',
    })
    expect(pins(ctx).map((p) => [p.evidence, p.freshness, p.resolution.state])).toEqual(
      [
        [pinId, 'current', 'resolved'],
        [relPinId, 'current', 'resolved'],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    )
  })

  it('needs one LibraryUse at the pinned revision or later (I4)', () => {
    const ctx = setup()
    const l = libraryWithPattern(ctx)
    expect(refused(ctx, ctx.project.id, [pin('$p', l.lib.id, l.pattern, 1)])).toContain(
      'pin.no_library_use',
    )
    commit(ctx, ctx.project.id, [use(l.lib.id, 0)])
    expect(refused(ctx, ctx.project.id, [pin('$p', l.lib.id, l.pattern, 1)])).toEqual(
      expect.arrayContaining(['pin.after_library_use']),
    )
  })

  it('checks every LibraryUse against the library', () => {
    const ctx = setup()
    const l = libraryWithPattern(ctx)
    expect(refused(ctx, ctx.project.id, [use(l.lib.id, 5)])).toContain('library_use.revision_ahead')
    expect(refused(ctx, ctx.project.id, [use(ctx.project.id, 0)])).toEqual(
      expect.arrayContaining(['library_use.self']),
    )
    const other = unwrap(ctx.services.createProject(ctx.owner, { name: 'Plain project' }))
    expect(refused(ctx, ctx.project.id, [use(other.id, 0)])).toContain('library_use.not_a_library')
    expect(refused(ctx, ctx.project.id, [use(`prj_${'9'.repeat(32)}`, 0)])).toContain(
      'library.not_present',
    )
    const { refs } = commit(ctx, ctx.project.id, [use(l.lib.id, 1)])
    expect(refused(ctx, ctx.project.id, [use(l.lib.id, 1, '$again')])).toContain(
      'library_use.duplicate',
    )
    expect(
      refused(ctx, ctx.project.id, [
        { op: 'updateObject', id: refs.$use as string, set: { revision: 0 } },
      ]),
    ).toContain('library_use.backwards')
  })

  it('keeps projects and libraries apart', () => {
    const ctx = setup()
    const l = libraryWithPattern(ctx)
    // A pin names a library, never an ordinary project.
    const other = unwrap(ctx.services.createProject(ctx.owner, { name: 'Plain project' }))
    expect(refused(ctx, ctx.project.id, [pin('$p', other.id, l.pattern, 0)])).toContain(
      'pin.unknown-library',
    )
    // Pinning reads the library, so a proposer who cannot read it is refused.
    const reader = ctx.services.createPrincipal('human', 'Project-only member')
    ctx.services.grant(reader.id, ['project.read', 'proposal.create'], ctx.project.id)
    const error = errorOf(
      run(ctx, ctx.project.id, [use(l.lib.id, 1), pin('$p', l.lib.id, l.pattern, 1)], {
        principalId: reader.id,
        origin: 'human',
      }),
    )
    expect(error).toMatchObject({ code: 'unauthorized', requiredScopes: ['project.read'] })
    // An observed claim never cites knowledge; a library never cites code.
    expect(
      refused(ctx, ctx.project.id, [
        use(l.lib.id, 1),
        pin('$p', l.lib.id, l.pattern, 1),
        {
          op: 'createObject',
          type: 'software.System',
          stance: 'asIs',
          attributes: { name: 'x' },
          claim: {
            basis: 'observed',
            observation: { ...tool, coverage: 'c' },
            supports: [{ allOf: ['$p'] }],
          },
        },
      ]),
    ).toContain('claim.observed_from_knowledge')
    expect(refused(ctx, l.lib.id, [evidenceOp('$code')])).toContain(
      'library.source_span_not_allowed',
    )
    // A pin to something that is not there at that revision is unresolved, never substituted.
    expect(
      refused(ctx, ctx.project.id, [use(l.lib.id, 1), pin('$p', l.lib.id, l.pattern, 0)]),
    ).toContain('pin.unknown-target')
    expect(
      refused(ctx, ctx.project.id, [
        use(l.lib.id, 1),
        {
          ...(pin('$p', l.lib.id, l.pattern, 1) as object),
          evidence: {
            source: {
              kind: 'knowledge',
              library: l.lib.id,
              target: 'object',
              id: l.pattern,
              revision: 1,
              versionSha256: 'f'.repeat(64),
            },
            collectedBy: tool,
          },
        } as OperationInput,
      ]),
    ).toContain('pin.hash_differs')
  })
})

describe('history and freshness (ADR 0027 §1, §4)', () => {
  it('keeps old pins on their content when the library moves on, and shows what changed', () => {
    const ctx = setup()
    const { lib, pattern, pinId, useId } = pinned(ctx)
    const before = pins(ctx).find((p) => p.evidence === pinId)
    // The library changes the pattern at revision 2.
    commit(ctx, lib.id, [
      { op: 'updateObject', id: pattern, set: { aliases: ['server authority'] } },
    ])
    expect(pins(ctx).find((p) => p.evidence === pinId)?.freshness).toBe('current')
    // A preview shows what moving the LibraryUse would change, before it is proposed.
    expect(pins(ctx, { [lib.id]: 2 }).find((p) => p.evidence === pinId)?.freshness).toBe('changed')
    commit(ctx, ctx.project.id, [{ op: 'updateObject', id: useId, set: { revision: 2 } }])
    const after = pins(ctx).find((p) => p.evidence === pinId)
    expect(after).toMatchObject({
      freshness: 'changed',
      comparedWith: 2,
      resolution: { state: 'resolved', from: 'embedded' },
    })
    expect(after?.resolution).toEqual(before?.resolution)
    // The relation did not change, so its pin is unchanged at the newer revision.
    expect(pins(ctx).filter((p) => p.freshness === 'unchanged')).toHaveLength(1)
    // A new pin embeds the new version beside the old one.
    const { refs } = commit(ctx, ctx.project.id, [
      pin('$new', lib.id, pattern, 2),
      citing('$c2', '$new'),
    ])
    const fresh = pins(ctx).find((p) => p.evidence === refs.$new)
    expect(fresh?.freshness).toBe('current')
    expect(fresh?.versionSha256).not.toBe(after?.versionSha256)
    expect(
      ((fresh?.resolution ?? {}) as { content: { attributes: { aliases: string[] } } }).content
        .attributes.aliases,
    ).toEqual(['server authority'])
  })
})

describe('missing and corrupted references (ADR 0027 §5a)', () => {
  it('falls back to the library when the embedded copy is lost, and reports corruption', () => {
    const ctx = setup()
    const { pinId } = pinned(ctx)
    const p = pins(ctx).find((x) => x.evidence === pinId)
    const id = `cnt_${p?.versionSha256.slice(0, 32)}`
    ctx.store.db
      .prepare('DELETE FROM content WHERE project_id = ? AND id = ?')
      .run(ctx.project.id, id)
    expect(pins(ctx).find((x) => x.evidence === pinId)?.resolution).toMatchObject({
      state: 'resolved',
      from: 'library',
    })
    ctx.store.db.exec('DROP TRIGGER content_redaction_only')
    ctx.store.db
      .prepare(
        "INSERT INTO content (project_id, id, sha256, media_type, body, created_at) VALUES (?, ?, ?, 'x', '{\"tampered\":true}', '2026-01-01T00:00:00.000Z')",
      )
      .run(ctx.project.id, id, p?.versionSha256)
    expect(pins(ctx).find((x) => x.evidence === pinId)?.resolution).toMatchObject({
      state: 'unresolved',
      reason: 'hash-mismatch',
    })
  })

  it('refuses at commit a pin whose embedded copy no longer verifies', () => {
    const ctx = setup()
    const l = libraryWithPattern(ctx)
    commit(ctx, ctx.project.id, [use(l.lib.id, 1)])
    const proposed = unwrap(
      run(ctx, ctx.project.id, [pin('$p', l.lib.id, l.pattern, 1), citing('$c', '$p')]),
    )
    ctx.store.db.exec('DROP TRIGGER content_redaction_only')
    ctx.store.db
      .prepare(
        "UPDATE content SET body = '{}' WHERE project_id = ? AND media_type LIKE 'application/vnd.kalyth.knowledge%'",
      )
      .run(ctx.project.id)
    const error = errorOf(
      ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId }),
    )
    expect(error.code).toBe('conflicting')
    expect(error.issues.map((i) => i.code)).toContain('pin.hash_mismatch')
  })

  it('resolves every pin of an exported project with no library present (I3)', () => {
    const ctx = setup()
    const { lib, useId } = pinned(ctx)
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    expect(bundle.formatVersion).toBe(2)
    expect(bundle.knowledge).toHaveLength(2)
    expect(bundle.knowledge[0]?.cites).toHaveLength(1)
    const elsewhere = setup()
    unwrap(importProjectExport(elsewhere.store, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(elsewhere.store, ctx.project.id)).toBe(
      stateSha256(ctx.store, ctx.project.id),
    )
    expect(elsewhere.store.getProject(lib.id)).toBeUndefined()
    const status = unwrap(
      elsewhere.services.getPinStatus(elsewhere.owner, { projectId: ctx.project.id }),
    ).pins
    expect(
      status.every((p) => p.resolution.state === 'resolved' && p.resolution.from === 'embedded'),
    ).toBe(true)
    expect(status.every((p) => p.freshness === 'current')).toBe(true)
    // Moving the LibraryUse needs the library's head, so it is refused while the library is absent.
    const moved = unwrap(
      elsewhere.services.proposeChange(elsewhere.owner, {
        projectId: ctx.project.id,
        baseRevision: elsewhere.store.getProject(ctx.project.id)?.headRevision ?? 0,
        ops: [{ op: 'updateObject', id: useId, set: { revision: 2 } }],
        rationale: 'move',
      }),
    )
    expect(moved.issues.map((i) => i.code)).toContain('library.not_present')
  })

  it('refuses an import whose pinned content is missing or tampered with', () => {
    const ctx = setup()
    pinned(ctx)
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    const sha = bundle.knowledge[0]?.versionSha256 as string
    const clone = (): ProjectExport => JSON.parse(JSON.stringify(bundle))
    const without = clone()
    without.content = without.content.filter((c) => c.sha256 !== sha)
    expect(
      errorOf(importProjectExport(new SqliteStore(':memory:'), without)).issues.map((i) => i.code),
    ).toContain('export.pin_hash')
    const tampered = clone()
    const body = tampered.content.find((c) => c.sha256 === sha)
    if (body) body.body = body.body?.replace('Authoritative', 'Peer-to-peer') ?? null
    expect(errorOf(importProjectExport(new SqliteStore(':memory:'), tampered)).code).toBe('invalid')
    const asFormat1 = clone() as unknown as { formatVersion: number }
    asFormat1.formatVersion = 1
    expect(
      errorOf(importProjectExport(new SqliteStore(':memory:'), asFormat1)).issues.map(
        (i) => i.code,
      ),
    ).toContain('export.pins_need_format_2')
  })

  it('replays deterministically: two imports of one export hash the same', () => {
    const ctx = setup()
    pinned(ctx)
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    const a = new SqliteStore(':memory:')
    const b = new SqliteStore(':memory:')
    unwrap(importProjectExport(a, JSON.parse(JSON.stringify(bundle))))
    unwrap(importProjectExport(b, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(a, ctx.project.id)).toBe(stateSha256(b, ctx.project.id))
    expect(stateSha256(a, ctx.project.id)).toBe(bundle.stateSha256)
  })
})

describe('libraries pinning libraries (ADR 0027 §5)', () => {
  it('lets a library pin another library under the same rules', () => {
    const ctx = setup()
    const l = libraryWithPattern(ctx)
    const outer = unwrap(
      ctx.services.createProject(ctx.owner, { name: 'Composite', kind: 'library' }),
    )
    const { refs } = commit(ctx, outer.id, [use(l.lib.id, 1), pin('$p', l.lib.id, l.pattern, 1)])
    expect(
      unwrap(ctx.services.getPinStatus(ctx.owner, { projectId: outer.id })).pins[0],
    ).toMatchObject({
      evidence: refs.$p,
      freshness: 'current',
    })
  })
})
