import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')

/**
 * Seeds the sample project into a throwaway database and starts the real server on a free port,
 * with the mock provider and a throwaway ledger. The server runs in the temporary folder, so it
 * never reads the repository's `.env`, and provider keys are removed from its environment: no test
 * can reach a paid provider. The UI link (with its session token) and the project id reach the
 * tests through the environment of this process only.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    throw new Error('the browser tests need the built UI: run `pnpm build` first')
  }
  const dir = mkdtempSync(join(tmpdir(), 'kalyth-e2e-'))
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
  execFileSync(process.execPath, [join(root, 'apps/server/src/dev/seed.ts')], {
    cwd: dir,
    env,
    stdio: 'pipe',
  })
  const server = spawn(process.execPath, [join(root, 'apps/server/src/http/main.ts')], {
    cwd: dir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const url = await uiUrl(server)
  process.env.KALYTH_E2E_URL = url
  process.env.KALYTH_E2E_PROJECT = await sampleProject(url)
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

/** Waits for the line the server prints with the UI link. */
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

async function sampleProject(url: string): Promise<string> {
  const { origin, hash } = new URL(url)
  const token = hash.replace(/^#token=/, '')
  const res = await fetch(`${origin}/api/v1/projects`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as { projects: { id: string; name: string }[] }
  const sample = body.projects.find((p) => p.name === 'Sample: fullstack app')
  if (!sample) throw new Error('the sample project was not seeded')
  return sample.id
}
