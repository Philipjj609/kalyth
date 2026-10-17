import { timingSafeEqual } from 'node:crypto'
import type { ContextCompiler } from '@kalyth/context'
import { type Caller, HTTP_STATUS, type KernelError, type Result } from '@kalyth/contracts'
import { type KalythServices, SCHEMA_VERSION } from '@kalyth/core'
import type { Navigator } from '@kalyth/navigator'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { registerMcpEndpoint } from './mcp-http.ts'

export interface HttpAuth {
  /** Per-launch session token for the local owner's UI. */
  token: string
  principalId: string
  /** Allowed Host header values, e.g. 127.0.0.1:4317 and localhost:4317. Empty disables the check. */
  allowedHosts: readonly string[]
}

type Query = Record<string, string | string[] | undefined>

/**
 * HTTP API v1 over the shared services (ADR 0006). Local mode binds to 127.0.0.1; requests need
 * the session token, and Host/Origin are checked so a web page cannot reach the API through DNS
 * rebinding or cross-origin requests. Authenticated requests act for the owner with origin "human",
 * because the token is only handed to the first-party UI.
 */
export function buildHttpApp(
  services: KalythServices,
  auth: HttpAuth,
  options: { navigator?: Navigator; context?: ContextCompiler } = {},
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  const allowedOrigins = new Set(auth.allowedHosts.map((h) => `http://${h}`))

  app.addHook('onRequest', async (req, reply) => {
    if (auth.allowedHosts.length > 0 && !auth.allowedHosts.includes(req.headers.host ?? '')) {
      return sendError(reply, 403, {
        code: 'unauthorized',
        message: 'host not allowed',
        issues: [],
      })
    }
    const origin = req.headers.origin
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return sendError(reply, 403, {
        code: 'unauthorized',
        message: 'origin not allowed',
        issues: [],
      })
    }
    // The token guards the API only; the UI shell and its assets are public. The routed pattern is
    // checked as well as the raw path, so an encoded path that routes to the API still needs it.
    const route = req.routeOptions.url
    if (route === '/api/v1/health') return
    const underApi = (p: string) => p === '/api' || p.startsWith('/api/')
    if (!underApi(req.url.split('?', 1)[0] ?? '') && !(route !== undefined && underApi(route))) {
      return
    }
    if (!tokenMatches(req.headers.authorization, auth.token)) {
      return sendError(reply, 401, {
        code: 'unauthenticated',
        message: 'missing or invalid session token',
        issues: [],
      })
    }
  })

  const caller: Caller = { principalId: auth.principalId, origin: 'human' }
  const send = (reply: FastifyReply, result: Result<unknown>, okStatus = 200) =>
    result.ok
      ? reply.code(okStatus).send(result.value)
      : sendError(reply, HTTP_STATUS[result.error.code], result.error)
  const params = (req: FastifyRequest) => req.params as Record<string, string>
  const query = (req: FastifyRequest) => req.query as Query
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>

  app.get('/api/v1/health', async () => ({ status: 'ok', schemaVersion: SCHEMA_VERSION }))
  app.get('/api/v1/types', async (_req, reply) => send(reply, services.describeTypes(caller)))

  app.get('/api/v1/projects', async (_req, reply) => send(reply, services.listProjects(caller)))
  app.post('/api/v1/projects', async (req, reply) =>
    send(reply, services.createProject(caller, body(req)), 201),
  )
  app.get('/api/v1/projects/:projectId', async (req, reply) =>
    send(
      reply,
      services.getProjectOverview(caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/objects', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      services.queryObjects(caller, {
        projectId: params(req).projectId,
        ...revisionOf(q),
        ...list('types', q.type),
        ...list('ids', q.id),
        ...flagsOf(q),
      }),
    )
  })
  app.get('/api/v1/projects/:projectId/relations', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      services.queryRelations(caller, {
        projectId: params(req).projectId,
        ...revisionOf(q),
        ...list('types', q.type),
        ...list('ids', q.id),
        ...(typeof q.from === 'string' ? { from: q.from } : {}),
        ...(typeof q.to === 'string' ? { to: q.to } : {}),
        ...flagsOf(q),
      }),
    )
  })
  app.get('/api/v1/projects/:projectId/evidence', async (req, reply) =>
    send(
      reply,
      services.getEvidence(caller, {
        projectId: params(req).projectId,
        ...list('ids', query(req).id),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/history', async (req, reply) =>
    send(
      reply,
      services.getHistory(caller, { projectId: params(req).projectId, ...limitOf(query(req)) }),
    ),
  )
  app.get('/api/v1/projects/:projectId/freshness', async (req, reply) =>
    send(
      reply,
      services.assessFreshness(caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/situation', async (req, reply) =>
    send(
      reply,
      services.getSituation(caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/impact', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      services.analyzeImpact(caller, {
        projectId: params(req).projectId,
        ...revisionOf(q),
        seeds: list('seeds', q.seed).seeds ?? [],
        ...(one(q.maxDepth) === undefined ? {} : { maxDepth: Number(one(q.maxDepth)) }),
        ...(one(q.maxNodes) === undefined ? {} : { maxNodes: Number(one(q.maxNodes)) }),
      }),
    )
  })
  app.get('/api/v1/projects/:projectId/proposals', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      services.listProposals(caller, {
        projectId: params(req).projectId,
        ...(typeof q.status === 'string' ? { status: q.status } : {}),
        ...limitOf(q),
      }),
    )
  })
  app.post('/api/v1/projects/:projectId/proposals', async (req, reply) => {
    const input = { ...body(req), projectId: params(req).projectId }
    const checked = options.context?.checkProvenance(caller, input)
    if (checked && !checked.ok) return send(reply, checked)
    const result = services.proposeChange(caller, input)
    if (result.ok && result.value.status === 'invalid') return reply.code(422).send(result.value)
    return send(reply, result, 201)
  })
  app.get('/api/v1/proposals/:proposalId', async (req, reply) =>
    send(reply, services.getProposal(caller, { proposalId: params(req).proposalId })),
  )
  app.post('/api/v1/proposals/:proposalId/commit', async (req, reply) =>
    send(reply, services.commitProposal(caller, { proposalId: params(req).proposalId })),
  )
  app.post('/api/v1/proposals/:proposalId/reject', async (req, reply) =>
    send(
      reply,
      services.rejectProposal(caller, {
        proposalId: params(req).proposalId,
        reason: body(req).reason,
      }),
    ),
  )

  app.get('/api/v1/projects/:projectId/decisions', async (req, reply) => {
    const status = one(query(req).status)
    return send(
      reply,
      services.listDecisions(caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
        ...(status === undefined ? {} : { status }),
      }),
    )
  })

  // Agent tokens: issued, listed and revoked by the owner in the UI (ADR 0011).
  app.get('/api/v1/projects/:projectId/agent-tokens', async (req, reply) =>
    send(reply, services.listAgentTokens(caller, { projectId: params(req).projectId })),
  )
  app.post('/api/v1/projects/:projectId/agent-tokens', async (req, reply) =>
    send(
      reply,
      services.issueAgentToken(caller, { ...body(req), projectId: params(req).projectId }),
      201,
    ),
  )
  app.post('/api/v1/agent-tokens/:tokenId/revoke', async (req, reply) =>
    send(reply, services.revokeAgentToken(caller, { tokenId: params(req).tokenId })),
  )

  const context = options.context
  if (context) {
    app.post('/api/v1/projects/:projectId/context', async (req, reply) =>
      send(reply, context.compile(caller, { ...body(req), projectId: params(req).projectId }), 201),
    )
    app.get('/api/v1/projects/:projectId/context', async (req, reply) =>
      send(
        reply,
        context.list(caller, { projectId: params(req).projectId, ...limitOf(query(req)) }),
      ),
    )
    app.get('/api/v1/context/:packageId', async (req, reply) =>
      send(reply, context.get(caller, { packageId: params(req).packageId })),
    )
    registerMcpEndpoint(app, { services, context })
  }

  const navigator = options.navigator
  if (navigator) {
    // Navigator runs may spend money, so only this first-party UI (acting for the owner) starts
    // them; MCP has no such tool (ADR 0010).
    app.get('/api/v1/projects/:projectId/navigator', async (req, reply) =>
      send(reply, navigator.status(caller, { projectId: params(req).projectId })),
    )
    app.put('/api/v1/projects/:projectId/navigator/consent', async (req, reply) =>
      send(
        reply,
        navigator.setConsent(caller, {
          projectId: params(req).projectId,
          granted: body(req).granted,
        }),
      ),
    )
    app.post('/api/v1/projects/:projectId/navigator/runs', async (req, reply) => {
      const started = navigator.start(caller, { ...body(req), projectId: params(req).projectId })
      if (!started.ok) return sendError(reply, HTTP_STATUS[started.error.code], started.error)
      // The run continues after the response; its record says how it ended.
      started.value.done.catch(() => {})
      return reply.code(202).send(started.value.run)
    })
    app.get('/api/v1/projects/:projectId/navigator/runs', async (req, reply) =>
      send(
        reply,
        navigator.listRuns(caller, { projectId: params(req).projectId, ...limitOf(query(req)) }),
      ),
    )
    app.get('/api/v1/navigator/runs/:runId', async (req, reply) =>
      send(reply, navigator.getRun(caller, { runId: params(req).runId })),
    )
  }

  return app
}

function sendError(reply: FastifyReply, status: number, error: KernelError) {
  return reply.code(status).send({ error })
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function revisionOf(q: Query): { revision?: number } {
  const v = one(q.revision)
  return v === undefined ? {} : { revision: Number(v) }
}

function limitOf(q: Query): { limit?: number } {
  const v = one(q.limit)
  return v === undefined ? {} : { limit: Number(v) }
}

function flagsOf(q: Query): { includeRetired?: boolean; limit?: number } {
  const retired = one(q.includeRetired)
  return { ...(retired === undefined ? {} : { includeRetired: retired === 'true' }), ...limitOf(q) }
}

/** Accepts repeated parameters and comma-separated values. */
function list<K extends string>(
  key: K,
  v: string | string[] | undefined,
): Partial<Record<K, string[]>> {
  if (v === undefined) return {}
  const values = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).filter(Boolean)
  return { [key]: values } as Partial<Record<K, string[]>>
}
