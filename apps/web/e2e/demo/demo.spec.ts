import { expect, type Page, test } from '@playwright/test'
import { axeViolations } from '../app.ts'
import { JUDGE_CODE } from './global-setup.ts'

// The hosted demo as a visitor meets it (ADR 0019): no token, their own copy, recorded runs that
// work with live runs off, the judge code, and the same keyboard and accessibility standards.

const url = (query = '') => {
  const base = process.env.KALYTH_E2E_DEMO_URL
  if (!base) throw new Error('KALYTH_E2E_DEMO_URL is not set; run through playwright test')
  return `${base}${query ? `?${query}` : ''}`
}
const press = (page: Page, key: string) => page.keyboard.press(key)

/** A panel by its heading. Panels are plain sections, not landmark regions. */
const panel = (page: Page, title: string) =>
  page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) })

async function open(page: Page, query = '') {
  await page.goto(url(query))
  await page.getByRole('region', { name: 'About this demo' }).waitFor()
}

test('opens a private copy without any token', async ({ page }) => {
  await open(page)
  const banner = page.getByRole('region', { name: 'About this demo' })
  await expect(banner).toContainText('your own copy')
  await expect(banner).toContainText('live runs are off')
  await expect(page.getByText('FastAPI full-stack template').first()).toBeVisible()
  expect(await axeViolations(page)).toEqual([])
})

test('runs a recorded preset and accepts an alternative, by keyboard', async ({ page }) => {
  await open(page)
  // 4: New change, the Navigator.
  await press(page, '4')
  const presets = panel(page, 'Try a change request')
  await expect(presets).toBeVisible()
  // Only the recorded presets can run while live runs are off.
  await expect(
    presets.getByRole('button', { name: 'Soft-delete and restore items' }),
  ).toBeDisabled()
  await expect(presets).toContainText('Live runs are off in this demo')
  const recorded = presets.getByRole('button', { name: 'Add multi-tenancy' })
  await recorded.focus()
  await press(page, 'Enter')
  // A recorded preset opens its change thread, as a request typed by hand does.
  await expect(page).toHaveURL(/view=change&run=nav_/)
  const next = page.getByRole('main').getByRole('region', { name: 'Next step' })
  await expect(next).toContainText('Review the proposed alternatives', { timeout: 15_000 })
  await expect(page.getByRole('main')).toContainText('recorded, replayed free')
  expect(await axeViolations(page)).toEqual([])

  // Commit the run's proposal, then accept one of its alternatives, all in this visitor's copy.
  const commit = next.getByRole('button', { name: 'Commit the alternatives' })
  await commit.focus()
  await press(page, 'Enter')
  await expect(page).toHaveURL(/decision=/)

  await page.locator('body').focus()
  // 3: Changes.
  await press(page, '3')
  const decision = page
    .getByRole('main')
    .getByRole('link', { name: /multi-tenancy/i })
    .first()
  await decision.focus()
  await press(page, 'Enter')
  await expect(page).toHaveURL(/decision=/)
  const accept = page.getByRole('button', { name: /^Accept A\d/ }).first()
  await accept.focus()
  await press(page, 'Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('textbox')).toBeFocused()
  await page.keyboard.type('Accepted in the hosted demo.')
  await press(page, 'Tab')
  await press(page, 'Tab')
  await expect(dialog.getByRole('button', { name: 'Accept alternative' })).toBeFocused()
  await press(page, 'Enter')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('main')).toContainText('Decision status: Accepted')
})

test('a first visit says what Kalyth does, and the workspace works at phone width', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const page = await context.newPage()
  await open(page)
  const start = page.getByRole('main').getByText('Start here').locator('..')
  await expect(start).toContainText('evidence-backed engineering model')
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(await overflow()).toBe(0)
  expect(await axeViolations(page)).toEqual([])

  // The rail starts folded, and every place stays one tap away.
  const rail = page.getByRole('navigation', { name: 'Workspace' })
  for (const place of ['Canvas', 'Changes', 'Records', 'Agents and packages', 'History']) {
    await rail.getByRole('link', { name: place, exact: true }).click()
    await expect(page.getByRole('main')).toBeVisible()
    expect(await overflow()).toBe(0)
  }
  await rail.getByRole('link', { name: 'Situation', exact: true }).click()
  await page.getByRole('link', { name: 'Try a recorded change request' }).click()
  await expect(panel(page, 'Try a change request')).toBeVisible()
  // Which model answers what: the recordings, and a visitor's own requests.
  const models = page.getByRole('region', { name: 'Provider, budget and consent' })
  await expect(models).toContainText('Recorded change requestsNemotron 3 Ultra')
  await context.close()
})

test('says why live runs are paused, and recorded runs keep working', async ({ page }) => {
  await open(page, 'view=navigator')
  const request = page.getByRole('textbox', { name: /change/i })
  await request.fill('Add per-user quotas on items.')
  await page
    .getByRole('button', { name: /^(Start|Run|Propose)/ })
    .first()
    .click()
  await expect(page.getByRole('main')).toContainText('Live runs are paused', { timeout: 15_000 })
  await expect(page.getByRole('main')).toContainText('recorded presets still run')
  expect(await axeViolations(page)).toEqual([])
  await page.getByRole('main').getByRole('link', { name: 'Try a recorded preset' }).click()
  await panel(page, 'Try a change request')
    .getByRole('button', { name: 'Summarise the backend' })
    .click()
  await expect(page.getByRole('main')).toContainText('Recorded Nemotron run', { timeout: 15_000 })
})

test('a judge code unlocks the judges’ allowance', async ({ page }) => {
  await open(page)
  const banner = page.getByRole('region', { name: 'About this demo' })
  const button = banner.getByRole('button', { name: 'I have a judge code' })
  await button.focus()
  await press(page, 'Enter')
  const dialog = page.getByRole('dialog', { name: 'Judge code' })
  await expect(dialog.getByLabel('Code')).toBeFocused()
  expect(await axeViolations(page)).toEqual([])
  await page.keyboard.type('not-the-code')
  await press(page, 'Enter')
  await expect(dialog).toContainText('that code is not right')
  await dialog.getByLabel('Code').fill(JUDGE_CODE)
  await press(page, 'Enter')
  await expect(dialog).toBeHidden()
  await expect(banner).toContainText('Judges’ allowance')
})

test('the Handoff and Tasks views explain what runs only locally', async ({ page }) => {
  await open(page, 'view=handoff')
  await expect(page.getByRole('main')).toContainText(
    'Agent access over MCP is off in this hosted demo',
  )
  expect(await axeViolations(page)).toEqual([])
  await open(page, 'view=tasks')
  await expect(page.getByRole('main')).toContainText('The hosted demo has none')
  expect(await axeViolations(page)).toEqual([])
})

test('at the narrowest supported width, a run report passes the same checks', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await open(page, 'view=navigator')
  await panel(page, 'Try a change request')
    .getByRole('button', { name: 'Summarise the backend' })
    .click()
  await expect(page.getByRole('main')).toContainText('Recorded Nemotron run', { timeout: 15_000 })
  expect(await axeViolations(page)).toEqual([])
})
