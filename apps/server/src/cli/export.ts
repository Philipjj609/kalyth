import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureLocalOwner } from '@kalyth/core'
import { openLocalServices } from '../runtime.ts'

// Writes a whole project to one file (ADR 0014): its events, the content its evidence refers to,
// the principals its history names and the hash of the state the events rebuild. KALYTH_DB picks
// the store. `pnpm project:import` reads the file back into another store.
//
//   pnpm project:export --project prj_... [--out kalyth-project.json]

const { values } = parseArgs({
  options: { project: { type: 'string' }, out: { type: 'string' } },
})
if (!values.project) {
  process.stderr.write('usage: pnpm project:export --project <project id> [--out <file>]\n')
  process.exit(2)
}
const services = openLocalServices()
const owner = ensureLocalOwner(services)
const result = services.exportProject(
  { principalId: owner.id, origin: 'human' },
  { projectId: values.project },
)
if (!result.ok) {
  process.stderr.write(`export refused: ${result.error.code}: ${result.error.message}\n`)
  process.exit(1)
}
const bundle = result.value
const out = resolve(
  values.out ?? `kalyth-${bundle.project.id}-r${bundle.project.headRevision}.json`,
)
// Written as stored, key order included, so the events are those of the store byte for byte.
writeFileSync(out, `${JSON.stringify(bundle)}\n`)
process.stdout.write(
  `exported ${bundle.project.name} at r${bundle.project.headRevision}: ${bundle.events.length} events, ` +
    `${bundle.content.length} content bodies, state ${bundle.stateSha256.slice(0, 12)}\n${out}\n`,
)
