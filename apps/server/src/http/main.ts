import { randomBytes } from 'node:crypto'
import { ensureLocalOwner } from '@kalyth/core'
import { openLocalServices } from '../runtime.ts'
import { buildHttpApp } from './app.ts'

// Local HTTP API. Binds to loopback only; the session token changes on every launch.
const port = Number(process.env.KALYTH_PORT ?? 4317)
const services = openLocalServices()
const owner = ensureLocalOwner(services)
const token = randomBytes(24).toString('base64url')
const app = buildHttpApp(services, {
  token,
  principalId: owner.id,
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
})
await app.listen({ host: '127.0.0.1', port })
process.stderr.write(`kalyth api: http://127.0.0.1:${port}/api/v1 (session token: ${token})\n`)
