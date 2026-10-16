import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { GitRepository, ingestRepository } from '@kalyth/analyzer'
import { ensureLocalOwner, ensurePrincipal } from '@kalyth/core'
import { openLocalServices } from '../runtime.ts'

// Usage: node apps/server/src/cli/ingest.ts --repo <https-url | local path> --ref <tag|branch|sha> [--project <name>] [--id <repo id>]
const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    ref: { type: 'string', default: 'HEAD' },
    project: { type: 'string' },
    id: { type: 'string' },
  },
})
if (!values.repo) {
  process.stderr.write(
    'usage: ingest --repo <https-url|path> --ref <ref> [--project <name>] [--id <repo id>]\n',
  )
  process.exit(2)
}

const services = openLocalServices()
const dataDir = dirname(
  resolve(process.env.KALYTH_DB ?? join(process.cwd(), '.kalyth', 'kalyth.db')),
)

/**
 * Remote repositories are cloned bare over HTTPS only. Other git transports (ext::, file://, ssh
 * with custom commands) are refused because some of them can execute commands.
 */
function localClone(repo: string): { path: string; id: string } {
  if (!/^https:\/\//.test(repo)) {
    if (!existsSync(repo)) throw new Error(`not an https URL or an existing path: ${repo}`)
    return { path: resolve(repo), id: values.id ?? basename(resolve(repo)) }
  }
  const url = new URL(repo)
  const id = values.id ?? `${url.host}${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`
  const path = join(dataDir, 'repos', `${id.replace(/[^\w.-]+/g, '__')}.git`)
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
  return { path, id }
}

const { path, id } = localClone(values.repo)
const owner = ensureLocalOwner(services)
const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
  'project.read',
  'proposal.create',
  'ingest.observed',
])
const ownerCaller = { principalId: owner.id, origin: 'human' as const }
const projectName = values.project ?? id
const projects = services.listProjects(ownerCaller)
let projectId = projects.ok
  ? projects.value.projects.find((p) => p.name === projectName)?.id
  : undefined
if (!projectId) {
  const created = services.createProject(ownerCaller, {
    name: projectName,
    description: `Analysis of ${id}`,
  })
  if (!created.ok) throw new Error(created.error.message)
  projectId = created.value.id
}

const report = await ingestRepository({
  services,
  caller: { principalId: analyzer.id, origin: 'tool' },
  projectId,
  git: new GitRepository(path),
  repo: id,
  ref: values.ref ?? 'HEAD',
})
process.stdout.write(`${JSON.stringify({ projectId, ...report }, null, 2)}\n`)
