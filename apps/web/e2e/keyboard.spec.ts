import { expect, type Page, test } from '@playwright/test'
import { axeViolations, open } from './app.ts'

// The main flows, with the keyboard only (G4). Each test starts from the session link, as a person
// would. The flows change the shared sample project; with one worker they run in file order.

/** The places of the workspace rail, in the order number keys reach them. */
const PLACES = [
  'Situation',
  'Canvas',
  'Changes',
  'New change',
  'Records',
  'Proposals',
  'Tasks',
  'Agents and packages',
  'History',
]

const press = (page: Page, key: string) => page.keyboard.press(key)

test('the skip link moves past the header to the content', async ({ page }) => {
  await open(page)
  await press(page, 'Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await press(page, 'Enter')
  await press(page, 'Tab')
  const inMain = await page.evaluate(
    () => document.getElementById('main')?.contains(document.activeElement) ?? false,
  )
  const inHeader = await page.evaluate(
    () => document.querySelector('header')?.contains(document.activeElement) ?? false,
  )
  expect({ inMain, inHeader }).toEqual({ inMain: true, inHeader: false })
})

test('number keys reach every place in the rail', async ({ page }) => {
  await open(page)
  const rail = page.getByRole('navigation', { name: 'Workspace' })
  for (const [i, label] of PLACES.entries()) {
    await press(page, String(i + 1))
    await expect(rail.locator('[aria-current="page"]').first()).toContainText(label)
  }
  await press(page, '1')
  await expect(page.getByRole('main', { name: 'Situation' })).toBeVisible()
})

test('the palette finds an element and opens it on the canvas', async ({ page }) => {
  await open(page)
  await press(page, 'Control+k')
  const search = page.getByRole('combobox', { name: 'Search elements, changes or actions' })
  await expect(search).toBeFocused()
  await page.keyboard.type('crud.py')
  const results = page.getByRole('listbox', { name: 'Results' })
  await expect(results.getByRole('option').first()).toContainText('crud.py')
  expect(await axeViolations(page)).toEqual([])
  await press(page, 'Enter')
  await expect(page).toHaveURL(/view=graph/)
  await expect(page).toHaveURL(/sel=/)
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toContainText('crud.py')
  await press(page, 'Escape')
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0)
})

test('records: search, open a record in the Inspector, and clear it', async ({ page }) => {
  await open(page, 'view=records')
  await page.waitForLoadState('networkidle')
  await press(page, '/')
  const search = page.getByRole('searchbox')
  await expect(search).toBeFocused()
  await page.keyboard.type('crud.py')
  await press(page, 'Tab')
  // Tab past any filter controls to the first record.
  const first = page.getByRole('row').nth(1).getByRole('button').first()
  for (let i = 0; i < 40 && !(await first.evaluate((el) => el === document.activeElement)); i++) {
    await press(page, 'Tab')
  }
  await expect(first).toBeFocused()
  await press(page, 'Enter')
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector).toContainText('crud.py')
  expect(await axeViolations(page)).toEqual([])
  await press(page, 'Escape')
  await expect(page).not.toHaveURL(/sel=/)
})

test('graph: focus a node and open it with Enter', async ({ page }) => {
  await open(page, 'view=graph')
  await page.waitForLoadState('networkidle')
  const node = page.locator('.react-flow__node').first()
  await node.waitFor()
  for (let i = 0; i < 60 && !(await node.evaluate((el) => el.matches(':focus'))); i++) {
    await press(page, 'Tab')
  }
  await expect(node).toBeFocused()
  await press(page, 'Enter')
  await expect(page).toHaveURL(/sel=/)
  expect(await axeViolations(page)).toEqual([])
})

