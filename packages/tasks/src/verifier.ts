import type { VerificationCheck } from '@kalyth/contracts'
import { SHA, type TaskGit } from './git.ts'

export const VERIFIER = { tool: 'kalyth-git-verifier', toolVersion: '0.2.0' } as const

/**
 * What a verification by this version covers, stored with every verification it records (R4).
 * Each sentence must stay exactly true of `verifyReport`.
 */
export const VERIFIER_COVERAGE = [
  'Read-only git checks of the reported commit in the registered task repository:',
  'it exists; a branch or tag (refs/heads, refs/tags) contains it;',
  'and its own message has a line "Kalyth-Task: <task id>" for this task.',
  'When the task has a base commit, the commit must descend from it, the commits from the base to it are listed,',
  'and the files changed are the net difference between the base tree and the commit tree',
  '(from their merge base when it does not descend).',
  'Without a base, the files changed are those of the commit against its first parent.',
  'The reported files, with path separators and "./" normalised, must equal the files changed;',
  'a rename counts as a deletion and an addition.',
  'Not checked: tests (reported by the agent, never run); what the changes do or whether they are correct;',
  'trailers on the other commits in the range; who wrote the commits;',
  'whether the files changed are within the scope of the task; and whether the commit was pushed anywhere.',
].join(' ')

/** The reads the verifier makes: a {@link TaskGit} on the task repository. */
export type VerifierGit = Pick<
  TaskGit,
  | 'findCommit'
  | 'commitMessage'
  | 'isAncestor'
  | 'mergeBase'
  | 'changedFiles'
  | 'filesBetween'
  | 'commitsBetween'
  | 'refsContaining'
>

export interface Verdict {
  outcome: 'pass' | 'fail'
  checks: VerificationCheck[]
  /**
   * The commits the work spans, newest first: after the task base, up to and including the
   * reported commit (at most {@link MAX_RANGE}). Just the reported commit when the task has no base.
   */
  commits: string[]
}

/** Commits read from a range. A longer range is reported as "more than" this many. */
export const MAX_RANGE = 500
/** Paths and commits named in one check's detail; the rest are counted. */
const LISTED = 20
const MAX_PATH = 200
/** Six checks of this size stay within the 8000 characters a verification summary may hold. */
const MAX_DETAIL = 1200

/** The trailer an agent puts in its commit message to tie the commit to a task. */
export const taskTrailer = (taskId: string) => `Kalyth-Task: ${taskId}`

/**
 * A reported path as git writes it: forward slashes, no `./`, empty or `.` segments. `..` is kept,
 * so such a path never matches a file in the repository.
 */
export function normalisePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/')
}

/** Reported paths normalised, without duplicates or empty paths, in the order given. */
export const normaliseFiles = (paths: readonly string[]): string[] => [
  ...new Set(paths.map(normalisePath).filter((p) => p.length > 0)),
]

/** Control, line-breaking, zero-width and bidirectional-override characters, as code point ranges. */
const UNSAFE: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
]

/**
 * Text on one line, with unsafe characters shown as `\uXXXX`. Paths and ref names come from the
 * agent and the repository; this keeps them from adding lines to a summary or reordering what a
 * reader sees.
 */
