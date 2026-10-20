import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { axeViolations } from './app.ts'

// After an agent's work (ADR 0024): a person files a report for work done outside an agent
// session, git verifies it, and the person reconciles the model with the verified commit. The task
// and its repository are made here, in projects of their own, so the sample project is unchanged.
// The file runs after the journeys, which expect the sample to be the only project at first.

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run the tests through playwright test`)
  return value
}

/** A throwaway git repository. */
function repository() {
  const path = mkdtempSync(join(tmpdir(), 'kalyth-e2e-repo-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@example.invalid')
  git('config', 'core.autocrlf', 'false')
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content)
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  return {
    path,
    commit,
    dispose: () => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

/** The API, as the person in this session. */
function api() {
  const { origin, hash } = new URL(env('KALYTH_E2E_URL'))
  const token = hash.replace(/^#token=/, '')
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return (await res.json()) as T
  }
  return { origin, hash, call }
}

// Once per theme, each set at page load, as the accessibility checks of the views are: switching
// the scheme on an open page would let axe measure colours mid-transition.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('a person files a report, git verifies it, and the model is reconciled', async ({
      page,
    }) => {
      const repo = repository()
      try {
        const base = repo.commit({ 'models.py': 'class Item:\n    pass\n' }, 'base')
        const { origin, hash, call } = api()
        const { id: projectId } = await call<{ id: string }>('POST', '/projects', {
          name: `Follow-up (${colorScheme})`,
          description: 'Work done outside an agent session.',
        })
        await call('PUT', `/projects/${projectId}/task-repository`, { path: repo.path })
        const propose = async (ops: unknown[]) => {
          const overview = await call<{ project: { headRevision: number } }>(
            'GET',
            `/projects/${projectId}`,
          )
          const p = await call<{ proposalId: string }>('POST', `/projects/${projectId}/proposals`, {
            baseRevision: overview.project.headRevision,
            rationale: 'e2e',
            ops,
          })
          return call<{ refs: Record<string, string> }>('POST', `/proposals/${p.proposalId}/commit`)
        }
        const created = await propose([
          {
            op: 'createObject',
            ref: '$t',
            type: 'core.Task',
            stance: 'toBe',
            attributes: {
              title: 'Add tenant_id',
              acceptanceCriteria: ['Item has tenant_id'],
              baseCommit: base,
            },
            claim: { basis: 'stated' },
          },
        ])
        const taskId = created.refs.$t as string
        await propose([{ op: 'setTaskStatus', id: taskId, status: 'ready', rationale: 'scoped' }])
        const sha = repo.commit(
          { 'models.py': 'class Item:\n    tenant_id: int\n' },
          `Add tenant_id\n\nKalyth-Task: ${taskId}`,
        )

        await page.goto(`${origin}/?project=${projectId}&view=tasks&task=${taskId}${hash}`)
        const detail = page.locator(`[data-task-detail="${taskId}"]`)
        await expect(detail).toContainText('Prompt for an agent')
        await expect(detail).toContainText(`Call claim_task with taskId "${taskId}"`)
        const followUp = detail.getByRole('region', { name: 'Follow-up' })
        await followUp.getByRole('button', { name: 'File a report…' }).click()
        const form = followUp.getByRole('form', { name: 'File a report' })
        await form.getByRole('textbox', { name: 'Commit sha' }).fill(sha)
        await form.getByRole('textbox', { name: 'Files changed, one per line' }).fill('models.py')
        await form.getByRole('textbox', { name: 'Summary' }).fill('Added tenant_id by hand.')
        await page.waitForLoadState('networkidle')
        expect(await axeViolations(page)).toEqual([])
        await form.getByRole('button', { name: 'File the report' }).click()

        await expect(followUp).toContainText('Report filed.')
        await expect(followUp).toContainText('The task moved to Review.')
        await expect(detail).toContainText('stated by a person')
        await followUp.getByRole('button', { name: `Reconcile with ${sha.slice(0, 8)}` }).click()
        await expect(followUp).toContainText('Analysed:')
        await expect(followUp).toContainText('The task implements no decision')
        await page.waitForLoadState('networkidle')
        expect(await axeViolations(page)).toEqual([])

        // The model now holds what the analyzer observed at the commit.
        const modules = await call<{ objects: { attributes: { path: string } }[] }>(
          'GET',
          `/projects/${projectId}/objects?type=software.Module`,
        )
        expect(modules.objects.map((o) => o.attributes.path)).toContain('models.py')
      } finally {
        repo.dispose()
      }
    })
  })
}

// The same follow-up from the change thread: the prompt and a person's report under Agent work,
// then reconciliation under Reconcile, with what the verified commit touched.
test('the change thread carries the prompt, the report and the reconciliation', async ({
  page,
}) => {
  const repo = repository()
  try {
    const base = repo.commit({ 'models.py': 'class Item:\n    pass\n' }, 'base')
    const { origin, hash, call } = api()
    const { id: projectId } = await call<{ id: string }>('POST', '/projects', {
      name: 'Follow-up in the thread',
      description: 'A change carried through to reconciliation.',
    })
    await call('PUT', `/projects/${projectId}/task-repository`, { path: repo.path })
    const propose = async (ops: unknown[]) => {
      const overview = await call<{ project: { headRevision: number } }>(
        'GET',
        `/projects/${projectId}`,
      )
      const p = await call<{ proposalId: string }>('POST', `/projects/${projectId}/proposals`, {
        baseRevision: overview.project.headRevision,
        rationale: 'e2e',
        ops,
      })
      return call<{ refs: Record<string, string> }>('POST', `/proposals/${p.proposalId}/commit`)
    }
    const created = await propose([
      {
        op: 'createObject',
        ref: '$d',
        type: 'core.Decision',
        stance: 'toBe',
        attributes: { title: 'Scope items by tenant', question: 'How are items scoped?' },
        claim: { basis: 'stated' },
      },
      {
        op: 'createObject',
        ref: '$a',
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: { title: 'A tenant_id column', summary: 'Add tenant_id to Item.' },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: '$a',
        to: '$d',
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
      {
        op: 'createObject',
        ref: '$t',
        type: 'core.Task',
        stance: 'toBe',
        attributes: {
          title: 'Add tenant_id',
          acceptanceCriteria: ['Item has tenant_id'],
          baseCommit: base,
        },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'implements',
        from: '$t',
        to: '$d',
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    ])
    const decisionId = created.refs.$d as string
    const taskId = created.refs.$t as string
    await propose([{ op: 'setTaskStatus', id: taskId, status: 'ready', rationale: 'scoped' }])
    const sha = repo.commit(
      { 'models.py': 'class Item:\n    tenant_id: int\n' },
      `Add tenant_id\n\nKalyth-Task: ${taskId}`,
    )

    await page.goto(`${origin}/?project=${projectId}&view=change&decision=${decisionId}${hash}`)
    const main = page.getByRole('main')
    const work = main.locator('#stage-work')
    await work.getByText('Prompt for a coding agent').click()
    await expect(work).toContainText(`Call claim_task with taskId "${taskId}"`)
    await work.getByRole('button', { name: 'File a report…' }).click()
    const form = work.getByRole('form', { name: 'File a report' })
    await form.getByRole('textbox', { name: 'Commit sha' }).fill(sha)
    await form.getByRole('textbox', { name: 'Files changed, one per line' }).fill('models.py')
    await form.getByRole('textbox', { name: 'Summary' }).fill('Added tenant_id by hand.')
    await form.getByRole('button', { name: 'File the report' }).click()
    await expect(work).toContainText('Report filed.')
    await expect(work).toContainText('stated by a person')

    const reconcile = main.locator('#stage-reconcile')
    await reconcile.getByRole('button', { name: `Reconcile with ${sha.slice(0, 8)}` }).click()
    await expect(reconcile).toContainText('Analysed:')
    await expect(reconcile).toContainText('Scope items by tenant')
    await page.waitForLoadState('networkidle')
    expect(await axeViolations(page)).toEqual([])
  } finally {
    repo.dispose()
  }
})
