import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { FastifyInstance } from 'fastify'
import { createKalythMcpServer } from '../mcp/server.ts'
import type { McpDeps } from '../mcp/tools.ts'

/**
 * MCP over Streamable HTTP for coding agents (ADR 0011). Every request needs an agent token; the
 * UI session token is not accepted here, and agent tokens are not accepted on /api/. Host and
 * Origin are checked by the app's onRequest hook like every other route. Each request is served by
 * a server bound to the token's principal, with origin "agent".
 */
export function registerMcpEndpoint(app: FastifyInstance, deps: McpDeps): void {
  const handler = createMcpHandler(
    (ctx) => {
      const principalId = ctx.authInfo?.clientId
      if (!principalId) throw new Error('unauthenticated MCP request')
      return createKalythMcpServer(deps, principalId)
    },
    { onerror: () => {} },
  )
  app.addHook('onClose', async () => handler.close())

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const header = req.headers.authorization ?? ''
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
      const agent = deps.services.authenticateAgentToken(presented)
      if (!agent) {
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer realm="kalyth"')
          .send({
            error: {
              code: 'unauthenticated',
              message: 'a valid agent token is required (issue one in Kalyth)',
              issues: [],
            },
          })
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === 'authorization' || value === undefined) continue
        headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const hasBody = req.method === 'POST'
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(req.body ?? null) } : {}),
      })
      const response = await handler.fetch(request, {
        authInfo: {
          token: 'redacted',
          clientId: agent.principalId,
          scopes: ['project.read', 'proposal.create', 'task.work'],
        },
        ...(hasBody ? { parsedBody: req.body } : {}),
      })
      reply.code(response.status)
      response.headers.forEach((value, key) => {
        reply.header(key, value)
      })
      if (!response.body) return reply.send()
      return reply.send(Readable.fromWeb(response.body as unknown as WebReadableStream))
    },
  })
}
