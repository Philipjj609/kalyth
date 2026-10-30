import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')

/**
 * Seeds the K3 multi-game example (the real-time networking seed library and a game platform
 * project using it) into a throwaway database, then starts the real server with the mock
 * provider. As in the main suite, the server never reads the repository's `.env`, and provider
 * keys are removed from its environment.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    throw new Error('the browser tests need the built UI: run `pnpm build` first')
  }
  const dir = mkdtempSync(join(tmpdir(), 'kalyth-e2e-knowledge-'))
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KALYTH_DB: join(dir, 'kalyth.db'),
    KALYTH_LEDGER: join(dir, 'ledger.sqlite'),
    KALYTH_PROVIDER: 'mock',
    KALYTH_PORT: String(port),
  }
  for (const key of Object.keys(env)) {
    if (/API_KEY|RECORD_DIR|REPLAY/.test(key)) delete env[key]
  }
  const ids = JSON.parse(
    execFileSync(process.execPath, [join(root, 'apps/server/src/dev/knowledge-example-main.ts')], {
      cwd: dir,
      env,
      encoding: 'utf8',
    }),
  ) as { library: string; project: string }
  const server = spawn(process.execPath, [join(root, 'apps/server/src/http/main.ts')], {
    cwd: dir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  process.env.KALYTH_E2E_URL = await uiUrl(server)
  process.env.KALYTH_E2E_PROJECT = ids.project
  process.env.KALYTH_E2E_LIBRARY = ids.library
  return async () => {
    if (server.exitCode === null) {
      server.kill()
      await once(server, 'exit')
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

function uiUrl(server: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    let output = ''
    const timer = setTimeout(() => fail(new Error('the server did not start within 20 s')), 20_000)
    server.stderr?.setEncoding('utf8')
    server.stderr?.on('data', (chunk: string) => {
      output += chunk
      const match = /kalyth ui: +(http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+)/.exec(output)
      if (match?.[1]) {
        clearTimeout(timer)
        done(match[1])
      }
    })
    server.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the server exited with code ${code} before printing the UI link`))
    })
  })
}
