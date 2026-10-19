import { expect, type Page, test } from '@playwright/test'
import { open, VIEWS } from './app.ts'

// Keyboard users must always see where focus is (WCAG 2.4.7). This tabs through the first 40 stops
// of each view and lists every stop that shows no focus indicator.

/**
 * Whether the focused element shows that it has focus. An outline or a focus ring on it, or on
 * the label or wrapper that draws focus for it, counts. Otherwise, as for graph edges whose stroke
 * thickens, it counts when the element looks different focused and blurred.
 */
async function focusIndicator(page: Page): Promise<{ name: string; visible: boolean } | null> {
  const styled = await page.evaluate(() => {
    const active = document.activeElement
    if (!active || active === document.body) return null
    const shows = (el: Element) => {
      const s = getComputedStyle(el)
      const outline = s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) >= 1
      return outline || (s.boxShadow !== 'none' && s.boxShadow.includes('0px 0px 0px'))
    }
    let el: Element | null = active
    let visible = false
    for (let depth = 0; el && depth < 3 && !visible; depth++, el = el.parentElement) {
      visible = shows(el)
    }
    const label = active.getAttribute('aria-label') ?? (active.textContent ?? '').trim()
    const r = active.getBoundingClientRect()
    return {
      name: `${active.tagName.toLowerCase()} "${label.slice(0, 60)}"`,
      visible,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
    }
  })
  if (!styled || styled.visible) return styled
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
  const x = Math.max(0, styled.box.x - 3)
  const y = Math.max(0, styled.box.y - 3)
  const clip = {
    x,
    y,
    width: Math.min(viewport.width, styled.box.x + styled.box.width + 3) - x,
    height: Math.min(viewport.height, styled.box.y + styled.box.height + 3) - y,
  }
  if (clip.width <= 0 || clip.height <= 0) return { name: styled.name, visible: false }
  const element = await page.evaluateHandle(() => document.activeElement as HTMLElement)
  const focused = await page.screenshot({ clip, animations: 'disabled' })
  await element.evaluate((el) => el.blur())
  const blurred = await page.screenshot({ clip, animations: 'disabled' })
  await element.evaluate((el) => el.focus())
  return { name: styled.name, visible: !focused.equals(blurred) }
}

for (const view of VIEWS) {
  test(`every Tab stop in the ${view} view shows where focus is`, async ({ page }) => {
    await open(page, `view=${view}`)
    await page.waitForLoadState('networkidle')
    const missing: string[] = []
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      const focus = await focusIndicator(page)
      if (!focus) break
      if (!focus.visible && !seen.has(focus.name)) missing.push(focus.name)
      seen.add(focus.name)
    }
    expect(missing).toEqual([])
  })
}
