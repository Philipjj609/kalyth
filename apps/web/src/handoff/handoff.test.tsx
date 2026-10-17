import { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApi, type FetchLike } from '../api/client.ts'
import { keys } from '../api/queries.ts'
import { formatLocation, parseLocation } from '../app/location.ts'
import { TooltipProvider } from '../components/ui.tsx'
import {
  agentPrompt,
  claudeCodeCommand,
  codexConfig,
  codexEnvCommands,
  compileBody,
  draftFocus,
  draftProblems,
  draftReducer,
  EMPTY_DRAFT,
  groupDecisions,
  groupItems,
  type HandoffDraft,
  itemPathText,
  mcpUrl,
  omissionText,
  packageLabeller,
  roundTripProposals,
  splitBodies,
  tokenState,
} from '../model/handoff.ts'
import {
  acceptedDecision,
  blockedPackage,
  CONSTRAINT,
  FAKE_AGENT_TOKEN,
  INVARIANT,
  item,
  LIB,
  OMITTED,
  PACKAGE_ID,
  packageResult,
  proposal,
  readyPackage,
  TOKEN_ID,
  tokenSummary,
} from '../test/handoff.ts'
import { ALT_A, ALT_B, CRUD_PY, DECISION, ITEM, id, MODELS_PY, PROJECT } from '../test/navigator.ts'
import { IssuedTokenView, SetupSnippets, TokenList } from './AgentConnect.tsx'
import { CriteriaEditor, DecisionChoiceList } from './HandoffSource.tsx'
import { issueAgentToken } from './issue-token.ts'
import { type PackageLookup, PackageView } from './PackageView.tsx'
import { AgentPromptPanel, RoundTripList } from './RoundTrip.tsx'

/** Visible text of static markup, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fetch that answers from a script and records each request. */
function scripted(answer: (url: string, method: string) => Response) {
  const calls: { url: string; method: string; body: unknown; auth: string | undefined }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    })
    return answer(url, method)
  }
  return { calls, api: createApi(() => 'session-token-123', fetchImpl) }
}

const ORIGIN = 'http://127.0.0.1:4317'
const lookupFor = (pkg = readyPackage()): PackageLookup => ({
  labelOf: packageLabeller(pkg, (i) => (i === OMITTED[0] ? 'app/routes/items.py' : undefined)),
})

// ---------- the package view ----------

