import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { GitRepository, ingestRepository } from '@kalyth/analyzer'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import { cloneOrFetch } from '../cli/clone.ts'

// Builds the demo database from scratch (docs/demo/walkthrough.md): the pinned FastAPI template
// analysed at tag 0.12.0. Everything after that happens live in the walkthrough. It writes only
// its own database, .kalyth/demo.db unless KALYTH_DB says otherwise, and refuses to replace an
// existing one without --force.
//
//   pnpm demo:setup [--force]

export const DEMO_REPO = 'https://github.com/fastapi/full-stack-fastapi-template'
export const DEMO_START = '0.12.0'
export const DEMO_PINNED = 'b1125d8839482cb7bbae603ddc6d0081bf87532e'
export const DEMO_PROJECT = 'FastAPI full-stack template'

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } })
const dbPath = resolve(process.env.KALYTH_DB ?? join('.kalyth', 'demo.db'))
if (existsSync(dbPath)) {
  if (!values.force) {
    process.stderr.write(`demo: ${dbPath} exists; pass --force to rebuild it from scratch\n`)
    process.exit(2)
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
}

const { path, id } = cloneOrFetch(DEMO_REPO, dirname(dbPath))
const git = new GitRepository(path)
if (git.resolveCommit(DEMO_PINNED) !== DEMO_PINNED) {
  throw new Error(`the clone does not contain the pinned commit ${DEMO_PINNED}`)
}

const services = new KalythServices({ store: new SqliteStore(dbPath) })
const owner = ensureLocalOwner(services)
const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
  'project.read',
  'proposal.create',
  'ingest.observed',
])
const created = services.createProject(
  { principalId: owner.id, origin: 'human' },
  { name: DEMO_PROJECT, description: `Analysis of ${id}` },
)
if (!created.ok) throw new Error(created.error.message)
const report = await ingestRepository({
  services,
  caller: { principalId: analyzer.id, origin: 'tool' },
  projectId: created.value.id,
  git,
  repo: id,
  ref: DEMO_START,
})
services.store.close()

const s = report.stats
process.stderr.write(
  [
    `demo: ${DEMO_PROJECT} analysed at ${DEMO_START} (${report.commit.slice(0, 8)}), revision ${report.revision}`,
    `      ${JSON.stringify(s)}`,
    `      database: ${dbPath}`,
    '',
    'next:',
    `  KALYTH_DB=${dbPath} pnpm dev:server`,
    '  then follow docs/demo/walkthrough.md',
    '',
  ].join('\n'),
)
