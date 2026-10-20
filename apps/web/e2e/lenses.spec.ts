import { expect, test } from '@playwright/test'
import { axeViolations, open } from './app.ts'

// The canvas lenses and editing through proposals (ADR 0020). The lenses are read on the sample
// project, which stays unchanged; the edits are made in a project of their own. The file runs
// after the journeys, which expect the sample to be the only project at first.

const LENSES = ['Basis', 'Freshness', 'Impact', 'Decisions'] as const

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })
    test('every lens is a pressed toggle, keeps the address and passes axe', async ({ page }) => {
      await open(page, 'view=graph')
      await page.waitForLoadState('networkidle')
      const lenses = page.getByRole('group', { name: 'Lens' })
      for (const lens of LENSES) {
        const button = lenses.getByRole('button', { name: lens, exact: true })
        await button.focus()
        await page.keyboard.press('Enter')
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await expect(page).toHaveURL(new RegExp(`lens=${lens.toLowerCase()}`))
        await page.waitForLoadState('networkidle')
        expect(await axeViolations(page), `${lens} lens`).toEqual([])
      }
      const focus = page.getByRole('group', { name: 'Focus around the selection' })
      await focus.getByRole('button', { name: '1 hop' }).click()
      await expect(focus.getByRole('button', { name: '1 hop' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })
  })
}

test('add an element from the canvas as a proposal, then commit it', async ({ page }) => {
  const { origin, hash } = new URL(process.env.KALYTH_E2E_URL ?? '')
  const token = hash.replace(/^#token=/, '')
  const res = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-kalyth-ui': '1',
    },
    body: JSON.stringify({ name: 'Canvas edits', description: 'A ledger for a bakery.' }),
  })
  const project = (await res.json()) as { id: string }
  await open(page, `project=${project.id}&view=graph`)
  await page.waitForLoadState('networkidle')

  // An empty project offers to add the first element.
  await expect(page.getByText('No elements yet')).toBeVisible()
  await page.getByRole('button', { name: 'Add an element (creates a proposal)' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused()
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Ledger service')
  expect(await axeViolations(page)).toEqual([])
  await dialog.getByRole('button', { name: 'Propose element' }).click()

  // The confirmation lists what was proposed, with its provenance; nothing is applied yet.
  await expect(dialog).toContainText('Pending proposal:')
  await expect(dialog.getByRole('region', { name: 'Proposed operations' })).toContainText(
    'Ledger service',
  )
  await expect(dialog).toContainText('Stated by you; not in the model until committed.')
  await expect(dialog.getByRole('link', { name: 'Open in Proposals' })).toBeVisible()
  expect(await axeViolations(page)).toEqual([])
  await dialog.getByRole('button', { name: 'Commit now' }).click()
  await expect(dialog).toContainText('Committed.')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()

  // The element is on the canvas, drawn as a proposed draft whose basis is what a person stated.
  const node = page.getByRole('group', { name: /^Container Ledger service, proposed, stated/ })
  await expect(node).toBeVisible({ timeout: 15_000 })
  await node.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/sel=obj_/)
  await expect(page.getByRole('group', { name: 'Edit Ledger service' })).toBeVisible()
})
