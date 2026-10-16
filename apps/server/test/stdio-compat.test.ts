import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const entry = resolve(import.meta.dirname, '../src/mcp/stdio.ts')
const dir = mkdtempSync(join(tmpdir(), 'kalyth-stdio-'))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/** Sends raw JSON-RPC lines to the stdio server and collects responses by id. */
async function exchange(messages: object[], expectIds: number[]): Promise<Map<number, any>> {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, KALYTH_DB: join(dir, 'compat.db') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const responses = new Map<number, any>()
  let buffer = ''
  const done = new Promise<void>((resolveDone, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout; got ${[...responses.keys()]}`)),
      15000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          const message = JSON.parse(line)
          if (typeof message.id === 'number') responses.set(message.id, message)
        }
        newline = buffer.indexOf('\n')
      }
      if (expectIds.every((id) => responses.has(id))) {
        clearTimeout(timer)
        resolveDone()
      }
    })
    child.on('error', reject)
  })
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`)
  const exited = new Promise((r) => child.once('exit', r))
  try {
    await done
  } finally {
    child.kill()
    await exited
  }
  return responses
}

/**
 * Regression guard for the clients we verified on 2026-10-16: Codex 0.153 speaks 2025-06-18 and
 * Claude Code 2.1.263 speaks 2025-11-25, both through the classic initialize handshake.
 */
describe('stdio MCP protocol compatibility', () => {
  for (const version of ['2025-06-18', '2025-11-25']) {
    it(`serves an initialize handshake at ${version} and lists tools`, async () => {
      const responses = await exchange(
        [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: version,
              capabilities: {},
              clientInfo: { name: 'compat-test', version: '0' },
            },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'list_projects', arguments: {} },
          },
        ],
        [1, 2, 3],
      )
      expect(responses.get(1).result).toMatchObject({
        protocolVersion: version,
        serverInfo: { name: 'kalyth' },
      })
      expect(responses.get(2).result.tools.map((t: { name: string }) => t.name)).toContain(
        'propose_change',
      )
      expect(responses.get(3).result.structuredContent).toEqual({ projects: [] })
    }, 30000)
  }
})
