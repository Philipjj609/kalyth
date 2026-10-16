import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLocalOwner } from '@kalyth/core'
import { loadLocalEnv, openLocalServices, openNavigator } from '../runtime.ts'
import { buildHttpApp } from './app.ts'
import { registerWebUi } from './static.ts'

// Local HTTP API and workbench UI. Binds to loopback only; the session token changes on every
// launch. The UI receives it in the URL fragment, which browsers never send to the server.
const port = Number(process.env.KALYTH_PORT ?? 4317)
const webRoot = resolve(
  process.env.KALYTH_WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url)),
)
loadLocalEnv()
const services = openLocalServices()
const owner = ensureLocalOwner(services)
const { navigator, gateway } = openNavigator(services)
const token = randomBytes(24).toString('base64url')
const app = buildHttpApp(
  services,
  { token, principalId: owner.id, allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`] },
  { navigator },
)
registerWebUi(app, { root: webRoot })
await app.listen({ host: '127.0.0.1', port })
process.stderr.write(`kalyth api: http://127.0.0.1:${port}/api/v1\n`)
const budget = gateway.ledger.status()
const usd = (micro: number) => (micro / 1e6).toFixed(4)
process.stderr.write(
  `kalyth navigator: provider ${gateway.provider.id}${gateway.provider.paid ? ' (paid)' : ''}, ` +
    `cap ${usd(budget.capMicroUsd)} USD, remaining ${usd(budget.remainingMicroUsd)} USD\n`,
)
if (existsSync(join(webRoot, 'index.html'))) {
  process.stderr.write(`kalyth ui:  http://127.0.0.1:${port}/#token=${token}\n`)
} else {
  process.stderr.write(
    `kalyth ui:  not built (run \`pnpm build\`); session token: ${token}\n` +
      `            dev UI: http://127.0.0.1:5173/#token=${token} (pnpm dev:web)\n`,
  )
}
