import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'

export const VIEWS = [
  'overview',
  'graph',
  'records',
  'proposals',
  'history',
  'navigator',
  'handoff',
  'tasks',
  'change',
  'compare',
  'knowledge',
] as const

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run the tests through playwright test`)
  return value
}

export const projectId = () => env('KALYTH_E2E_PROJECT')

/** Opens the workbench with the session link, at the given query (e.g. `view=graph`). */
export async function open(page: Page, query = ''): Promise<void> {
  const { origin, hash } = new URL(env('KALYTH_E2E_URL'))
  const q = new URLSearchParams(query)
  if (!q.has('project')) q.set('project', projectId())
  await page.goto(`${origin}/?${q}${hash}`)
  await page.getByRole('main').waitFor()
}

/** The WCAG 2.2 A and AA rules axe can check automatically. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Each violation as its rule, impact and the first few offending elements, for a readable diff. */
export async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  return results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .slice(0, 4)
        .map((n) => n.target.join(' '))
        .join(', ')}${v.nodes.length > 4 ? ` and ${v.nodes.length - 4} more` : ''}`,
  )
}
