import { expect, test } from '@playwright/test'
import { axeViolations, open } from './app.ts'

// The canvas lenses (ADR 0020), read on the sample project, which stays unchanged.

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
