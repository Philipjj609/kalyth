import { execFileSync } from 'node:child_process'
import { GitRepository } from '@kalyth/analyzer'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureRepo } from '../../analyzer/test/fixture-repo.ts'
import { taskTrailer, verifyReport } from '../src/index.ts'

const taskId = '019a0000-0000-7000-8000-000000000001'
const repos: FixtureRepo[] = []
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose()
})

describe('git verifier (ADR 0013)', () => {
  it('accepts a root commit and checks descent from the task base', () => {
    const repo = new FixtureRepo()
    repos.push(repo)
    repo.write({ 'a.txt': 'a\n' })
    const root = repo.commit(`Start\n\n${taskTrailer(taskId)}`)
    const git = new GitRepository(repo.path)
    expect(verifyReport(git, { taskId, commit: root, filesChanged: ['./a.txt'] }).outcome).toBe(
      'pass',
    )

    repo.write({ 'b.txt': 'b\n' })
    const base = repo.commit('base')
    // A side branch from the root does not contain the base.
    execFileSync('git', ['-C', repo.path, 'checkout', '-q', '-b', 'side', root])
    repo.write({ 'c.txt': 'c\n' })
    const side = repo.commit(`Side\n\n${taskTrailer(taskId)}`)
    const verdict = verifyReport(git, {
      taskId,
      commit: side,
      filesChanged: ['c.txt'],
      baseCommit: base,
    })
    expect(verdict.outcome).toBe('fail')
    expect(verdict.checks.find((c) => c.name === 'descends from base')?.ok).toBe(false)
    expect(verdict.checks.filter((c) => !c.ok)).toHaveLength(1)
  })

  it('does not accept a trailer for another task or a mention in prose', () => {
    const repo = new FixtureRepo()
    repos.push(repo)
    repo.write({ 'a.txt': 'a\n' })
    const sha = repo.commit(
      `Mentions ${taskTrailer(taskId)} inline\n\n${taskTrailer(`${taskId}0`)}`,
    )
    const verdict = verifyReport(new GitRepository(repo.path), {
      taskId,
      commit: sha,
      filesChanged: ['a.txt'],
    })
    expect(verdict.checks.find((c) => c.name === 'task trailer')?.ok).toBe(false)
  })

  it('reads refs as revisions, never as options or patterns', () => {
    const repo = new FixtureRepo()
    repos.push(repo)
    repo.write({ 'a.txt': 'a\n' })
    const head = repo.commit(`Start\n\n${taskTrailer(taskId)}`)
    const git = new GitRepository(repo.path)
    expect(() => git.isAncestor('--all', head)).toThrow()
    expect(() => git.resolveCommit('--all')).toThrow()
    // A task id is matched literally in the trailer, not as a pattern.
    const trailer = (id: string) =>
      verifyReport(git, { taskId: id, commit: head, filesChanged: ['a.txt'] }).checks.find(
        (c) => c.name === 'task trailer',
      )?.ok
    expect(trailer('.*')).toBe(false)
    expect(trailer(taskId)).toBe(true)
  })
})
