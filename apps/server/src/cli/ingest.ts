import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { GitRepository, ingestRepository } from '@kalyth/analyzer'
import { ensureLocalOwner, ensurePrincipal } from '@kalyth/core'
import { openLocalServices } from '../runtime.ts'
import { cloneOrFetch } from './clone.ts'

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

const { path, id } = cloneOrFetch(values.repo, dataDir, values.id)
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
