import { timingSafeEqual } from 'node:crypto'
import type { ContextCompiler } from '@kalyth/context'
import {
  type Caller,
  HTTP_STATUS,
  type KernelError,
  type NavigatorRun,
  type Result,
} from '@kalyth/contracts'
import { type KalythServices, SCHEMA_VERSION } from '@kalyth/core'
import type { Navigator } from '@kalyth/navigator'
import { TaskCoordinator } from '@kalyth/tasks'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { registerMcpEndpoint } from './mcp-http.ts'

export interface HttpAuth {
  /** Per-launch session token for the local owner's UI. */
  token: string
  principalId: string
  /** Allowed Host header values, e.g. 127.0.0.1:4317 and localhost:4317. Empty disables the check. */
  allowedHosts: readonly string[]
}

/** What one request acts on: a store, who is acting, and the components built over that store. */
export interface Workspace {
  services: KalythServices
  caller: Caller
  navigator?: Navigator | undefined
  context?: ContextCompiler | undefined
  tasks?: TaskCoordinator | undefined
}

/**
 * Which parts of the API a mode offers. Local mode offers everything; the hosted demo (ADR 0019)
 * switches off what would reach beyond a visitor's sandbox or change shared settings.
 */
export interface ApiFeatures {
  mode: 'local' | 'demo'
  /** Context packages and tasks. */
  context: boolean
  navigator: boolean
  /** Issuing, listing and revoking agent tokens. */
  agentTokens: boolean
  /** Changing provider consent. */
  consent: boolean
  /** Registering a task repository, which is a path on this machine. */
  taskRepository: boolean
  /** Checks before a Navigator run starts, and a hook for each started run. */
  runs?: {
    admit(req: FastifyRequest, workspace: Workspace): KernelError | undefined
    started(req: FastifyRequest, workspace: Workspace, done: Promise<NavigatorRun>): void
  }
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
  options: { navigator?: Navigator; context?: ContextCompiler; tasks?: TaskCoordinator } = {},
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
    if (!isApiRequest(req) || req.routeOptions.url === '/api/v1/health') return
    if (!tokenMatches(req.headers.authorization, auth.token)) {
      return sendError(reply, 401, {
        code: 'unauthenticated',
        message: 'missing or invalid session token',
        issues: [],
      })
    }
  })

  const context = options.context
  const workspace: Workspace = {
    services,
    caller: { principalId: auth.principalId, origin: 'human' },
    navigator: options.navigator,
    context,
    tasks: context ? (options.tasks ?? new TaskCoordinator({ services, context })) : undefined,
  }
  registerApiRoutes(app, () => workspace, {
    mode: 'local',
    context: context !== undefined,
    navigator: options.navigator !== undefined,
    agentTokens: true,
    consent: true,
    taskRepository: true,
  })
  if (context && workspace.tasks) {
    registerMcpEndpoint(app, { services, context, tasks: workspace.tasks })
  }
  return app
}

/** Whether a request is for the API, by its raw path or by the route it matched. */
export function isApiRequest(req: FastifyRequest): boolean {
  const underApi = (p: string) => p === '/api' || p.startsWith('/api/')
  const route = req.routeOptions.url
  return underApi(req.url.split('?', 1)[0] ?? '') || (route !== undefined && underApi(route))
}

