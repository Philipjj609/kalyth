import { execFileSync } from 'node:child_process'

export interface TreeEntry {
  path: string
  mode: string
  type: string
  sha: string
  size: number
}

/**
 * Read-only access to a git repository (bare or not). Only plumbing commands that read objects are
 * used: no checkout, no hooks, no filters, and nothing from the repository is ever executed.
 */
export class GitRepository {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  #git(args: readonly string[], input?: string): Buffer {
    return execFileSync('git', ['-C', this.path, '-c', 'core.fsmonitor=false', ...args], {
      input,
      maxBuffer: 1 << 30,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  /** Resolves a ref, tag or sha to a full commit sha. */
  resolveCommit(ref: string): string {
    const out = this.#git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    return out.toString('utf8').trim()
  }

  /** All entries of the commit's tree, recursively. */
  listTree(commit: string): TreeEntry[] {
    const out = this.#git(['ls-tree', '-r', '-z', '--long', '--full-tree', commit]).toString('utf8')
    const entries: TreeEntry[] = []
    for (const record of out.split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      const [mode = '', type = '', sha = '', size = '-'] = record.slice(0, tab).split(/\s+/)
      entries.push({
        mode,
        type,
        sha,
        size: size === '-' ? 0 : Number(size),
        path: record.slice(tab + 1),
      })
    }
    return entries
  }

  /** The full message of a commit. */
  commitMessage(commit: string): string {
    const raw = this.#git(['cat-file', 'commit', commit]).toString('utf8')
    const blank = raw.indexOf('\n\n')
    return blank === -1 ? '' : raw.slice(blank + 2)
  }

  /** Paths a commit changed against its first parent; every path for a root commit. */
  changedFiles(commit: string): string[] {
    let parent: string | undefined
    try {
      parent = this.#git(['rev-parse', '--verify', '--end-of-options', `${commit}^1`])
        .toString('utf8')
        .trim()
    } catch {
      parent = undefined
    }
    const args = parent
      ? ['diff-tree', '-r', '--name-only', '-z', '--no-renames', parent, commit]
      : ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--root', '--no-commit-id', commit]
    return this.#git(args)
      .toString('utf8')
      .split('\0')
      .filter((p) => p.length > 0)
  }

  /** Whether `ancestor` is reachable from `descendant`. */
  isAncestor(ancestor: string, descendant: string): boolean {
    try {
      this.#git(['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant])
      return true
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false
      throw error
    }
  }

  /** Commits on any ref whose message contains `text` (a fixed string), newest first. */
  commitsMentioning(text: string): string[] {
    return this.#git(['log', '--all', '--format=%H', '--fixed-strings', `--grep=${text}`])
      .toString('utf8')
      .split('\n')
      .filter((l) => /^[0-9a-f]{40}$/.test(l))
  }

  /** Reads blobs by sha in one `cat-file --batch` call. */
  readBlobs(shas: readonly string[]): Map<string, Buffer> {
    const unique = [...new Set(shas)]
    const result = new Map<string, Buffer>()
    if (unique.length === 0) return result
    const out = this.#git(['cat-file', '--batch'], `${unique.join('\n')}\n`)
    let offset = 0
    while (offset < out.length) {
      const newline = out.indexOf(0x0a, offset)
      const header = out.subarray(offset, newline).toString('utf8')
      const [sha = '', type = '', size = '0'] = header.split(' ')
      offset = newline + 1
      if (type === 'missing') continue
      const length = Number(size)
      result.set(sha, out.subarray(offset, offset + length))
      offset += length + 1
    }
    return result
  }
}
