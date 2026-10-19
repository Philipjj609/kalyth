import { expect, test } from '@playwright/test'
import { axeViolations } from './app.ts'

const IDEA = 'A tutoring platform where students book sessions with tutors.'

/** Journey 1 (ADR 0022): from an idea, with no repository, to a first model a person commits. */
test('journey 1: start a project from an idea and commit a first model', async ({ page }) => {
  const url = process.env.KALYTH_E2E_URL
  if (!url) throw new Error('KALYTH_E2E_URL is not set; run the tests through playwright test')
  const { origin, hash } = new URL(url)
  const at = (query: string) => page.goto(`${origin}/?${query}${hash}`)

  // The only project opens on arrival; the list of all projects is one click away.
  await at('')
  await page.getByRole('button', { name: 'Kalyth: all projects' }).click()
  await page.getByRole('button', { name: 'New project' }).click()
  const form = page.getByRole('form', { name: 'New project' })
  await form.getByRole('textbox', { name: 'Name' }).fill('Tutoring platform')
  await form.getByRole('textbox', { name: 'The idea' }).fill(IDEA)
  expect(await axeViolations(page)).toEqual([])
  await form.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/project=prj_/)
  const projectId = new URL(page.url()).searchParams.get('project') ?? ''

  // The Navigator starts from the idea, since the project has no elements yet.
  await at(`project=${projectId}&view=navigator`)
  await expect(page.getByRole('textbox', { name: 'What should it be?' })).toHaveValue(IDEA)
  await page.getByRole('button', { name: 'Propose alternatives' }).click()
  const main = page.getByRole('main')
  await expect(main).toContainText('Run status: Completed', { timeout: 15_000 })
  await expect(main).toContainText('Web application (proposed)')
  expect(await axeViolations(page)).toEqual([])

  await at(`project=${projectId}&view=proposals`)
  const commit = page.getByRole('button', { name: 'Commit', exact: true })
  await expect(commit).toHaveCount(1)
  await commit.click()
  await expect(commit).toHaveCount(0)

  await at(`project=${projectId}&view=records`)
  await expect(main).toContainText('Web application')
  await expect(main).toContainText('Core record')
})