describe('package view', () => {
  const html = render(
    <PackageView result={packageResult()} headRevision={7} lookup={lookupFor()}>
      <p>ACTIONS</p>
    </PackageView>,
  )
  const text = textOf(html)

  it('shows the header: id, uri, revision, snapshots, size against the limit and a JSON copy', () => {
    expect(text).toContain('Package status: Ready')
    expect(text).toContain('Add tenant isolation')
    expect(text).toContain(`Id ${PACKAGE_ID}`)
    expect(text).toContain(`URI kalyth://context/${PACKAGE_ID}`)
    expect(text).toContain('Revision r7')
    expect(text).not.toContain('the head is')
    expect(text).toContain('Source snapshots demo/fastapi-app @ 1a2b3c4d')
    expect(text).toContain(
      'Size against the limit 18,240 of 60,000 characters ≈ 4,560 of 15,000 tokens',
    )
    expect(text).toContain('Mandatory size 6,400 characters (≈ 1,600 tokens) never cut to fit')
    expect(text).toContain('Copy package JSON')
    expect(text).toContain('Read with your scopes: grant.manage, project.read, proposal.create')
    // The handoff actions sit between the header and the sections.
    expect(text.indexOf('ACTIONS')).toBeLessThan(text.indexOf('Mandatory never cut'))
  })

  it('says when the head has moved past the package revision', () => {
    const later = textOf(
      render(<PackageView result={packageResult()} headRevision={9} lookup={lookupFor()} />),
    )
    expect(later).toContain('Revision r7 the head is r9')
  })

  it('lists every mandatory section: invariants, constraints, decisions, criteria and policy', () => {
    const mandatory = text.slice(
      text.indexOf('Mandatory never cut'),
      text.indexOf('Optional items'),
    )
    expect(mandatory).toContain('Mandatory never cut · 6,400 characters')
    expect(mandatory).toContain(
      'Invariants 1 Constraint No plaintext secrets Severity: Must Basis: Stated Freshness: N/A Secrets never reach logs or the database in plaintext.',
    )
    expect(mandatory).toContain(
      'Constraints 1 Constraint Queries filter by tenant Severity: Should Basis: Stated Freshness: N/A Every read is scoped to one tenant. docs/tenancy.md (Scope)',
    )
    expect(mandatory).toContain('Decisions 1 Decision Tenancy model Decision status: Accepted')
    expect(mandatory).toContain('How should tenants be isolated?')
    expect(mandatory).toContain('Rationale: Cheapest to run for the first customers.')
    expect(mandatory).toContain(
      'Accepted alternative Tenant column Basis: Inferred Freshness: N/A Medium confidence Stance: To-be Add tenant_id to every table.',
    )
    expect(mandatory).toContain(
      'Direct changes 1 Item Basis: Inferred Freshness: N/A Add a tenant_id column.',
    )
    expect(mandatory).toContain(
      'Acceptance criteria 2 Every query filters by tenant Existing tests pass',
    )
    expect(mandatory).toContain(
      'Agent policy 2 Agents read and propose. People commit proposals and accept decisions in Kalyth.',
    )
  })

  it('groups optional items by role with distance, basis, freshness and confidence', () => {
    const optional = text.slice(text.indexOf('Optional items'), text.indexOf('Left out'))
    expect(optional).toContain('Optional items nearest first · 5 items')
    const focus = optional.indexOf('Focus 1')
    const questions = optional.indexOf('Open questions 1')
    const impacted = optional.indexOf('Impacted 2')
    const dependencies = optional.indexOf('Dependencies 1')
    expect(focus).toBeGreaterThan(-1)
    expect(focus).toBeLessThan(questions)
    expect(questions).toBeLessThan(impacted)
    expect(impacted).toBeLessThan(dependencies)
    expect(optional).toContain(
      'Data entity Item Distance 0 Basis: Observed Freshness: Current app/models.py:10-24 @ 1a2b3c4',
    )
    expect(optional).toContain(
      'Question Do tenants share users? Distance 1 Basis: Inferred Freshness: N/A Low confidence Nothing in the source says either way.',
    )
    expect(optional).toContain('Library sqlmodel Distance 1 Basis: Observed Freshness: Current')
  })

  it('shows typed paths for impacted items in the Navigator notation', () => {
    expect(text).toContain(
      'Module app/models.py Distance 1 Basis: Observed Freshness: Stale Item <-contains (defines)- app/models.py app/models.py:1-80 @ 1a2b3c4',
    )
    expect(text).toContain(
      'Module app/crud.py Distance 2 Basis: Observed Freshness: Current Item <-contains (defines)- app/models.py <-dependsOn- app/crud.py',
    )
  })

  it('renders evidence excerpts as preformatted text', () => {
    expect(html).toMatch(
      /<pre[^>]*>class Item\(SQLModel, table=True\):\n {4}id: int \| None<\/pre>/,
    )
    // Locations without an excerpt get no empty block.
    expect(html.match(/<pre/g)).toHaveLength(2) // the excerpt and the retrieval arguments
  })

  it('states omissions plainly with the first ids, and lists retrieval hints as JSON', () => {
    const left = text.slice(text.indexOf('Left out'))
    expect(left).toContain('12 items left out at the size limit.')
    expect(left).toContain('The first 3, nearest first:')
    expect(left).toContain(`app/routes/items.py obj…${OMITTED[0]?.slice(-6)}`)
    expect(left).toContain(
      'The traversal stopped at its limit, so more elements may be affected than are listed.',
    )
    expect(left).toContain('Retrieval hints MCP calls for detail left out')
    expect(left).toContain('query_objects Read omitted elements, nearest first.')
    expect(html).toContain(
      `{\n  &quot;projectId&quot;: &quot;${PROJECT}&quot;,\n  &quot;revision&quot;: 7,`,
    )
  })

  it('renders package text as text, never as markup', () => {
    const hostile = readyPackage({
      task: { title: '<img src=x onerror=alert(1)>', acceptanceCriteria: ['<b>bold</b>'] },
      mandatory: { ...readyPackage().mandatory, acceptanceCriteria: ['<b>bold</b>'] },
    })
    const out = render(
      <PackageView result={packageResult(hostile)} headRevision={7} lookup={lookupFor(hostile)} />,
    )
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<b>bold</b>')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('blocked package', () => {
  const pkg = blockedPackage()
  const text = textOf(
    render(
      <PackageView
        result={packageResult(pkg)}
        headRevision={7}
        lookup={{
          labelOf: packageLabeller(pkg, (i) =>
            // A blocked package has no optional items, so names come from the model.
            i === ITEM
              ? 'Item'
              : i === MODELS_PY
                ? 'app/models.py'
                : i === CRUD_PY
                  ? 'app/crud.py'
                  : undefined,
          ),
        }}
        renderSplitAction={(split, i) => (
          <button type="button">
            COMPILE {i + 1}: {split.length}
          </button>
        )}
      />,
    ),
  )

  it('explains that the mandatory part alone exceeds the limit and offers each split', () => {
    expect(text).toContain('Package status: Blocked')
    expect(text).toContain('Mandatory size against the limit 72,000 of 60,000 characters')
    expect(text).toContain('The mandatory part alone exceeds the size limit.')
    expect(text).toContain('come to 72,000 characters, over the limit of 60,000')
    expect(text).toContain('Part 1 Item app/models.py COMPILE 1: 2')
    expect(text).toContain('Part 2 app/crud.py COMPILE 2: 1')
  })

  it('still shows the mandatory part, and no optional items or omissions', () => {
    expect(text).toContain('Invariants 1')
    expect(text).toContain('Decisions 1')
    expect(text).toContain('None: a blocked package holds only its mandatory part.')
    expect(text).toContain('Nothing is listed: the package stopped at its mandatory part.')
  })

  it('compiles each split with the same task and limit', () => {
    expect(splitBodies(pkg)).toEqual([
      { focus: [ITEM, MODELS_PY], maxChars: 60_000, task: pkg.task },
      { focus: [CRUD_PY], maxChars: 60_000, task: pkg.task },
    ])
    expect(splitBodies(readyPackage())).toEqual([])
  })

  it('has no prompt to hand off', () => {
    const prompt = textOf(render(<AgentPromptPanel pkg={pkg} headRevision={7} />))
    expect(prompt).toContain('A blocked package cannot be handed off.')
    expect(prompt).not.toContain('get_context_package')
  })
})

describe('package grouping', () => {
  it('groups decisions with their accepted alternatives and direct changes', () => {
    const groups = groupDecisions(readyPackage().mandatory.decisions)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.decision?.id).toBe(DECISION)
    expect(groups[0]?.alternatives.map((a) => a.alternative?.id)).toEqual([ALT_A])
    expect(groups[0]?.alternatives[0]?.changes.map((c) => c.to)).toEqual([ITEM])
  })

  it('keeps out-of-place items instead of dropping them', () => {
    const change = item({
      id: id('rel', 9),
      kind: 'relation',
      type: 'impacts',
      label: 'x',
      role: 'directChange',
      from: ALT_B,
      to: ITEM,
    })
    const groups = groupDecisions([change])
    expect(groups).toEqual([
      { decision: null, alternatives: [{ alternative: null, changes: [change] }] },
    ])
  })

  it('orders roles focus, question, impacted, dependency and keeps unknown roles last', () => {
    const items = [
      item({ id: LIB, type: 't', label: 'l', role: 'dependency' }),
      item({ id: ITEM, type: 't', label: 'i', role: 'mystery' as 'focus' }),
      item({ id: MODELS_PY, type: 't', label: 'm', role: 'impacted' }),
      item({ id: CRUD_PY, type: 't', label: 'c', role: 'focus' }),
    ]
    expect(groupItems(items).map((g) => g.role)).toEqual([
      'focus',
      'impacted',
      'dependency',
      'mystery',
    ])
  })

  it('writes paths and omissions in words', () => {
    const labelOf = packageLabeller(readyPackage(), () => undefined)
    const crud = readyPackage().items.find((i) => i.id === CRUD_PY)
    expect(crud && itemPathText(crud, labelOf)).toBe(
      'Item <-contains (defines)- app/models.py <-dependsOn- app/crud.py',
    )
    expect(labelOf(INVARIANT)).toBe('No plaintext secrets')
    expect(labelOf(CONSTRAINT)).toBe('Queries filter by tenant')
    expect(labelOf(id('obj', 999))).toBe(`obj…${id('obj', 999).slice(-6)}`)
    expect(omissionText({ reason: 'size_limit', count: 1 })).toBe(
      '1 item left out at the size limit',
    )
    expect(omissionText({ reason: 'traversal_limit', count: 4 })).toBe(
      '4 items left out at the traversal limit',
    )
  })
})

// ---------- choosing what to hand off ----------

describe('decisions list to focus', () => {
  it('lists each accepted decision with its accepted alternative and direct changes', () => {
    const html = render(
      <DecisionChoiceList decisions={[acceptedDecision()]} value={null} onChoose={() => {}} />,
    )
    const text = textOf(html)
    expect(text).toContain('Tenancy model Basis: Stated How should tenants be isolated?')
    expect(text).toContain(
      'Accepted: Tenant column Add tenant_id to every table. 2 direct changes: Item : Add a tenant_id column. app/models.py : Filter by tenant in the base query.',
    )
    // The rejected alternative is not offered as what was accepted.
    expect(text).not.toContain('Database per tenant')
    expect(html).toContain('type="radio"')
    expect(html).not.toContain('checked')
    const chosen = render(
      <DecisionChoiceList decisions={[acceptedDecision()]} value={DECISION} onChoose={() => {}} />,
    )
    expect(chosen).toContain('checked')
  })

  it('selecting a decision sets the focus and prefills the task title', () => {
    let draft = draftReducer(EMPTY_DRAFT, { type: 'chooseDecision', decision: acceptedDecision() })
    expect(draftFocus(draft)).toEqual([DECISION])
    expect(draft.title).toBe('Tenancy model')
    // A title the person has not edited follows the next choice.
    draft = draftReducer(draft, {
      type: 'chooseDecision',
      decision: { id: ALT_B, title: 'Auth provider' },
    })
    expect(draft.title).toBe('Auth provider')
    // An edited title is kept.
    draft = draftReducer(draft, { type: 'title', title: 'Isolate tenants' })
    draft = draftReducer(draft, { type: 'chooseDecision', decision: acceptedDecision() })
    expect(draft.title).toBe('Isolate tenants')
    expect(draftFocus(draft)).toEqual([DECISION])
  })

  it('switches to picked elements, and edits the acceptance criteria', () => {
    let draft: HandoffDraft = draftReducer(EMPTY_DRAFT, {
      type: 'chooseDecision',
      decision: acceptedDecision(),
    })
    draft = draftReducer(draft, { type: 'mode', mode: 'elements' })
    expect(draftFocus(draft)).toEqual([])
    expect(draftProblems(draft)).toEqual(['Pick at least one element.'])
    draft = draftReducer(draft, { type: 'elements', elements: [ITEM, MODELS_PY, ITEM] })
    expect(draftFocus(draft)).toEqual([ITEM, MODELS_PY])
    for (const text of ['  First  ', 'Second', '   ', 'Third']) {
      draft = draftReducer(draft, { type: 'addCriterion', text })
    }
    expect(draft.criteria).toEqual(['First', 'Second', 'Third'])
    draft = draftReducer(draft, { type: 'moveCriterion', index: 2, by: -1 })
    draft = draftReducer(draft, { type: 'removeCriterion', index: 0 })
    draft = draftReducer(draft, { type: 'editCriterion', index: 1, text: 'Second, edited' })
    expect(draft.criteria).toEqual(['Third', 'Second, edited'])
    const editor = textOf(render(<CriteriaEditor criteria={draft.criteria} dispatch={() => {}} />))
    expect(editor).toContain('Acceptance criteria (optional, 2 of 20) 1. 2.')
  })

  it('says why a draft cannot be compiled', () => {
    expect(draftProblems(EMPTY_DRAFT)).toEqual(['Choose an accepted decision.'])
    const noTitle = { ...EMPTY_DRAFT, decisionId: DECISION, criteria: ['Something'] }
    expect(draftProblems(noTitle)).toEqual(['Acceptance criteria need a task title.'])
    expect(draftProblems({ ...EMPTY_DRAFT, decisionId: DECISION, maxChars: 3_999 })).toEqual([
      'Set a size limit from 4,000 to 400,000 characters.',
    ])
    expect(
      draftProblems({ ...EMPTY_DRAFT, decisionId: DECISION, maxChars: Number.NaN }),
    ).toHaveLength(1)
  })

  it('compiles the chosen decision at the head with the task and size limit', async () => {
    let draft = draftReducer(EMPTY_DRAFT, { type: 'chooseDecision', decision: acceptedDecision() })
    draft = draftReducer(draft, { type: 'addCriterion', text: 'Every query filters by tenant' })
    draft = draftReducer(draft, { type: 'maxChars', value: 80_000 })
    const body = compileBody(draft)
    expect(body).toEqual({
      focus: [DECISION],
      maxChars: 80_000,
      task: { title: 'Tenancy model', acceptanceCriteria: ['Every query filters by tenant'] },
    })
    expect(compileBody({ ...EMPTY_DRAFT, decisionId: DECISION })).toEqual({
      focus: [DECISION],
      maxChars: 60_000,
    })

    const { calls, api } = scripted(() => json(201, packageResult()))
    const result = await api.compileContext(PROJECT, body)
    expect(result.package.id).toBe(PACKAGE_ID)
    expect(calls).toEqual([
      {
        url: `/api/v1/projects/${PROJECT}/context`,
        method: 'POST',
        body,
        auth: 'Bearer session-token-123',
      },
    ])
  })

  it('reads accepted decisions, and treats a missing route as unavailable', async () => {
    const decisions = { projectId: PROJECT, revision: 7, decisions: [acceptedDecision()] }
    const ok = scripted(() => json(200, decisions))
    await expect(ok.api.decisions(PROJECT, 'accepted')).resolves.toEqual(decisions)
    expect(ok.calls[0]?.url).toBe(`/api/v1/projects/${PROJECT}/decisions?status=accepted`)
    const missing = scripted(() =>
      json(404, { error: { code: 'not_found', message: 'no route', issues: [] } }),
    )
    await expect(missing.api.decisions(PROJECT, 'accepted')).resolves.toBeNull()
  })

  it('reads a package by id', async () => {
    const { calls, api } = scripted(() => json(200, packageResult()))
    await expect(api.contextPackage(PACKAGE_ID)).resolves.toEqual(packageResult())
    expect(calls[0]?.url).toBe(`/api/v1/context/${PACKAGE_ID}`)
  })
})

describe('handoff location', () => {
  it('deep-links a package in the Handoff view only', () => {
    const loc = parseLocation(`?project=${PROJECT}&view=handoff&package=${PACKAGE_ID}`)
    expect(loc.view).toBe('handoff')
    expect(loc.package).toBe(PACKAGE_ID)
    expect(formatLocation(loc)).toBe(`?project=${PROJECT}&view=handoff&package=${PACKAGE_ID}`)
    expect(formatLocation({ ...loc, view: 'proposals' })).toBe(`?project=${PROJECT}&view=proposals`)
    expect(parseLocation('?view=handoff&package=not-a-package').package).toBeUndefined()
  })
})

// ---------- agent tokens ----------

describe('agent token issuance', () => {
  afterEach(() => vi.unstubAllGlobals())

  const issued = { token: FAKE_AGENT_TOKEN, summary: tokenSummary() }

  it('returns the token once and keeps it out of storage, the URL and the query cache', async () => {
    const writes: string[] = []
    const storage = () => ({
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: (k: string, v: string) => void writes.push(`${k}=${v}`),
      removeItem: () => {},
      clear: () => {},
    })
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('sessionStorage', storage())
    vi.stubGlobal('history', {
      pushState: (...args: unknown[]) => void writes.push(JSON.stringify(args)),
      replaceState: (...args: unknown[]) => void writes.push(JSON.stringify(args)),
    })
    const client = new QueryClient()
    client.setQueryData(keys.agentTokens(PROJECT), { tokens: [] })
    const { calls, api } = scripted((_, method) =>
      method === 'POST' ? json(201, issued) : json(200, { tokens: [tokenSummary()] }),
    )

    const result = await issueAgentToken(api, client, PROJECT, {
      label: 'Claude Code on my laptop',
      expiresInDays: 7,
    })

    expect(result.token).toBe(FAKE_AGENT_TOKEN)
    expect(calls[0]).toEqual({
      url: `/api/v1/projects/${PROJECT}/agent-tokens`,
      method: 'POST',
      body: { label: 'Claude Code on my laptop', expiresInDays: 7 },
      auth: 'Bearer session-token-123',
    })
    // The list gets the summary, never the secret.
    expect(client.getQueryData(keys.agentTokens(PROJECT))).toEqual({ tokens: [tokenSummary()] })
    const cached = JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ])
    expect(cached).not.toContain(FAKE_AGENT_TOKEN)
    expect(writes).toEqual([])
    // Locations have no slot for it either.
    expect(formatLocation({ ...parseLocation(`?token=${FAKE_AGENT_TOKEN}`) })).not.toContain(
      FAKE_AGENT_TOKEN,
    )
  })

  it('shows the token with a shown-once warning, copy buttons and the setup', () => {
    const html = render(<IssuedTokenView issued={issued} origin={ORIGIN} onDone={() => {}} />)
    const text = textOf(html)
    expect(text).toContain('Token for “Claude Code on my laptop”: shown once')
    expect(text).toContain('Kalyth stores only its hash and cannot show it again')
    expect(text).toContain('this page forgets it when you leave this panel')
    expect(text).toContain(`Agent token: ${FAKE_AGENT_TOKEN}`)
    expect(html).toContain('aria-label="Copy the agent token"')
    expect(html).toContain('aria-label="Copy the Claude Code command"')
    expect(html).toContain('aria-label="Copy the Codex configuration"')
    expect(text).toContain(claudeCodeCommand(ORIGIN, FAKE_AGENT_TOKEN))
    expect(text).toContain(`export KALYTH_AGENT_TOKEN="${FAKE_AGENT_TOKEN}"`)
    expect(text).toContain('I have copied it')
  })

  it('lists tokens as summaries only: label, created, expires or revoked, and a revoke action for active ones', () => {
    const now = Date.parse('2026-10-20T08:00:00.000Z')
    const tokens = [
      tokenSummary(),
      tokenSummary({
        id: id('tok', 2),
        label: 'Old Codex',
        createdAt: '2026-10-01T08:00:00.000Z',
        expiresAt: '2026-10-08T08:00:00.000Z',
      }),
      tokenSummary({
        id: id('tok', 3),
        label: 'Revoked one',
        revokedAt: '2026-10-18T08:00:00.000Z',
      }),
    ]
    const html = render(
      <TokenList
        tokens={tokens}
        now={now}
        renderAction={(t) => <button type="button">REVOKE {t.label}</button>}
      />,
    )
    const text = textOf(html)
    expect(html).not.toContain('kalyth_at_')
    expect(text).toContain(
      'Claude Code on my laptop Token status: Active Created 3 days ago · Expires in 4 days REVOKE Claude Code on my laptop',
    )
    expect(text).toContain(
      'Old Codex Token status: Expired Created 3 weeks ago · Expired 2 weeks ago',
    )
    expect(text).toContain(
      'Revoked one Token status: Revoked Created 3 days ago · Revoked 2 days ago',
    )
    // Newest first; the revoked one was created at the same time and sorts by id.
    expect(text.indexOf('Revoked one')).toBeLessThan(text.indexOf('Old Codex'))
    expect(text.match(/REVOKE/g)).toHaveLength(1)
    expect(tokenState(tokens[0] as never, now)).toBe('active')
  })

  it('revokes by token id and lists tokens', async () => {
    const { calls, api } = scripted((url) =>
      url.endsWith('/revoke')
        ? json(200, tokenSummary({ revokedAt: '2026-10-18T08:00:00.000Z' }))
        : json(200, { tokens: [tokenSummary()] }),
    )
    await expect(api.revokeAgentToken(TOKEN_ID)).resolves.toMatchObject({
      revokedAt: '2026-10-18T08:00:00.000Z',
    })
    await expect(api.agentTokens(PROJECT)).resolves.toEqual({ tokens: [tokenSummary()] })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/v1/agent-tokens/${TOKEN_ID}/revoke`,
      `GET /api/v1/projects/${PROJECT}/agent-tokens`,
    ])
  })
})

describe('setup snippets', () => {
  it('builds the endpoint, the Claude Code command and the Codex configuration', () => {
    expect(mcpUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/mcp`)
    expect(claudeCodeCommand(ORIGIN, FAKE_AGENT_TOKEN)).toBe(
      `claude mcp add --transport http kalyth ${ORIGIN}/mcp --header "Authorization: Bearer ${FAKE_AGENT_TOKEN}"`,
    )
    expect(codexConfig(ORIGIN)).toBe(
      `[mcp_servers.kalyth]\nurl = "${ORIGIN}/mcp"\nbearer_token_env_var = "KALYTH_AGENT_TOKEN"\n`,
    )
    expect(codexEnvCommands(FAKE_AGENT_TOKEN)).toEqual({
      posix: `export KALYTH_AGENT_TOKEN="${FAKE_AGENT_TOKEN}"`,
      powershell: `$env:KALYTH_AGENT_TOKEN = "${FAKE_AGENT_TOKEN}"`,
    })
  })

  it('uses a placeholder without a token, and the Codex config never holds the token', () => {
    expect(claudeCodeCommand(ORIGIN, null)).toContain('Bearer <agent token>"')
    expect(codexEnvCommands(null).posix).toBe('export KALYTH_AGENT_TOKEN="<agent token>"')
    const text = textOf(render(<SetupSnippets origin={ORIGIN} token={FAKE_AGENT_TOKEN} />))
    const codex = text.slice(
      text.indexOf('Codex, in ~/.codex/config.toml'),
      text.indexOf('in bash or zsh'),
    )
    expect(codex).toContain('set KALYTH_AGENT_TOKEN to the token in the shell that runs Codex')
    expect(codex).not.toContain(FAKE_AGENT_TOKEN)
    expect(text.toLowerCase()).not.toContain('to be confirmed')
  })

  it('writes the prompt with the package id and revision', () => {
    const prompt = agentPrompt(readyPackage())
    expect(prompt).toBe(
      `Use the kalyth MCP server. Call get_context_package with packageId ${PACKAGE_ID}, follow everything under mandatory, and propose your changes with propose_change at baseRevision 7 and contextPackageId ${PACKAGE_ID}. A person reviews them in Kalyth.`,
    )
    const panel = textOf(render(<AgentPromptPanel pkg={readyPackage()} headRevision={9} />))
    expect(panel).toContain(prompt)
    expect(panel).toContain('Copy prompt')
    expect(panel).toContain('The head has moved to r9.')
  })
})

