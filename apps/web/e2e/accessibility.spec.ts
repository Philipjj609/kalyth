import { expect, test } from '@playwright/test'
import { axeViolations, open, VIEWS } from './app.ts'

// Automated WCAG 2.2 A and AA checks (axe) on every view, in both themes. Automated rules find
// roughly a third of accessibility problems; the keyboard flows cover more, and neither replaces a
// review with a screen reader.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })
    for (const view of VIEWS) {
      test(`${view} view`, async ({ page }) => {
        await open(page, `view=${view}`)
        await page.waitForLoadState('networkidle')
        expect(await axeViolations(page)).toEqual([])
      })
    }
  })
}

// At the narrowest width the workbench supports, wide tables and code scroll; each scrolling box
// must still be reachable by keyboard.
test.describe('narrowest supported width', () => {
  test.use({ viewport: { width: 1024, height: 768 } })
  for (const view of VIEWS) {
    test(`${view} view`, async ({ page }) => {
      await open(page, `view=${view}`)
      await page.waitForLoadState('networkidle')
      expect(await axeViolations(page)).toEqual([])
    })
  }
})
