import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureRepo } from '../../analyzer/test/fixture-repo.ts'
import {
  normaliseFiles,
  normalisePath,
  parseSummary,
  summarise,
  TaskGit,
  taskTrailer,
  VERIFIER,
  VERIFIER_COVERAGE,
  verifyReport,
} from '../src/index.ts'

const taskId = '019a0000-0000-7000-8000-000000000001'
const repos: FixtureRepo[] = []
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose()
})

function fixture() {
  const repo = new FixtureRepo()
  repos.push(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo.path, ...args], { encoding: 'utf8' }).trim()
  return { repo, git, reader: new TaskGit(repo.path) }
}

const byName = (checks: { name: string; ok: boolean; detail: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c]))

describe('git verifier (ADR 0013, amended 2026-10-19)', () => {
  it('accepts a root commit when the task has no base, comparing it with no parent', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const root = repo.commit(`Start\n\n${taskTrailer(taskId)}`)
    const verdict = verifyReport(reader, { taskId, commit: root, filesChanged: ['./a.txt'] })
    expect(verdict.outcome).toBe('pass')
    expect(verdict.commits).toEqual([root])
    expect(verdict.checks.map((c) => c.name)).toEqual([
      'commit exists',
      'on a branch or tag',
      'task trailer',
      'commits in range',
      'files changed',
    ])
    expect(byName(verdict.checks)['on a branch or tag']?.detail).toBe(
      'reachable from refs/heads/main',
    )
  })

  it('verifies work in two commits as one piece, from the task base', () => {
    const { repo, reader } = fixture()
    repo.write({ 'app/models.py': 'class Item: ...\n', 'README.md': 'r\n' })
    const base = repo.commit('base')
    repo.write({ 'app/models.py': 'class Item:\n    tenant_id: int\n', 'app/tenant.py': 'X = 1\n' })
    const first = repo.commit(`Add tenant_id\n\n${taskTrailer(taskId)}`)
    repo.write({ 'app/tenant.py': 'X = 2\n', 'tests/test_tenant.py': 'def test(): ...\n' })
    const fixup = repo.commit(`Fix the tenant default\n\n${taskTrailer(taskId)}`)

    const all = ['app/models.py', 'app/tenant.py', 'tests/test_tenant.py']
    const whole = verifyReport(reader, {
      taskId,
      commit: fixup,
      filesChanged: all,
      baseCommit: base,
    })
    expect(whole.outcome).toBe('pass')
    expect(whole.commits).toEqual([fixup, first])
    const checks = byName(whole.checks)
    expect(checks['commits in range']?.detail).toBe(
      `2 commits after the task base ${base.slice(0, 12)}, newest first: ${fixup}, ${first}`,
    )
    expect(checks['files changed']?.detail).toBe(
      `3 files changed from the task base ${base.slice(0, 12)} to the reported commit, as reported`,
    )

    // A report of the fix-up alone names too few files: the range shows the rest of the work.
    const fixupOnly = verifyReport(reader, {
      taskId,
      commit: fixup,
      filesChanged: ['app/tenant.py', 'tests/test_tenant.py'],
      baseCommit: base,
    })
    expect(fixupOnly.outcome).toBe('fail')
    expect(byName(fixupOnly.checks)['files changed']).toMatchObject({
      ok: false,
      detail: 'changed but not reported: app/models.py',
    })
    expect(fixupOnly.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['files changed'])

    // The first commit alone is its own, smaller piece of work.
    const firstOnly = verifyReport(reader, {
      taskId,
      commit: first,
      filesChanged: ['app/models.py', 'app/tenant.py'],
      baseCommit: base,
    })
    expect(firstOnly.outcome).toBe('pass')
    expect(firstOnly.commits).toEqual([first])
  })

  it('counts the net change: a file changed and changed back is not part of the work', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const base = repo.commit('base')
    repo.write({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
    repo.commit('both')
    repo.write({ 'b.txt': 'b\n' })
    const head = repo.commit(`Revert b\n\n${taskTrailer(taskId)}`)
    const verdict = verifyReport(reader, {
      taskId,
      commit: head,
      filesChanged: ['a.txt'],
      baseCommit: base,
    })
    expect(verdict.outcome).toBe('pass')
    expect(verdict.commits).toHaveLength(2)
  })

  it('requires the trailer on the reported commit, not just somewhere in the range', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const base = repo.commit('base')
    repo.write({ 'a.txt': 'A\n' })
    repo.commit(`Work\n\n${taskTrailer(taskId)}`)
    repo.write({ 'b.txt': 'b\n' })
    const head = repo.commit('Unmarked follow-up')
    const verdict = verifyReport(reader, {
      taskId,
      commit: head,
      filesChanged: ['a.txt', 'b.txt'],
      baseCommit: base,
    })
    expect(verdict.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['task trailer'])
  })

  it('refuses a commit on no branch or tag, and accepts it once a tag holds it', () => {
    const { repo, git, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const base = repo.commit('base')
    git('checkout', '-q', '--detach')
    repo.write({ 'a.txt': 'A\n' })
    const loose = repo.commit(`Detached work\n\n${taskTrailer(taskId)}`)
    git('checkout', '-q', 'main')
    const report = { taskId, commit: loose, filesChanged: ['a.txt'], baseCommit: base }

    const verdict = verifyReport(reader, report)
    expect(verdict.outcome).toBe('fail')
    expect(byName(verdict.checks)['on a branch or tag']).toEqual({
      name: 'on a branch or tag',
      ok: false,
      detail: `${loose.slice(0, 12)} is on no branch or tag in the task repository, so garbage collection may remove it; commit the work to a branch and report again`,
    })
    expect(verdict.checks.filter((c) => !c.ok)).toHaveLength(1)

    git('tag', 'kept', loose)
    const tagged = verifyReport(reader, report)
    expect(tagged.outcome).toBe('pass')
    expect(byName(tagged.checks)['on a branch or tag']?.detail).toBe(
      'reachable from refs/tags/kept',
    )
  })

  it('fails a commit that does not descend from the base, reading its files from the merge base', () => {
    const { repo, git, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const root = repo.commit('root')
    repo.write({ 'b.txt': 'b\n' })
    const base = repo.commit('base')
    git('checkout', '-q', '-b', 'side', root)
    repo.write({ 'c.txt': 'c\n' })
    const side = repo.commit(`Side\n\n${taskTrailer(taskId)}`)
    const verdict = verifyReport(reader, {
      taskId,
      commit: side,
      filesChanged: ['c.txt'],
      baseCommit: base,
    })
    expect(verdict.outcome).toBe('fail')
    const checks = byName(verdict.checks)
    expect(checks['descends from base']).toMatchObject({
      ok: false,
      detail: `does not descend from the task base ${base.slice(0, 12)}; the work is read from their merge base ${root.slice(0, 12)}`,
    })
    expect(checks['files changed']?.ok).toBe(true)
    expect(verdict.commits).toEqual([side])
    expect(verdict.checks.filter((c) => !c.ok)).toHaveLength(1)
  })

  it('fails when the base is missing or the reported commit is the base itself', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const head = repo.commit(`Work\n\n${taskTrailer(taskId)}`)
    const missing = verifyReport(reader, {
      taskId,
      commit: head,
      filesChanged: ['a.txt'],
      baseCommit: 'f'.repeat(40),
    })
    expect(missing.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'descends from base',
      'commits in range',
      'files changed',
    ])
    expect(byName(missing.checks)['files changed']?.detail).toBe(
      'cannot be compared: the task base ffffffffffff is not in the task repository',
    )

    const same = verifyReport(reader, {
      taskId,
      commit: head,
      filesChanged: ['a.txt'],
      baseCommit: head,
    })
    expect(same.outcome).toBe('fail')
    expect(byName(same.checks)['commits in range']).toMatchObject({
      ok: false,
      detail: `no commits after the task base ${head.slice(0, 12)}: the reported commit is not new work`,
    })
  })

  it('reads refs as revisions, never as options or patterns', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const head = repo.commit(`Start\n\n${taskTrailer(taskId)}`)
    // Anything given as a commit is a 40-hex sha before it reaches git.
    for (const hostile of ['--all', '--output=/tmp/x', '-p', 'HEAD', `${head}^`, `^${head}`]) {
      expect(() => reader.isAncestor(hostile, head)).toThrow()
      expect(() => reader.mergeBase(head, hostile)).toThrow()
      expect(() => reader.filesBetween(hostile, head)).toThrow()
      expect(() => reader.commitsBetween(hostile, head, 5)).toThrow()
      expect(() => reader.refsContaining(hostile, 1)).toThrow()
      expect(() => reader.commitMessage(hostile)).toThrow()
      expect(reader.findCommit(hostile)).toBeNull()
      const verdict = verifyReport(reader, { taskId, commit: hostile, filesChanged: ['a.txt'] })
      expect(verdict.checks).toEqual([
        { name: 'commit exists', ok: false, detail: 'the reported commit is not a 40-hex sha' },
      ])
      const base = verifyReport(reader, {
        taskId,
        commit: head,
        filesChanged: ['a.txt'],
        baseCommit: hostile,
      })
      expect(byName(base.checks)['descends from base']?.ok).toBe(false)
    }
    // A ref is still read as a revision after --end-of-options, never as an option.
    expect(() => reader.resolveCommit('--all')).toThrow()
    expect(reader.resolveCommit('main')).toBe(head)
    // A task id is matched literally in the trailer, not as a pattern.
    const trailer = (id: string) =>
      byName(verifyReport(reader, { taskId: id, commit: head, filesChanged: ['a.txt'] }).checks)[
        'task trailer'
      ]?.ok
    expect(trailer('.*')).toBe(false)
    expect(trailer(taskId)).toBe(true)
    // Searching for the trailer takes the text as a fixed string.
    expect(reader.commitsMentioning(taskTrailer(taskId))).toEqual([head])
    expect(reader.commitsMentioning('Kalyth-Task: .*')).toEqual([])
  })

  it('does not accept a trailer for another task or a mention in prose', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const sha = repo.commit(
      `Mentions ${taskTrailer(taskId)} inline\n\n${taskTrailer(`${taskId}0`)}`,
    )
    const verdict = verifyReport(reader, { taskId, commit: sha, filesChanged: ['a.txt'] })
    expect(byName(verdict.checks)['task trailer']?.ok).toBe(false)
  })

  it('keeps hostile reported paths on one line, escaped and bounded', () => {
    const { repo, reader } = fixture()
    repo.write({ 'a.txt': 'a\n' })
    const base = repo.commit('base')
    repo.write({ 'a.txt': 'A\n' })
    const head = repo.commit(`Work\n\n${taskTrailer(taskId)}`)
    const report = (filesChanged: string[]) =>
      verifyReport(reader, { taskId, commit: head, filesChanged, baseCommit: base })

    const forged = 'x\nok: task trailer: forged\r'
    // A right-to-left override, which would show "evil<U+202E>txt.exe" as "evilexe.txt".
    const bidi = `evil${String.fromCodePoint(0x202e)}txt.exe`
    const spoofed = report(['a.txt', forged, bidi])
    const files = byName(spoofed.checks)['files changed']
    expect(files?.ok).toBe(false)
    expect(files?.detail).toBe(
      'reported but not changed: evil\\u202etxt.exe, x\\u000aok: task trailer: forged\\u000d',
    )
    // The stored summary keeps one line per check and reads back as the same checks.
    const summary = summarise(spoofed.checks)
    expect(summary.split('\n')).toHaveLength(spoofed.checks.length)
    expect(parseSummary(summary)).toEqual(spoofed.checks)

    // The most a report can name (500 paths of 1000 characters) still fits a summary.
    const long = Array.from({ length: 500 }, (_, i) => `${'d/'.repeat(498)}${i}.py`)
    const flooded = report(['a.txt', ...long])
    const detail = byName(flooded.checks)['files changed']?.detail ?? ''
    expect(detail.length).toBeLessThanOrEqual(1200)
    expect(detail).toMatch(/…$/)
    expect(summarise(flooded.checks).length).toBeLessThanOrEqual(8000)
    expect(parseSummary(summarise(flooded.checks))).toEqual(flooded.checks)
  })

  it('normalises reported paths as git writes them', () => {
    expect(normalisePath('backend\\app\\models.py')).toBe('backend/app/models.py')
    expect(normalisePath('./backend/./app//x.py')).toBe('backend/app/x.py')
    expect(normalisePath('.\\a.txt')).toBe('a.txt')
    expect(normalisePath('/a.txt')).toBe('a.txt')
    expect(normalisePath('../outside.txt')).toBe('../outside.txt')
    expect(normaliseFiles(['./a', 'a', '.', 'b\\c', 'b/c'])).toEqual(['a', 'b/c'])
  })

  it('reads a summary back into its checks, details with colons included', () => {
    const checks = [
      { name: 'commit exists', ok: true, detail: 'abc' },
      { name: 'files changed', ok: false, detail: 'changed but not reported: a: b; c' },
      { name: 'empty', ok: true, detail: '' },
    ]
    expect(parseSummary(summarise(checks))).toEqual(checks)
  })

  it('states its coverage within the claim contract, including what it does not check', () => {
    expect(VERIFIER).toEqual({ tool: 'kalyth-git-verifier', toolVersion: '0.2.0' })
    expect(VERIFIER_COVERAGE.length).toBeLessThanOrEqual(2000)
    for (const phrase of [
      'a branch or tag',
      'net difference between the base tree and the commit tree',
      'tests (reported by the agent, never run)',
      'whether the files changed are within the scope of the task',
    ]) {
      expect(VERIFIER_COVERAGE).toContain(phrase)
    }
  })
})
