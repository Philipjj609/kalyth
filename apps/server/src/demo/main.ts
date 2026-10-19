import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BudgetLedger,
  DEFAULT_ROLE_MODELS,
  BudgetLedger as Ledger,
  NebiusProvider,
  ProviderGateway,
  RecordedFirstProvider,
} from '@kalyth/gateway'
import { DemoAllowance } from './allowance.ts'
import { buildDemoApp } from './app.ts'
import { buildTemplate, recordedPresetIds } from './template.ts'

// The hosted demo server (ADR 0019): `pnpm demo:serve`. It never reads a .env file; everything comes
// from the environment the platform sets. Nothing here is secret except the Nebius key and the
// judge code, which are never printed.
//
//   KALYTH_DEMO_HOST              public host name, checked against Host and Origin
//   KALYTH_PORT                   port to listen on (default 8080)
//   KALYTH_DEMO_DATA              persistent directory for the pool ledgers (default /data)
//   KALYTH_DEMO_WORK              ephemeral directory for the template and sandboxes
//   KALYTH_NEBIUS_API_KEY         the demo's own Nebius key; without it, recorded runs only
//   KALYTH_DEMO_NEBIUS_CONSENT    the template project's id, set by the operator to consent
//   KALYTH_DEMO_JUDGE_CODE        at least 16 characters; unlocks the judges' pool
//   KALYTH_DEMO_CLIENT_IP_HEADER  e.g. fly-client-ip, only behind a proxy that sets it

const env = process.env
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const port = Number(env.KALYTH_PORT ?? 8080)
const host = env.KALYTH_DEMO_HOST ?? `127.0.0.1:${port}`
const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
const secure = env.KALYTH_DEMO_SECURE ? env.KALYTH_DEMO_SECURE === '1' : !loopback
const data = resolve(env.KALYTH_DEMO_DATA ?? '/data')
const work = resolve(env.KALYTH_DEMO_WORK ?? join(tmpdir(), 'kalyth-demo'))
const recordingsDir = resolve(env.KALYTH_DEMO_RECORDINGS ?? join(repo, 'deploy/demo/recordings'))
const judgeCode = env.KALYTH_DEMO_JUDGE_CODE?.trim() || undefined
if (judgeCode !== undefined && judgeCode.length < 16) {
  process.stderr.write('kalyth demo: KALYTH_DEMO_JUDGE_CODE needs at least 16 characters\n')
  process.exit(2)
}
mkdirSync(work, { recursive: true })

const template = buildTemplate({
  exportFile: resolve(env.KALYTH_DEMO_TEMPLATE ?? join(repo, 'deploy/demo/template.json')),
  dir: work,
  recordedPresets: recordedPresetIds(recordingsDir),
})
const recordings = RecordedFirstProvider.readRecordings(recordingsDir)
const apiKey = env.KALYTH_NEBIUS_API_KEY
const live = apiKey ? new NebiusProvider({ apiKey }) : null

const ledgers: Record<'public' | 'judges', BudgetLedger> = {
  public: new Ledger(join(data, 'ledger-public.sqlite')),
  judges: new Ledger(join(data, 'ledger-judges.sqlite')),
}
// Consent is the operator's act: KALYTH_DEMO_NEBIUS_CONSENT must name the template project.
const consented = live !== null && env.KALYTH_DEMO_NEBIUS_CONSENT === template.projectId
if (consented) {
  for (const ledger of Object.values(ledgers)) {
    if (!ledger.consent(template.projectId, 'nebius').granted) {
      ledger.setConsent(template.projectId, 'nebius', true, 'demo operator')
    }
  }
}
const roleModels = DEFAULT_ROLE_MODELS.nebius ?? {}
const gateway = (ledger: BudgetLedger, withLive: boolean) =>
  new ProviderGateway({
    provider: new RecordedFirstProvider('nebius', recordings, withLive ? live : null),
    ledger,
    roleModels,
  })
const allowance = new DemoAllowance({ ledgers })
allowance.refresh()

const ipHeader = env.KALYTH_DEMO_CLIENT_IP_HEADER?.toLowerCase()
const app = buildDemoApp({
  host,
  secure,
  template,
  sandboxDir: join(work, 'sandboxes'),
  gateways: {
    public: gateway(ledgers.public, true),
    judges: gateway(ledgers.judges, true),
    recorded: gateway(new Ledger(':memory:'), false),
  },
  allowance,
  live: live !== null && consented,
  judgeCode,
  webRoot: resolve(env.KALYTH_WEB_DIST ?? join(repo, 'apps/web/dist')),
  ...(ipHeader
    ? {
        clientIp: (req) =>
          String(req.headers[ipHeader] ?? req.ip)
            .split(',')[0]
            ?.trim() ?? '',
      }
    : {}),
  grounding: { pythonStringDelimiters: env.KALYTH_GROUNDING_PYTHON_STRINGS === '1' },
})

await app.listen({ host: env.KALYTH_DEMO_LISTEN ?? (loopback ? '127.0.0.1' : '0.0.0.0'), port })
process.stderr.write(
  [
    `kalyth demo: ${secure ? 'https' : 'http'}://${host}/ (listening on port ${port})`,
    `  template ${template.projectId}, ${template.presets.filter((p) => p.recorded).length} of ${template.presets.length} presets recorded, ${recordings.length} recorded calls`,
    `  live runs ${live === null ? 'off (no key)' : consented ? 'on' : 'off (no consent)'}; judge code ${judgeCode ? 'set' : 'not set'}; Python string fallback ${env.KALYTH_GROUNDING_PYTHON_STRINGS === '1' ? 'on' : 'off'}`,
    `  today: public ${allowance.remainingToday('public')} and judges ${allowance.remainingToday('judges')} micro-USD`,
    '',
  ].join('\n'),
)

const stop = async () => {
  await app.close()
  for (const ledger of Object.values(ledgers)) ledger.close()
  process.exit(0)
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