// ---------- round trip ----------

describe('round trip', () => {
  const proposals = [
    proposal({
      id: id('prp', 1),
      createdAt: '2026-10-17T09:00:00.000Z',
      contextPackageId: PACKAGE_ID,
    }),
    proposal({
      id: id('prp', 2),
      createdAt: '2026-10-17T10:00:00.000Z',
      origin: 'human',
      proposedBy: id('pcp', 2),
      rationale: 'A person at the same base',
    }),
    proposal({ id: id('prp', 3), baseRevision: 6, rationale: 'Older base' }),
    proposal({ id: id('prp', 4), status: 'committed', rationale: 'Already committed' }),
    proposal({ id: id('prp', 5), status: 'rejected', rationale: 'Rejected' }),
    proposal({
      id: id('prp', 6),
      contextPackageId: `ctx_${'f'.repeat(32)}`,
      rationale: 'Answers another package',
    }),
  ]

  it('puts proposals that name the package first and leaves out other packages', () => {
    const ids = (r: { linked: { id: string }[]; unlinked: { id: string }[] }) => ({
      linked: r.linked.map((p) => p.id),
      unlinked: r.unlinked.map((p) => p.id),
    })
    expect(ids(roundTripProposals(proposals, { id: PACKAGE_ID, revision: 7 }))).toEqual({
      linked: [id('prp', 1)],
      unlinked: [id('prp', 2)],
    })
    expect(ids(roundTripProposals(proposals, { id: PACKAGE_ID, revision: 6 }))).toEqual({
      linked: [id('prp', 1)],
      unlinked: [id('prp', 3)],
    })
    expect(
      ids(roundTripProposals(proposals, { id: `ctx_${'0'.repeat(32)}`, revision: 8 })),
    ).toEqual({
      linked: [],
      unlinked: [],
    })
  })

  it('shows origin, the token it came through and a review link for each', () => {
    const text = textOf(
      render(
        <RoundTripList
          proposals={proposals}
          packageId={PACKAGE_ID}
          revision={7}
          tokenLabelOf={(p) =>
            p === tokenSummary().principalId ? 'Claude Code on my laptop' : undefined
          }
          reviewLink={(p) => <a href={`?view=proposals&proposal=${p}`}>REVIEW {p.slice(-2)}</a>}
        />,
      ),
    )
    expect(text).toContain('A person at the same base Origin: Human by pcp…000002')
    expect(text).toContain(
      'Add tenant_id to Item and filter the base query Origin: Agent via token Claude Code on my laptop 0 operations',
    )
    expect(text).toContain('REVIEW 02')
    expect(text).toContain('REVIEW 01')
    expect(text).not.toContain('Older base')
    expect(text).not.toContain('Already committed')
    expect(text).not.toContain('Answers another package')
    expect(text).toContain('Also pending at r7 without a package')
    expect(text.indexOf('REVIEW 01')).toBeLessThan(text.indexOf('REVIEW 02'))
  })

  it('says when nothing came back yet', () => {
    const text = textOf(
      render(
        <RoundTripList
          proposals={[]}
          packageId={PACKAGE_ID}
          revision={7}
          reviewLink={() => null}
        />,
      ),
    )
    expect(text).toBe(
      'Nothing back yet When the agent calls propose_change with this package, its proposal appears here for review.',
    )
  })
})
