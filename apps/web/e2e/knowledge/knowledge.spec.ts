import { expect, type Page, test } from '@playwright/test'
import { axeViolations, open } from '../app.ts'

// The knowledge explorer (K5) on the multi-game example: discovery, item reading, evidence,
// connected navigation and applicability, with the accessibility rules of the main suite.

async function openItem(page: Page, name: string) {
  await open(page, 'view=knowledge')
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
}

test('lists what the libraries hold, by type, and searches them', async ({ page }) => {
  await open(page, 'view=knowledge')
  const discovery = page.getByRole('complementary', { name: 'Knowledge discovery' })
  await expect(discovery.getByText('Real-time networking at revision 1')).toBeVisible()
  await expect(discovery.getByRole('heading', { name: /Patterns \(7\)/ })).toBeVisible()
  await discovery.getByRole('searchbox', { name: 'Search knowledge' }).fill('lockstep')
  await expect(discovery.getByRole('button', { name: 'Deterministic lockstep' })).toBeVisible()
  await expect(discovery.getByRole('button', { name: 'Entity interpolation' })).toHaveCount(0)
})

test('reads an item with trade-offs, conditions, evidence and its limits', async ({ page }) => {
  await openItem(page, 'Deterministic lockstep')
  const item = page.getByRole('region', { name: 'Knowledge item' })
  await expect(item.getByText('Proposed', { exact: true })).toBeVisible()
  await expect(item.getByText(/Pinned at revision 1: current/)).toBeVisible()
  await expect(item.getByText(/Not a recommendation/).first()).toBeVisible()
  await expect(item.getByRole('heading', { name: 'Trade-offs' })).toBeVisible()
  await expect(item.getByRole('heading', { name: 'Declared conditions' })).toBeVisible()
  await expect(item.getByRole('heading', { name: 'Evidence and sources' })).toBeVisible()
  await expect(item.getByText(/no quotation is matched/)).toBeVisible()
  await expect(item.getByText('Support not reviewed').first()).toBeVisible()
  // Connected knowledge is navigable: a trade-off's concept opens.
  await item.getByRole('button', { name: 'Bandwidth economy' }).first().click()
  await expect(page.getByRole('heading', { level: 2, name: 'Bandwidth economy' })).toBeVisible()
})

test('assesses applicability only once a nature is chosen, and never as advice', async ({
  page,
}) => {
  await openItem(page, 'Deterministic lockstep')
  const panel = page.getByRole('region', { name: 'Applicability in this project' })
  await expect(panel.getByText(/Choose which values to assess/)).toBeVisible()
  await expect(panel.getByText(/Verdict:/)).toHaveCount(0)
  await panel.getByLabel('Scenario').selectOption({ label: 'Expansion (planned)' })
  await panel.getByLabel('Element').selectOption({ label: 'Arena shooter' })
  await panel.getByText('expected', { exact: true }).click()
  await expect(panel.getByText('Declared conditions not met')).toBeVisible()
  await expect(panel.getByText(/The scenario is planned/)).toBeVisible()
  await expect(panel.getByRole('cell', { name: /from element/ })).toBeVisible()
  await panel.getByLabel('Element').selectOption({ label: 'RTS' })
  await expect(panel.getByText('Declared conditions met', { exact: true })).toBeVisible()
  await expect(panel.getByText(/Not a recommendation/)).toBeVisible()
  expect(await panel.innerText()).not.toMatch(/recommended|you should/i)
})

test('shows an item without declared conditions as unknown, not as met', async ({ page }) => {
  await openItem(page, 'Authoritative server')
  await expect(page.getByText(/declares no conditions for this pattern/)).toBeVisible()
  const panel = page.getByRole('region', { name: 'Applicability in this project' })
  await panel.getByText('expected', { exact: true }).click()
  await expect(panel.getByText('Unknown', { exact: true })).toBeVisible()
  await expect(
    panel.getByText('The library declares nothing that must hold for this item.'),
  ).toBeVisible()
})

test('shows recorded assessments with their freshness', async ({ page }) => {
  await openItem(page, 'Deterministic lockstep')
  const recorded = page.getByRole('region', { name: 'Recorded assessments' })
  await expect(recorded.getByText('Current')).toHaveCount(2)
})

test('browses a library on its own', async ({ page }) => {
  await open(page, `project=${process.env.KALYTH_E2E_LIBRARY}&view=knowledge`)
  await expect(page.getByText('Everything this library holds, at its head.')).toBeVisible()
  await page.getByRole('button', { name: 'Snapshot interpolation' }).click()
  await expect(page.getByRole('region', { name: 'Applicability in this project' })).toHaveCount(0)
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`meets the automated accessibility rules (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await openItem(page, 'Deterministic lockstep')
    const panel = page.getByRole('region', { name: 'Applicability in this project' })
    await panel.getByText('expected', { exact: true }).click()
    await expect(panel.getByText(/Declared conditions/).first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await axeViolations(page)).toEqual([])
  })
}

test('works from the keyboard: search, open an item, choose a nature', async ({ page }) => {
  await open(page, 'view=knowledge')
  const search = page.getByRole('searchbox', { name: 'Search knowledge' })
  await search.focus()
  await page.keyboard.type('dead')
  await page.keyboard.press('Tab')
  for (let i = 0; i < 12; i++) {
    const focused = await page.evaluate(() => {
      const el = document.activeElement
      return el?.tagName === 'BUTTON' ? (el.textContent ?? '') : ''
    })
    if (focused.includes('Dead reckoning')) break
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'Dead reckoning' })).toBeVisible()
})
