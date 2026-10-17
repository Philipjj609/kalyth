import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * A local, read-only copy of a repository for analysis. Remote repositories are cloned bare over
 * HTTPS only; other git transports (ext::, file://, ssh with custom commands) are refused because
 * some of them can execute commands. Existing clones are fetched, tags included.
 */
export function cloneOrFetch(
  repo: string,
  dataDir: string,
  id?: string,
): { path: string; id: string } {
  if (!/^https:\/\//.test(repo)) {
    if (!existsSync(repo)) throw new Error(`not an https URL or an existing path: ${repo}`)
    return { path: resolve(repo), id: id ?? basename(resolve(repo)) }
  }
  const url = new URL(repo)
  const repoId = id ?? `${url.host}${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`
  const path = join(dataDir, 'repos', `${repoId.replace(/[^\w.-]+/g, '__')}.git`)
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    )
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    git('clone', '--bare', '--quiet', repo, path)
  } else {
    git('-C', path, 'fetch', '--quiet', '--tags', 'origin', '+refs/heads/*:refs/heads/*')
  }
  return { path, id: repoId }
}