/**
 * Registers API v1. Each route acts on the workspace that `workspaceOf` gives for its request, so
 * one process can serve one local store, or a sandbox per visitor.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  workspaceOf: (req: FastifyRequest) => Workspace,
  features: ApiFeatures,
): void {
  const send = (reply: FastifyReply, result: Result<unknown>, okStatus = 200) =>
    result.ok
      ? reply.code(okStatus).send(result.value)
      : sendError(reply, HTTP_STATUS[result.error.code], result.error)
  const params = (req: FastifyRequest) => req.params as Record<string, string>
  const query = (req: FastifyRequest) => req.query as Query
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>
  const off = (reply: FastifyReply, what: string) =>
    sendError(reply, 403, {
      code: 'unauthorized',
      message: `${what} is not available in the hosted demo (ADR 0019)`,
      issues: [],
    })

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    schemaVersion: SCHEMA_VERSION,
    mode: features.mode,
  }))
  app.get('/api/v1/types', async (req, reply) =>
    send(reply, workspaceOf(req).services.describeTypes(workspaceOf(req).caller)),
  )

  app.get('/api/v1/projects', async (req, reply) =>
    send(reply, workspaceOf(req).services.listProjects(workspaceOf(req).caller)),
  )
  app.post('/api/v1/projects', async (req, reply) =>
    send(reply, workspaceOf(req).services.createProject(workspaceOf(req).caller, body(req)), 201),
  )
  app.get('/api/v1/projects/:projectId', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.getProjectOverview(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/objects', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      workspaceOf(req).services.queryObjects(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...revisionOf(q),
        ...list('types', q.type),
        ...list('ids', q.id),
        ...afterOf(q),
        ...flagsOf(q),
      }),
    )
  })
  app.get('/api/v1/projects/:projectId/relations', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      workspaceOf(req).services.queryRelations(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...revisionOf(q),
        ...list('types', q.type),
        ...list('ids', q.id),
        ...(typeof q.from === 'string' ? { from: q.from } : {}),
        ...(typeof q.to === 'string' ? { to: q.to } : {}),
        ...afterOf(q),
        ...flagsOf(q),
      }),
    )
  })
  app.get('/api/v1/projects/:projectId/evidence', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.getEvidence(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...list('ids', query(req).id),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/history', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.getHistory(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...limitOf(query(req)),
      }),
    ),
  )
  // A whole project as one file (ADR 0014). Only this first-party UI, acting for the owner, can
  // ask; MCP has no export tool. Import is a local command (`pnpm project:import`).
  app.get('/api/v1/projects/:projectId/export', async (req, reply) => {
    const result = workspaceOf(req).services.exportProject(workspaceOf(req).caller, {
      projectId: params(req).projectId,
    })
    if (result.ok) {
      const { id, headRevision } = result.value.project
      reply.header(
        'content-disposition',
        `attachment; filename="kalyth-${id}-r${headRevision}.json"`,
      )
    }
    return send(reply, result)
  })
  app.get('/api/v1/projects/:projectId/freshness', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.assessFreshness(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/situation', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.getSituation(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
      }),
    ),
  )
  app.get('/api/v1/projects/:projectId/impact', async (req, reply) => {
    const q = query(req)
    return send(
      reply,
      workspaceOf(req).services.analyzeImpact(workspaceOf(req).caller, {
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
      workspaceOf(req).services.listProposals(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...(typeof q.status === 'string' ? { status: q.status } : {}),
        ...limitOf(q),
      }),
    )
  })
  app.post('/api/v1/projects/:projectId/proposals', async (req, reply) => {
    const input = { ...body(req), projectId: params(req).projectId }
    const checked = workspaceOf(req).context?.checkProvenance(workspaceOf(req).caller, input)
    if (checked && !checked.ok) return send(reply, checked)
    const result = workspaceOf(req).services.proposeChange(workspaceOf(req).caller, input)
    if (result.ok && result.value.status === 'invalid') return reply.code(422).send(result.value)
    return send(reply, result, 201)
  })
  app.get('/api/v1/proposals/:proposalId', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.getProposal(workspaceOf(req).caller, {
        proposalId: params(req).proposalId,
      }),
    ),
  )
  app.post('/api/v1/proposals/:proposalId/commit', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.commitProposal(workspaceOf(req).caller, {
        proposalId: params(req).proposalId,
      }),
    ),
  )
  app.post('/api/v1/proposals/:proposalId/reject', async (req, reply) =>
    send(
      reply,
      workspaceOf(req).services.rejectProposal(workspaceOf(req).caller, {
        proposalId: params(req).proposalId,
        reason: body(req).reason,
      }),
    ),
  )

  app.get('/api/v1/projects/:projectId/decisions', async (req, reply) => {
    const status = one(query(req).status)
    return send(
      reply,
      workspaceOf(req).services.listDecisions(workspaceOf(req).caller, {
        projectId: params(req).projectId,
        ...revisionOf(query(req)),
        ...(status === undefined ? {} : { status }),
      }),
    )
  })

  // Agent tokens: issued, listed and revoked by the owner in the UI (ADR 0011).
  app.get('/api/v1/projects/:projectId/agent-tokens', async (req, reply) =>
    features.agentTokens
      ? send(
          reply,
          workspaceOf(req).services.listAgentTokens(workspaceOf(req).caller, {
            projectId: params(req).projectId,
          }),
        )
      : off(reply, 'Agent access'),
  )
  app.post('/api/v1/projects/:projectId/agent-tokens', async (req, reply) =>
    features.agentTokens
      ? send(
          reply,
          workspaceOf(req).services.issueAgentToken(workspaceOf(req).caller, {
            ...body(req),
            projectId: params(req).projectId,
          }),
          201,
        )
      : off(reply, 'Agent access'),
  )
  app.post('/api/v1/agent-tokens/:tokenId/revoke', async (req, reply) =>
    features.agentTokens
      ? send(
          reply,
          workspaceOf(req).services.revokeAgentToken(workspaceOf(req).caller, {
            tokenId: params(req).tokenId,
          }),
        )
      : off(reply, 'Agent access'),
  )

  if (features.context) {
    const context = (req: FastifyRequest) => {
      const c = workspaceOf(req).context
      if (!c) throw new Error('this workspace has no context compiler')
      return c
    }
    const tasks = (req: FastifyRequest) => {
      const t = workspaceOf(req).tasks
      if (!t) throw new Error('this workspace has no task coordinator')
      return t
    }
    app.post('/api/v1/projects/:projectId/context', async (req, reply) =>
      send(
        reply,
        context(req).compile(workspaceOf(req).caller, {
          ...body(req),
          projectId: params(req).projectId,
        }),
        201,
      ),
    )
    app.get('/api/v1/projects/:projectId/context', async (req, reply) =>
      send(
        reply,
        context(req).list(workspaceOf(req).caller, {
          projectId: params(req).projectId,
          ...limitOf(query(req)),
        }),
      ),
    )
    app.get('/api/v1/context/:packageId', async (req, reply) =>
      send(reply, context(req).get(workspaceOf(req).caller, { packageId: params(req).packageId })),
    )

    // Tasks (ADR 0013). People read tasks here and change them through proposals; agents claim
    // and report over MCP only. The task repository is registered by a person, acting directly,
    // who may also file a report and reconcile the model with a task here (ADR 0024).
    app.get('/api/v1/projects/:projectId/tasks', async (req, reply) => {
      const status = query(req).status
      return send(
        reply,
        tasks(req).listTasks(workspaceOf(req).caller, {
          projectId: params(req).projectId,
          ...(typeof status === 'string' ? { status } : {}),
        }),
      )
    })
    app.get('/api/v1/tasks/:taskId', async (req, reply) =>
      send(reply, tasks(req).getTask(workspaceOf(req).caller, { taskId: params(req).taskId })),
    )
    // A person files a report themselves, verified against git like an agent's (ADR 0024).
    app.post('/api/v1/tasks/:taskId/reports', async (req, reply) =>
      send(
        reply,
        tasks(req).fileReport(workspaceOf(req).caller, {
          ...body(req),
          taskId: params(req).taskId,
        }),
        201,
      ),
    )
    // Re-analyses the task repository at the verified commit and reconciles the model with it
    // (ADR 0024). It reads a path on this machine, so the hosted demo refuses it like registration.
    app.post('/api/v1/tasks/:taskId/reconcile', async (req, reply) =>
      features.taskRepository
        ? send(
            reply,
            await tasks(req).reconcile(workspaceOf(req).caller, { taskId: params(req).taskId }),
          )
        : off(reply, 'Reconciling with a repository'),
    )
    app.get('/api/v1/projects/:projectId/task-repository', async (req, reply) =>
      send(
        reply,
        tasks(req).getRepository(workspaceOf(req).caller, { projectId: params(req).projectId }),
      ),
    )
    app.put('/api/v1/projects/:projectId/task-repository', async (req, reply) =>
      features.taskRepository
        ? send(
            reply,
            tasks(req).setRepository(workspaceOf(req).caller, {
              path: body(req).path,
              projectId: params(req).projectId,
            }),
          )
        : off(reply, 'Registering a repository'),
    )
  }

  if (features.navigator) {
    const navigator = (req: FastifyRequest) => {
      const n = workspaceOf(req).navigator
      if (!n) throw new Error('this workspace has no navigator')
      return n
    }
    // Navigator runs may spend money, so only this first-party UI (acting for the owner) starts
    // them; MCP has no such tool (ADR 0010).
    app.get('/api/v1/projects/:projectId/navigator', async (req, reply) =>
      send(
        reply,
        navigator(req).status(workspaceOf(req).caller, { projectId: params(req).projectId }),
      ),
    )
    app.put('/api/v1/projects/:projectId/navigator/consent', async (req, reply) =>
      features.consent
        ? send(
            reply,
            navigator(req).setConsent(workspaceOf(req).caller, {
              projectId: params(req).projectId,
              granted: body(req).granted,
            }),
          )
        : off(reply, 'Changing provider consent'),
    )
    app.post('/api/v1/projects/:projectId/navigator/runs', async (req, reply) => {
      const workspace = workspaceOf(req)
      const refused = features.runs?.admit(req, workspace)
      if (refused) return sendError(reply, HTTP_STATUS[refused.code], refused)
      const started = navigator(req).start(workspace.caller, {
        ...body(req),
        projectId: params(req).projectId,
      })
      if (!started.ok) return sendError(reply, HTTP_STATUS[started.error.code], started.error)
      // The run continues after the response; its record says how it ended.
      started.value.done.catch(() => {})
      features.runs?.started(req, workspace, started.value.done)
      return reply.code(202).send(started.value.run)
    })
    app.get('/api/v1/projects/:projectId/navigator/runs', async (req, reply) =>
      send(
        reply,
        navigator(req).listRuns(workspaceOf(req).caller, {
          projectId: params(req).projectId,
          ...limitOf(query(req)),
        }),
      ),
    )
    app.get('/api/v1/navigator/runs/:runId', async (req, reply) =>
      send(reply, navigator(req).getRun(workspaceOf(req).caller, { runId: params(req).runId })),
    )
  }
}

export function sendError(reply: FastifyReply, status: number, error: KernelError) {
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

function afterOf(q: Query): { after?: string } {
  const v = one(q.after)
  return v === undefined ? {} : { after: v }
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
