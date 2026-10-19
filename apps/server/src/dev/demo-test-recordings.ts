import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KalythServices, SqliteStore } from '@kalyth/core'
import {
  BudgetLedger,
  type ChatRequest,
  type ChatResponse,
  DEFAULT_ROLE_MODELS,
  MockProvider,
  type Provider,
  ProviderGateway,
  RecordingProvider,
} from '@kalyth/gateway'
import { Navigator, navigatorMockResponder } from '@kalyth/navigator'
import { buildTemplate } from '../demo/template.ts'

// FOR TESTS ONLY. Writes recordings of two demo presets into the directory given, with the mock
// responder standing in for Nebius, so the hosted demo's browser tests have recorded runs without
// spending anything. The answers are mock output and must never be deployed; the real recordings
// come from `pnpm demo:record` (ADR 0019).
//
//   node apps/server/src/dev/demo-test-recordings.ts <directory>

const out = process.argv[2]
if (!out) {
  process.stderr.write('usage: node apps/server/src/dev/demo-test-recordings.ts <directory>\n')
  process.exit(2)
}
const dir = resolve(out)
mkdirSync(dir, { recursive: true })

class MockAsNebius implements Provider {
  readonly id = 'nebius'
  readonly external = true
  readonly paid = true
  readonly #mock = new MockProvider(navigatorMockResponder)
  complete(request: ChatRequest): Promise<ChatResponse> {
    return this.#mock.complete(request)
  }
}

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'kalyth-test-recordings-'))
const template = buildTemplate({
  exportFile: join(repo, 'deploy/demo/template.json'),
  dir: work,
})
const ledger = new BudgetLedger(':memory:')
ledger.setCap(100_000_000, 'test recordings')
ledger.setConsent(template.projectId, 'nebius', true, 'test')
const gateway = new ProviderGateway({
  provider: new RecordingProvider(new MockAsNebius(), dir),
  ledger,
  roleModels: DEFAULT_ROLE_MODELS.nebius ?? {},
})
const recorded: { id: string }[] = []
for (const id of ['multi-tenancy', 'summary-backend']) {
  const preset = template.presets.find((p) => p.id === id)
  if (!preset) throw new Error(`no preset ${id}`)
  const file = join(work, `${id}.db`)
  copyFileSync(template.file, file)
  const store = new SqliteStore(file)
  const navigator = new Navigator({ services: new KalythServices({ store }), gateway })
  const started = navigator.start({ principalId: template.ownerId, origin: 'human' }, preset.input)
  if (!started.ok) throw new Error(started.error.message)
  const run = await started.value.done
  store.close()
  if (run.status !== 'completed') throw new Error(`${id}: ${run.error?.message}`)
  recorded.push({ id })
}
writeFileSync(join(dir, 'presets.json'), `${JSON.stringify(recorded, null, 2)}\n`)
rmSync(work, { recursive: true, force: true })
process.stdout.write(`test recordings for ${recorded.map((r) => r.id).join(', ')} in ${dir}\n`)
