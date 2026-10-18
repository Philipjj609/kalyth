import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { importProjectExport } from '@kalyth/core'
import { openLocalServices } from '../runtime.ts'

// Rebuilds a project from a `pnpm project:export` file (ADR 0014) in the store KALYTH_DB picks. The events
// are replayed and the import is refused unless they reproduce the exported state. A bundle is not
// signed and replay skips the checks proposals get, so import only files you trust.
//
//   pnpm project:import kalyth-project.json

const { positionals } = parseArgs({ allowPositionals: true })
const file = positionals[0]
if (!file || positionals.length > 1) {
  process.stderr.write('usage: pnpm project:import <export file>\n')
  process.exit(2)
}
let bundle: unknown
try {
  bundle = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`)
  process.exit(2)
}
const services = openLocalServices()
const result = importProjectExport(services.store, bundle)
if (!result.ok) {
  process.stderr.write(`import refused: ${result.error.code}: ${result.error.message}\n`)
  for (const issue of result.error.issues)
    process.stderr.write(`  ${issue.code}: ${issue.message}\n`)
  process.exit(1)
}
const s = result.value
process.stdout.write(
  `imported ${s.name} (${s.projectId}) at r${s.headRevision}: ${s.events} events, ${s.content} content bodies, ` +
    `${s.principalsAdded} principals added without grants; state ${s.stateSha256.slice(0, 12)} reproduced\n`,
)
