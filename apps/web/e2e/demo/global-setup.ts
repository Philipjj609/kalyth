import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
export const JUDGE_CODE = 'e2e-judge-code-0123456789'

/**
 * Starts the hosted demo (ADR 0019) as an anonymous visitor would meet it: no token, a judge code,
 * and test recordings of two presets made with the mock responder. There is no Nebius key, so live
 * runs are off and nothing can spend. Everything lives in a temporary folder.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    throw new Error('the browser tests need the built UI: run `pnpm build` first')
  }
  const dir = mkdtempSync(join(tmpdir(), 'kalyth-e2e-demo-'))
  const recordings = join(dir, 'recordings')
  execFileSync(
    process.execPath,
    [join(root, 'apps/server/src/dev/demo-test-recordings.ts'), recordings],
    {
      stdio: 'pipe',
    },
  )
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KALYTH_PORT: String(port),
    KALYTH_DEMO_HOST: `127.0.0.1:${port}`,
    KALYTH_DEMO_DATA: join(dir, 'data'),
    KALYTH_DEMO_WORK: join(dir, 'work'),
    KALYTH_DEMO_RECORDINGS: recordings,
    KALYTH_DEMO_JUDGE_CODE: JUDGE_CODE,
  }
  for (const key of Object.keys(env)) {
    if (/API_KEY|NEBIUS_CONSENT/.test(key)) delete env[key]
  }
  const server = spawn(process.execPath, [join(root, 'apps/server/src/demo/main.ts')], {
    cwd: dir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await started(server)
  process.env.KALYTH_E2E_DEMO_URL = `http://127.0.0.1:${port}/`
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

function started(server: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    let output = ''
    const timer = setTimeout(() => fail(new Error(`the demo did not start:\n${output}`)), 30_000)
    server.stderr?.setEncoding('utf8')
    server.stderr?.on('data', (chunk: string) => {
      output += chunk
      if (output.includes('kalyth demo: http')) {
        clearTimeout(timer)
        done()
      }
    })
    server.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the demo exited with code ${code}:\n${output}`))
    })
  })
}
