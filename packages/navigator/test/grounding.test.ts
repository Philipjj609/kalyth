import { sha256Hex } from '@kalyth/core'
import { describe, expect, it } from 'vitest'
import { type ContextEvidence, checkCitations, type ModelContext } from '../src/index.ts'
import { mapSummary } from '../src/operations.ts'

// Excerpts from the pinned FastAPI template (backend/app/models.py and api/routes/items.py).
const MODEL = [
  'class Item(ItemBase, table=True):',
  '    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)',
  '    owner_id: uuid.UUID = Field(',
  '        foreign_key="user.id", nullable=False, ondelete="CASCADE"',
  '    )',
  '    owner: User | None = Relationship(back_populates="items")',
  '    title: str = Field(min_length=1, max_length=255)',
].join('\n')
const GUARD = '    if not current_user.is_superuser and (item.owner_id != current_user.id):'
const ROUTES = [
  '    item = session.get(Item, id)',
  GUARD,
  '        raise HTTPException(status_code=403, detail="Not enough permissions")',
  '    session.add(item)',
].join('\n')
const TWICE = [
  GUARD,
  '        raise HTTPException(status_code=403, detail="Not enough permissions")',
  '    session.delete(item)',
  GUARD,
  '        raise HTTPException(status_code=403, detail="Not enough permissions")',
].join('\n')

const evidence = (handle: string, path: string, excerpt: string, sha = sha256Hex(excerpt)) =>
  [
    handle,
    { handle, id: `evd_${handle}`, path, lines: '1-9', about: null, excerpt, sha256: sha },
  ] as const
const index = new Map<string, ContextEvidence>([
  evidence('E1', 'backend/app/models.py', MODEL),
  evidence('E2', 'backend/app/api/routes/items.py', ROUTES),
  evidence('E3', 'backend/app/api/routes/items.py', TWICE),
  evidence('E4', 'frontend/src/client/models.ts', 'export const OWNER_FIELD = "owner_id" as const'),
  evidence('E5', 'backend/app/models.py', MODEL, sha256Hex(`${MODEL}\n# changed since`)),
])
const one = (ref: string, quote: string, python = false) =>
  checkCitations([{ ref, quote }], index, { pythonStringDelimiters: python }).outcomes[0]

describe('grounding validator: exact pass (ADR 0010, unchanged)', () => {
  it('accepts verbatim quotes, with runs of whitespace and line endings counted as one space', () => {
    expect(one('E1', 'foreign_key="user.id", nullable=False')).toMatchObject({ match: 'exact' })
    expect(
      one('E2', 'item = session.get(Item, id)\r\n    if not current_user.is_superuser'),
    ).toMatchObject({
      match: 'exact',
    })
    // An exact quote may occur more than once: it is the source text either way.
    expect(one('E3', 'if not current_user.is_superuser')).toMatchObject({ match: 'exact' })
  })
})

describe('grounding validator: bounded normalisation (ADR 0017)', () => {
  it('forgives layout between code tokens and keeps both texts verbatim', () => {
    const joined =
      'owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False, ondelete="CASCADE")'
    expect(one('E1', joined)).toEqual({
      ref: 'E1',
      quote: joined,
      match: 'normalized',
      source:
        'owner_id: uuid.UUID = Field(\n        foreign_key="user.id", nullable=False, ondelete="CASCADE"\n    )',
      differences: ['layout'],
    })
  })

  it('reads typographic quotes as ASCII', () => {
    expect(one('E1', 'Relationship(back_populates=“items”)')).toMatchObject({
      match: 'normalized',
      differences: ['typographic quotes'],
    })
  })

  it('never treats ASCII single and double quotes as the same by default', () => {
    expect(one('E1', "foreign_key='user.id', nullable=False")).toMatchObject({
      match: 'rejected',
      reason: 'quote does not occur in the cited source text',
    })
  })

  it('rejects near misses: a changed operator, identifier, number, string or merged token', () => {
    const misses = [
      'not current_user.is_superuser and (item.owner_id == current_user.id)',
      'not current_user.is_superuser and (item.owner != current_user.id)',
      'title: str = Field(min_length=1, max_length=256)',
      'foreign_key="users.id", nullable=False',
      'if notcurrent_user.is_superuser and (item.owner_id',
      'if not current_user.is_superuser or (item.owner_id != current_user.id)',
    ]
    for (const quote of misses) {
      const ref = quote.startsWith('title') || quote.startsWith('foreign') ? 'E1' : 'E2'
      expect(one(ref, quote), quote).toMatchObject({ match: 'rejected' })
    }
  })

  it('rejects a quote cited from the wrong excerpt or path, even though it exists elsewhere', () => {
    expect(one('E4', 'foreign_key="user.id", nullable=False')).toMatchObject({ match: 'rejected' })
    expect(one('E9', 'foreign_key="user.id", nullable=False')).toMatchObject({
      reason: 'cites evidence that was not provided',
    })
  })

  it('rejects an excerpt that no longer matches its pinned source (stale blob)', () => {
    expect(one('E5', 'foreign_key="user.id", nullable=False')).toMatchObject({
      match: 'rejected',
      reason: 'the excerpt no longer matches its pinned source',
    })
  })

  it('rejects a normalised match that is not unique in the excerpt', () => {
    expect(
      one('E3', 'if not current_user.is_superuser and (item.owner_id!=current_user.id):'),
    ).toMatchObject({
      match: 'rejected',
      reason: 'quote matches more than one place in the excerpt after normalisation',
    })
    // The same quote is unique, and accepted, in an excerpt where it occurs once.
    expect(
      one('E2', 'if not current_user.is_superuser and (item.owner_id!=current_user.id):'),
    ).toMatchObject({ match: 'normalized', differences: ['layout'] })
  })

  it('rejects short quotes', () => {
    expect(one('E1', 'Field( )')).toMatchObject({ match: 'rejected' })
  })
})

