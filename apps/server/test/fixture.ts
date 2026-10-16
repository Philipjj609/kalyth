import { ensureLocalAgent, ensureLocalOwner, KalythServices, SqliteStore } from '@kalyth/core'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { buildHttpApp } from '../src/http/app.ts'
import { createKalythMcpServer } from '../src/mcp/server.ts'

export const TOKEN = 'test-session-token-0123456789'
export const HOST = '127.0.0.1:4317'

/** One store, one HTTP app (owner, human origin) and one MCP client (agent principal). */
export async function harness() {
  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner = ensureLocalOwner(services)
  const agent = ensureLocalAgent(services)
  const app = buildHttpApp(services, { token: TOKEN, principalId: owner.id, allowedHosts: [HOST] })

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcpServer = createKalythMcpServer(services, agent.id)
  await mcpServer.connect(serverSide)
  const client = new Client({ name: 'kalyth-test', version: '0.0.0' })
  await client.connect(clientSide)

  const http = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    })
    return { status: res.statusCode, body: res.json() as Record<string, any> }
  }
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      structuredContent?: Record<string, any>
      isError?: boolean
    }
    return { isError: res.isError === true, body: res.structuredContent ?? {} }
  }
  const close = async () => {
    await client.close()
    await app.close()
  }
  return { services, owner, agent, app, client, http, mcp, close }
}

export const stated = { basis: 'stated' }