test('proposals: the reject dialog takes focus, and Escape gives it back', async ({ page }) => {
  await open(page, 'view=proposals')
  await page.waitForLoadState('networkidle')
  const reject = page.getByRole('button', { name: /Reject/ }).first()
  await reject.focus()
  await press(page, 'Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const focusInside = await dialog.evaluate((d) => d.contains(document.activeElement))
  expect(focusInside).toBe(true)
  expect(await axeViolations(page)).toEqual([])
  await press(page, 'Escape')
  await expect(dialog).toBeHidden()
  await expect(reject).toBeFocused()
})

test('proposals: commit the pending proposal from the keyboard', async ({ page }) => {
  await open(page, 'view=proposals')
  await page.waitForLoadState('networkidle')
  const commits = page.getByRole('button', { name: 'Commit', exact: true })
  const pending = await commits.count()
  expect(pending).toBeGreaterThan(0)
  await commits.first().focus()
  await press(page, 'Enter')
  await expect(commits).toHaveCount(pending - 1)
})

test('navigator: start a mock alternatives run from the keyboard', async ({ page }) => {
  await open(page, 'view=navigator')
  await page.waitForLoadState('networkidle')
  // The run appears in the Navigator's list and, awaiting review, in the rail as well.
  const run = page.getByRole('main').getByRole('link', { name: /Add multi-tenancy to the API/ })
  await expect(run).toHaveCount(0)
  const request = page.getByRole('textbox', { name: /change/i })
  await request.focus()
  await page.keyboard.type('Add multi-tenancy to the API')
  await press(page, 'Tab')
  for (let i = 0; i < 12; i++) {
    const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    if (/^(Start|Run|Propose)/.test(name)) break
    await press(page, 'Tab')
  }
  await press(page, 'Enter')
  // The run opens as a change thread and is listed in the rail while it awaits review.
  await expect(page).toHaveURL(/view=change&run=nav_/)
  await expect(
    page.getByRole('main').getByRole('heading', { level: 1, name: /Add multi-tenancy to the API/ }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('main').getByRole('region', { name: 'Next step' })).toContainText(
    'Review the proposed alternatives',
    { timeout: 15_000 },
  )
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', {
      name: /Add multi-tenancy to the API/,
    }),
  ).toBeVisible()
  expect(await axeViolations(page)).toEqual([])
})

test('changes: open a change, compare, and accept an alternative from the keyboard', async ({
  page,
}) => {
  await open(page, 'view=change')
  await page.waitForLoadState('networkidle')
  // A decision, not a run that still awaits review.
  const change = page.getByRole('main').locator('li a[href*="decision="]').first()
  await change.focus()
  await press(page, 'Enter')
  await expect(page).toHaveURL(/decision=/)
  const main = page.getByRole('main')
  await expect(main.getByRole('region', { name: 'Next step' })).toBeVisible()
  await expect(main).not.toContainText('Decision status: Accepted')
  expect(await axeViolations(page)).toEqual([])

  // The comparison: every alternative, and its interpretation kept apart from evidence.
  await main
    .getByRole('link', { name: /Compare side by side/ })
    .first()
    .focus()
  await press(page, 'Enter')
  await expect(page).toHaveURL(/view=compare/)
  await expect(page.getByRole('table')).toContainText('generated interpretation')
  expect(await axeViolations(page)).toEqual([])
  await page.goBack()

  const accept = page.getByRole('button', { name: /^Accept A\d/ }).first()
  await accept.focus()
  await press(page, 'Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox')).toBeFocused()
  expect(await axeViolations(page)).toEqual([])
  await press(page, 'Escape')
  await expect(dialog).toBeHidden()
  await expect(accept).toBeFocused()

  await press(page, 'Enter')
  await expect(dialog.getByRole('textbox')).toBeFocused()
  await page.keyboard.type('Cookies keep the token out of reach of page scripts.')
  await press(page, 'Tab')
  await press(page, 'Tab')
  await expect(dialog.getByRole('button', { name: 'Accept alternative' })).toBeFocused()
  await press(page, 'Enter')
  await expect(dialog).toBeHidden()
  await expect(main).toContainText('Decision status: Accepted')
})

test('history: open a past revision and return to the head', async ({ page }) => {
  await open(page, 'view=history')
  await page.waitForLoadState('networkidle')
  const past = page.getByRole('button', { name: 'View the model at revision 1', exact: true })
  await past.focus()
  await press(page, 'Enter')
  await expect(page).toHaveURL(/rev=1/)
  expect(await axeViolations(page)).toEqual([])
  const back = page.getByRole('button', { name: 'Return to head' })
  await back.focus()
  await press(page, 'Enter')
  await expect(page).not.toHaveURL(/rev=/)
})