describe('Python string delimiter fallback (off by default)', () => {
  it('accepts a swapped delimiter on a plain literal in a Python file only', () => {
    expect(one('E1', "foreign_key='user.id', nullable=False", true)).toMatchObject({
      match: 'normalized',
      differences: ['python string delimiters'],
    })
    expect(one('E4', "OWNER_FIELD = 'owner_id' as const", true)).toMatchObject({
      match: 'rejected',
    })
  })

  it('still rejects a changed literal, or one that contains quotes or backslashes', () => {
    expect(one('E1', "foreign_key='users.id', nullable=False", true)).toMatchObject({
      match: 'rejected',
    })
    const withApostrophe = new Map<string, ContextEvidence>([
      evidence('E1', 'a.py', 'message = "it\'s done"  # comment'),
    ])
    expect(
      checkCitations([{ ref: 'E1', quote: "message = 'it\\'s done'" }], withApostrophe, {
        pythonStringDelimiters: true,
      }).outcomes[0],
    ).toMatchObject({ match: 'rejected' })
  })
})

describe('grounding metrics', () => {
  it('counts exact, normalised and rejected citations separately', () => {
    const check = checkCitations(
      [
        { ref: 'E1', quote: 'foreign_key="user.id", nullable=False' },
        { ref: 'E1', quote: 'Relationship(back_populates=“items”)' },
        { ref: 'E1', quote: "foreign_key='user.id', nullable=False" },
        { ref: 'E2', quote: 'item = session.get(Item, id)' },
      ],
      index,
    )
    expect(check).toMatchObject({ valid: 3, exact: 2, normalized: 1 })
    expect(check.invalid).toHaveLength(1)
    expect(check.evidenceIds).toEqual(['evd_E1', 'evd_E2'])
  })

  it('records normalised matches verbatim in the run report; an item with any rejection still fails', () => {
    const context: ModelContext = {
      revision: 4,
      elements: [
        { handle: 'N1', id: `obj_${'1'.repeat(32)}`, type: 'software.Module', label: 'm' },
      ],
      evidence: [...index.values()],
      omissions: [],
    }
    const mapped = mapSummary(
      {
        statements: [
          {
            text: 'Items belong to users and are deleted with them.',
            citations: [
              {
                ref: 'E1',
                quote:
                  'owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False, ondelete="CASCADE")',
              },
            ],
            confidence: 'high',
            rationale: 'r',
          },
          {
            text: 'Only owners may change items.',
            citations: [
              { ref: 'E2', quote: GUARD.trim() },
              { ref: 'E2', quote: 'if not current_user.is_superuser or (item.owner_id' },
            ],
            confidence: 'high',
            rationale: 'r',
          },
        ],
      },
      context,
      `obj_${'1'.repeat(32)}`,
      { provider: 'test', model: 'test' },
    )
    expect(mapped.grounding).toMatchObject({
      citations: 3,
      validCitations: 2,
      exactCitations: 1,
      normalizedCitations: 1,
      itemsKept: 1,
      itemsRejected: [{ item: 'statement 2' }],
      normalizedMatches: [
        {
          item: 'statement 1',
          ref: 'E1',
          differences: ['layout'],
          source: expect.stringContaining('Field(\n        foreign_key'),
        },
      ],
    })
  })
})
