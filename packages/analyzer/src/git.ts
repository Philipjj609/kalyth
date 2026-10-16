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
