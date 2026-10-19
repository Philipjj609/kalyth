import type { GitRepository } from '@kalyth/analyzer'
import type { VerificationCheck } from '@kalyth/contracts'

export const VERIFIER = { tool: 'kalyth-git-verifier', toolVersion: '0.1.0' } as const

export const VERIFIER_COVERAGE =
  'Commit existence, the Kalyth-Task trailer in its message, the files it changed against its first parent compared with the files reported, and descent from the task base commit when one is set. Tests are reported by the agent and not run.'

export interface Verdict {
  outcome: 'pass' | 'fail'
  checks: VerificationCheck[]
}

/** The trailer an agent puts in its commit message to tie the commit to a task. */
export const taskTrailer = (taskId: string) => `Kalyth-Task: ${taskId}`

/**
 * Checks an execution report against the repository, read-only (ADR 0013). Every check must hold
 * for a pass. Nothing in the repository is run.
 */
export function verifyReport(
  git: GitRepository,
  report: {
    taskId: string
    commit: string
    filesChanged: readonly string[]
    baseCommit?: string | undefined
  },
): Verdict {
  const checks: VerificationCheck[] = []
  let resolved: string
  try {
    resolved = git.resolveCommit(report.commit)
  } catch {
    return {
      outcome: 'fail',
      checks: [
        {
          name: 'commit exists',
          ok: false,
          detail: `${report.commit} is not in the task repository`,
        },
      ],
    }
  }
  checks.push({ name: 'commit exists', ok: true, detail: resolved })

  const message = git.commitMessage(resolved)
  const id = report.taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const trailer = new RegExp(`^Kalyth-Task:\\s*${id}\\s*$`, 'm').test(message)
  checks.push({
    name: 'task trailer',
    ok: trailer,
    detail: trailer
      ? `the message carries "${taskTrailer(report.taskId)}"`
      : `the message lacks "${taskTrailer(report.taskId)}"`,
  })

  const actual = new Set(git.changedFiles(resolved))
  const claimed = new Set(
    report.filesChanged.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')),
  )
  const unreported = [...actual].filter((p) => !claimed.has(p)).sort()
  const untouched = [...claimed].filter((p) => !actual.has(p)).sort()
  const filesOk = unreported.length === 0 && untouched.length === 0 && actual.size > 0
  checks.push({
    name: 'files changed',
    ok: filesOk,
    detail: filesOk
      ? `${actual.size} file(s) changed, as reported`
      : [
          actual.size === 0 ? 'the commit changes no files' : '',
          unreported.length > 0
            ? `changed but not reported: ${unreported.slice(0, 20).join(', ')}`
            : '',
          untouched.length > 0
            ? `reported but not changed: ${untouched.slice(0, 20).join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('; '),
  })

  if (report.baseCommit) {
    let descends = false
    try {
      descends = git.isAncestor(report.baseCommit, resolved)
    } catch {
      descends = false
    }
    checks.push({
      name: 'descends from base',
      ok: descends,
      detail: descends
        ? `descends from ${report.baseCommit.slice(0, 8)}`
        : `does not descend from the task base ${report.baseCommit.slice(0, 8)}`,
    })
  }
  return { outcome: checks.every((c) => c.ok) ? 'pass' : 'fail', checks }
}

export function summarise(checks: readonly VerificationCheck[]): string {
  return checks.map((c) => `${c.ok ? 'ok' : 'FAILED'}: ${c.name}: ${c.detail}`).join('\n')
}