export const oneLine = (text: string): string =>
  Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    return UNSAFE.some(([lo, hi]) => code >= lo && code <= hi)
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : ch
  }).join('')

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`
const shown = (path: string) => oneLine(clip(path, MAX_PATH))
const listed = (items: readonly string[]) =>
  items.length <= LISTED
    ? items.join(', ')
    : `${items.slice(0, LISTED).join(', ')} and ${items.length - LISTED} more`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const short = (sha: string) => sha.slice(0, 12)

const check = (name: string, ok: boolean, detail: string): VerificationCheck => ({
  name,
  ok,
  detail: clip(oneLine(detail), MAX_DETAIL),
})

/**
 * Checks an execution report against the task repository, read-only (ADR 0013, amended
 * 2026-10-19). The work is the range from the task base to the reported commit; every check must
 * hold for a pass. Nothing in the repository is run.
 */
export function verifyReport(
  git: VerifierGit,
  report: {
    taskId: string
    commit: string
    filesChanged: readonly string[]
    baseCommit?: string | null | undefined
  },
): Verdict {
  const checks: VerificationCheck[] = []
  const verdict = (commits: string[]): Verdict => ({
    outcome: checks.every((c) => c.ok) ? 'pass' : 'fail',
    checks,
    commits,
  })

  const resolved = SHA.test(report.commit) ? git.findCommit(report.commit) : null
  if (!resolved) {
    checks.push(
      check(
        'commit exists',
        false,
        SHA.test(report.commit)
          ? `${report.commit} is not in the task repository`
          : 'the reported commit is not a 40-hex sha',
      ),
    )
    return verdict([])
  }
  checks.push(check('commit exists', true, resolved))

  const refs = git.refsContaining(resolved, 3)
  checks.push(
    check(
      'on a branch or tag',
      refs.length > 0,
      refs.length > 0
        ? `reachable from ${refs.join(', ')}`
        : `${short(resolved)} is on no branch or tag in the task repository, so garbage collection may remove it; commit the work to a branch and report again`,
    ),
  )

  const message = git.commitMessage(resolved)
  const id = report.taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const trailer = new RegExp(`^Kalyth-Task:\\s*${id}\\s*$`, 'm').test(message)
  checks.push(
    check(
      'task trailer',
      trailer,
      trailer
        ? `the message carries "${taskTrailer(report.taskId)}"`
        : `the message lacks "${taskTrailer(report.taskId)}"`,
    ),
  )

  // The range the work spans: from the task base, or from its merge base with the commit when the
  // commit does not descend from it (the descent check then fails, but the files still compare).
  let from: string | null = null
  let since = ''
  let noRange = ''
  if (report.baseCommit) {
    const base = SHA.test(report.baseCommit) ? git.findCommit(report.baseCommit) : null
    if (!base) {
      noRange = `the task base ${short(report.baseCommit)} is not in the task repository`
      checks.push(check('descends from base', false, noRange))
    } else {
      const descends = git.isAncestor(base, resolved)
      from = descends ? base : git.mergeBase(base, resolved)
      since = descends ? `the task base ${short(base)}` : `the merge base ${short(from ?? '')}`
      if (!from) noRange = `the commit shares no history with the task base ${short(base)}`
      checks.push(
        check(
          'descends from base',
          descends,
          descends
            ? `descends from ${short(base)}`
            : `does not descend from the task base ${short(base)}${from ? `; the work is read from their merge base ${short(from)}` : ''}`,
        ),
      )
    }
  }

  let commits: string[] = []
  if (!report.baseCommit) {
    commits = [resolved]
    checks.push(
      check('commits in range', true, 'the task has no base commit: the reported commit only'),
    )
  } else if (from) {
    const read = git.commitsBetween(from, resolved, MAX_RANGE + 1)
    commits = read.slice(0, MAX_RANGE)
    const count =
      read.length > MAX_RANGE ? `more than ${MAX_RANGE} commits` : plural(commits.length, 'commit')
    checks.push(
      check(
        'commits in range',
        commits.length > 0,
        commits.length === 0
          ? `no commits after ${since}: the reported commit is not new work`
          : `${count} after ${since}, newest first: ${listed(commits)}`,
      ),
    )
  } else {
    checks.push(check('commits in range', false, `no range: ${noRange}`))
  }

  const actual = !report.baseCommit
    ? git.changedFiles(resolved)
    : from
      ? git.filesBetween(from, resolved)
      : null
  if (actual === null) {
    checks.push(check('files changed', false, `cannot be compared: ${noRange}`))
  } else {
    const where = report.baseCommit
      ? `from ${since} to the reported commit`
      : 'in the reported commit, against its first parent'
    const changed = new Set(actual)
    const claimed = new Set(normaliseFiles(report.filesChanged))
    const unreported = [...changed].filter((p) => !claimed.has(p)).sort()
    const untouched = [...claimed].filter((p) => !changed.has(p)).sort()
    const ok = unreported.length === 0 && untouched.length === 0 && changed.size > 0
    checks.push(
      check(
        'files changed',
        ok,
        ok
          ? `${plural(changed.size, 'file')} changed ${where}, as reported`
          : [
              changed.size === 0 ? `no files changed ${where}` : '',
              unreported.length > 0
                ? `changed but not reported: ${listed(unreported.map(shown))}`
                : '',
              untouched.length > 0
                ? `reported but not changed: ${listed(untouched.map(shown))}`
                : '',
            ]
              .filter(Boolean)
              .join('; '),
      ),
    )
  }
  return verdict(commits)
}

/** One line per check, as stored in the verification's summary. */
export function summarise(checks: readonly VerificationCheck[]): string {
  return checks.map((c) => `${c.ok ? 'ok' : 'FAILED'}: ${c.name}: ${oneLine(c.detail)}`).join('\n')
}

/**
 * The checks a stored summary records: the inverse of {@link summarise}, so a retried report is
 * answered with its original verdict. Check names never contain a colon, and details are one line.
 */
export function parseSummary(summary: string): VerificationCheck[] {
  return summary.split('\n').flatMap((line) => {
    const m = /^(ok|FAILED): ([^:\n]+): (.*)$/.exec(line)
    return m ? [{ name: m[2] ?? '', ok: m[1] === 'ok', detail: m[3] ?? '' }] : []
  })
}
