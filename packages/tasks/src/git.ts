import { execFileSync } from 'node:child_process'

/** A full commit sha. Anything Kalyth passes to git as a revision is checked against this first. */
export const SHA = /^[0-9a-f]{40}$/

const sha = (value: string): string => {
  if (!SHA.test(value)) throw new Error('expected a 40-hex commit sha')
  return value
}

/**
 * Read-only access to the task repository (ADR 0013), under the analyzer's plumbing rules
 * (threat model, section 2): only commands that read objects and refs, no checkout, hooks,
 * filters or pager, `core.fsmonitor` off, no prompts and no optional locks. Every revision from
 * outside is validated as a sha, or passed after `--end-of-options`, so it is never read as an
 * option. Nothing in the repository is run.
 */
export class TaskGit {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  #git(args: readonly string[]): Buffer {
    return execFileSync('git', ['-C', this.path, '-c', 'core.fsmonitor=false', ...args], {
      maxBuffer: 1 << 28,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  #lines(args: readonly string[], separator = '\n'): string[] {
    return this.#git(args)
      .toString('utf8')
      .split(separator)
      .filter((l) => l.length > 0)
  }

  /** Resolves a ref, tag or sha to a full commit sha; throws when there is no such commit. */
  resolveCommit(ref: string): string {
    return this.#git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
      .toString('utf8')
      .trim()
  }

  /** The commit when it exists, otherwise null. */
  findCommit(commit: string): string | null {
    try {
      return this.resolveCommit(sha(commit))
    } catch {
      return null
    }
  }

  /** The full message of a commit. */
  commitMessage(commit: string): string {
    const raw = this.#git(['cat-file', 'commit', sha(commit)]).toString('utf8')
    const blank = raw.indexOf('\n\n')
    return blank === -1 ? '' : raw.slice(blank + 2)
  }

  /** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
  isAncestor(ancestor: string, descendant: string): boolean {
    try {
      this.#git(['merge-base', '--is-ancestor', '--end-of-options', sha(ancestor), sha(descendant)])
      return true
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false
      throw error
    }
  }

  /** The best common ancestor of two commits, or null when their histories are unrelated. */
  mergeBase(a: string, b: string): string | null {
    try {
      const out = this.#git(['merge-base', '--end-of-options', sha(a), sha(b)])
        .toString('utf8')
        .trim()
      return SHA.test(out) ? out : null
    } catch (error) {
      if ((error as { status?: number }).status === 1) return null
      throw error
    }
  }

  /** Paths a commit changed against its first parent; every path for a root commit. */
  changedFiles(commit: string): string[] {
    const c = sha(commit)
    let parent: string | null
    try {
      parent = this.resolveCommit(`${c}^1`)
    } catch {
      parent = null
    }
    return parent
      ? this.filesBetween(parent, c)
      : this.#lines(
          [
            'diff-tree',
            '-r',
            '--name-only',
            '-z',
            '--no-renames',
            '--root',
            '--no-commit-id',
            '--end-of-options',
            c,
          ],
          '\0',
        )
  }

  /** Paths whose content differs between two commits' trees: the net change from `from` to `to`. */
  filesBetween(from: string, to: string): string[] {
    return this.#lines(
      [
        'diff-tree',
        '-r',
        '--name-only',
        '-z',
        '--no-renames',
        '--end-of-options',
        sha(from),
        sha(to),
      ],
      '\0',
    )
  }

  /**
   * Commits reachable from `to` and not from `from`, newest first, at most `limit`. The range the
   * work spans when `from` is the task base.
   */
  commitsBetween(from: string, to: string, limit: number): string[] {
    return this.#lines([
      'rev-list',
      `--max-count=${Math.max(1, Math.floor(limit))}`,
      '--end-of-options',
      sha(to),
      `^${sha(from)}`,
    ]).filter((l) => SHA.test(l))
  }

  /** Branches and tags (`refs/heads/`, `refs/tags/`) that contain the commit, at most `limit`. */
  refsContaining(commit: string, limit: number): string[] {
    return this.#lines([
      'for-each-ref',
      `--count=${Math.max(1, Math.floor(limit))}`,
      '--format=%(refname)',
      `--contains=${sha(commit)}`,
      'refs/heads/',
      'refs/tags/',
    ])
  }

  /** Commits on any ref whose message contains `text` (a fixed string), newest first. */
  commitsMentioning(text: string): string[] {
    return this.#lines(['rev-list', '--all', '--fixed-strings', `--grep=${text}`]).filter((l) =>
      SHA.test(l),
    )
  }
}
