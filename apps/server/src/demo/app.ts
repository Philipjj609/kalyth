import { timingSafeEqual } from 'node:crypto'
import { ContextCompiler } from '@kalyth/context'
import type { KernelError, NavigatorRun } from '@kalyth/contracts'
import { KalythServices, SqliteStore } from '@kalyth/core'
import type { ProviderGateway } from '@kalyth/gateway'
import { type GroundingOptions, Navigator } from '@kalyth/navigator'
import { TaskCoordinator } from '@kalyth/tasks'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { isApiRequest, registerApiRoutes, sendError, type Workspace } from '../http/app.ts'
import { registerWebUi } from '../http/static.ts'
import type { DemoAllowance, Pool } from './allowance.ts'
import { addressKey, DailyBudgets, DailyMeter, RateLimiter } from './limits.ts'
import { DemoFullError, type DemoSession, DemoSessions, type OpenSandbox } from './sessions.ts'
import type { DemoTemplate } from './template.ts'

/** Which gateway a run uses: a pool with live calls, or recordings only. */
export type GatewayMode = Pool | 'recorded'

interface DemoSandbox extends OpenSandbox {
  workspaces: Record<GatewayMode, Workspace>
}

export interface DemoOptions {
  /** The public host name (with a port, if not the default), checked against Host and Origin. */
  host: string
  /** Served over https: secure cookies and HSTS. */
  secure: boolean
  template: DemoTemplate
  /** Where sandbox copies live. */
  sandboxDir: string
  gateways: Record<GatewayMode, ProviderGateway>
  allowance: DemoAllowance
  /** Whether a live provider is configured at all. */
  live: boolean
  liveRunsPerDay?: number
  /**
   * What a pool must have left today before the UI offers a live run: the worst case of one live
   * alternatives run (reserve.ts). The gateway still checks every call against the ledger.
   */
  liveRunReserveMicroUsd?: number
  /** The model live runs use, named in the UI. */
  liveModel?: string
  /** Unlocks the judges' pool. Without one, there is no judges' pool. */
  judgeCode?: string | undefined
  webRoot?: string | undefined
  clientIp?: (req: FastifyRequest) => string
  /** What the demo may send in a UTC day, to everyone together (3 GB). */
  dailySendLimitBytes?: number
  /** The last part of the daily limit, kept for judges' sessions (a sixth: 500 MB of 3 GB). */
  judgesReserveBytes?: number
  /** What anyone may use of the judges' reserve to load the UI and enter a code (a fifth of it). */
  judgesEntryBytes?: number
  /** What one address, or one IPv6 /64, may be sent in a UTC day (150 MB). */
  perAddressDailyBytes?: number
  /** The largest request body (64 KB; the UI's largest is under 1 KB). */
  bodyLimitBytes?: number
  /** The most one sandbox's files may hold (24 MB), and all sandboxes together (640 MB). */
  maxSandboxBytes?: number
  maxSandboxesBytes?: number
  limits?: Partial<{
    requestsPerMinute: number
    sessionsPerHour: number
    runsPerHour: number
    judgeAttemptsPerHour: number
  }>
  maxSessions?: number
  grounding?: GroundingOptions
  clock?: () => Date
}

/** The header the first-party UI sends with every change; a cross-site form cannot send it. */
export const UI_HEADER = 'x-kalyth-ui'

/**
 * What a visitor without a judge's session needs to reach the judge-code button: the UI's files,
 * the project's header and the demo's own routes. These may use part of the judges' reserve.
 */
const ENTRY_ROUTES = new Set([
  'GET /',
  'GET /*',
  'GET /api/v1/projects',
  'GET /api/v1/projects/:projectId',
  'GET /api/v1/demo/session',
  'POST /api/v1/demo/session',
  'POST /api/v1/demo/judge',
])

/**
 * The hosted demo (ADR 0019). Every visitor gets an anonymous cookie session and a copy of the
 * template project, and acts as its owner. The API is the local one, served from that copy, except
 * for what would reach beyond it: no MCP, no agent tokens, no consent changes and no repository
 * registration. Navigator runs answer from recordings first; live runs are charged to the public
 * or judges' pool, within daily caps, a few per session and one at a time. Host and Origin are
 * checked, changes need the UI's header, and requests are rate-limited per address (an IPv6 /64
 * counts as one address).
 *
 * Traffic is bounded per address and in total: each address has its own daily share, and once the
 * day's total is nearly used, only judges' sessions are served, until the whole limit is reached.
 * Sandboxes are bounded in size, one by one and all together (DemoSessions).
 */
export function buildDemoApp(options: DemoOptions): FastifyInstance {
  const clock = options.clock ?? (() => new Date())
  const now = () => clock().getTime()
  const scheme = options.secure ? 'https' : 'http'
  const origin = `${scheme}://${options.host}`
  const cookieName = options.secure ? '__Host-kalyth_demo' : 'kalyth_demo'
  const liveRunsPerDay = options.liveRunsPerDay ?? 3
  const clientIp = options.clientIp ?? ((req: FastifyRequest) => req.ip)
  const addressOf = (req: FastifyRequest) => addressKey(clientIp(req))
  const limits = {
    requestsPerMinute: 600,
    sessionsPerHour: 20,
    runsPerHour: 10,
    judgeAttemptsPerHour: 10,
    ...options.limits,
  }
  const requests = new RateLimiter(limits.requestsPerMinute, 60_000, now)
  const newSessions = new RateLimiter(limits.sessionsPerHour, 3_600_000, now)
  const runs = new RateLimiter(limits.runsPerHour, 3_600_000, now)
  const judgeAttempts = new RateLimiter(limits.judgeAttemptsPerHour, 3_600_000, now)
  const dailyLimit = options.dailySendLimitBytes ?? 3_000_000_000
  const judgesReserve = options.judgesReserveBytes ?? Math.round(dailyLimit / 6)
  const judgesEntry = options.judgesEntryBytes ?? Math.round(judgesReserve / 5)
  const sent = new DailyMeter(dailyLimit, clock)
  const sentTo = new DailyBudgets(options.perAddressDailyBytes ?? 150_000_000, clock)

  const sessions = new DemoSessions<DemoSandbox>({
    template: options.template.file,
    dir: options.sandboxDir,
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.maxSandboxBytes === undefined ? {} : { maxSandboxBytes: options.maxSandboxBytes }),
    ...(options.maxSandboxesBytes === undefined
      ? {}
      : { maxTotalBytes: options.maxSandboxesBytes }),
    clock: now,
    openSandbox: (file) => {
      const store = new SqliteStore(file)
      const services = new KalythServices({ store })
      const context = new ContextCompiler({ services })
      const tasks = new TaskCoordinator({ services, context })
      const caller = { principalId: options.template.ownerId, origin: 'human' as const }
      const workspace = (mode: GatewayMode): Workspace => ({
        services,
        caller,
        context,
        tasks,
        navigator: new Navigator({
          services,
          gateway: options.gateways[mode],
          ...(options.grounding ? { grounding: options.grounding } : {}),
        }),
      })
      return {
        workspaces: {
          public: workspace('public'),
          judges: workspace('judges'),
          recorded: workspace('recorded'),
        },
        close: () => store.close(),
      }
    },
  })

  const sessionOf = new WeakMap<FastifyRequest, DemoSession<DemoSandbox>>()
  const session = (req: FastifyRequest) => {
    const found = sessionOf.get(req)
    if (!found) throw new Error('no demo session for this request')
    return found
  }
  const poolOf = (s: DemoSession<DemoSandbox>): Pool =>
    s.judge && options.judgeCode ? 'judges' : 'public'
  const modeOf = (s: DemoSession<DemoSandbox>): GatewayMode =>
    options.live && sessions.liveRunsToday(s) < liveRunsPerDay ? poolOf(s) : 'recorded'
  const workspaceOf = (req: FastifyRequest) => {
    const s = session(req)
    return sessions.sandbox(s).workspaces[modeOf(s)]
  }

  const app = Fastify({ logger: false, bodyLimit: options.bodyLimitBytes ?? 64 * 1024 })
  const deny = (reply: FastifyReply, status: number, error: KernelError) =>
    sendError(reply, status, error)
  /** Refuses until the next UTC day: the API's error envelope, or plain text for the UI's files. */
  const refuseToday = (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    message: string,
  ) =>
    isApiRequest(req)
      ? deny(reply, status, {
          code: 'retryable',
          message,
          issues: [],
          retryAfterMs: 86_400_000 - (now() % 86_400_000),
        })
      : reply.code(status).type('text/plain; charset=utf-8').send(`${message}\n`)
  /** A request that may write to the visitor's sandbox; the demo's own routes do not. */
  const changes = (req: FastifyRequest) =>
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    !(req.routeOptions.url ?? '').startsWith('/api/v1/demo/')

  app.addHook('onRequest', async (req, reply) => {
    // The platform's health checker may not send the public host; the check reveals nothing.
    const health = req.routeOptions.url === '/api/v1/health'
    if (health && req.method === 'GET') return
    if (req.headers.host !== options.host) {
      return deny(reply, 403, { code: 'unauthorized', message: 'host not allowed', issues: [] })
    }
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      return deny(reply, 403, { code: 'unauthorized', message: 'origin not allowed', issues: [] })
    }
    const address = addressOf(req)
    if (sentTo.exceeded(address)) {
      return refuseToday(
        req,
        reply,
        429,
        'This address has used its share of the Kalyth demo for today. It resumes at 00:00 UTC.',
      )
    }
    const found = sessions.find(cookieValue(req.headers.cookie, cookieName))
    const judge = found !== undefined && poolOf(found) === 'judges'
    const entering = ENTRY_ROUTES.has(`${req.method} ${req.routeOptions.url}`)
    const entryOpen = sent.sentToday() < dailyLimit - judgesReserve + judgesEntry
    const open = judge
      ? !sent.exceeded()
      : entering
        ? entryOpen
        : sent.sentToday() < dailyLimit - judgesReserve
    if (!open) {
      return refuseToday(
        req,
        reply,
        503,
        `The Kalyth demo has used its traffic allowance for today. It resumes at 00:00 UTC.${!judge && entryOpen ? ' Judges with a code can still use it.' : ''}`,
      )
    }
    if (!requests.take(address)) {
      return deny(reply, 429, {
        code: 'retryable',
        message: 'too many requests from this address; try again in a minute',
        issues: [],
        retryAfterMs: 60_000,
      })
    }
    if (!isApiRequest(req)) return
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers[UI_HEADER] !== '1') {
      return deny(reply, 403, {
        code: 'unauthorized',
        message: 'changes must come from the Kalyth UI',
        issues: [],
      })
    }
    if (found) {
      if (changes(req)) {
        const room = sessions.roomForChange(found)
        if (room === 'sandbox_full') {
          return deny(reply, 507, {
            code: 'budget_exceeded',
            message:
              'Your copy of the demo has reached its size limit, so it takes no more changes. You can still look around in it.',
            issues: [],
          })
        }
        if (room === 'no_room') {
          return deny(reply, 507, {
            code: 'retryable',
            message:
              'The Kalyth demo is short of space right now, so it takes no more changes. Please try again in a few minutes.',
            issues: [],
            retryAfterMs: 300_000,
          })
        }
      }
      sessionOf.set(req, found)
      return
    }
    if (req.method === 'POST' && req.routeOptions.url === '/api/v1/demo/session') return
    return deny(reply, 401, {
      code: 'unauthenticated',
      message: 'no demo session; reload the page to start one',
      issues: [],
    })
  })

  app.addHook('onSend', async (req, reply, payload) => {
    if (options.secure) reply.header('strict-transport-security', 'max-age=31536000')
    const length =
      typeof payload === 'string'
        ? Buffer.byteLength(payload)
        : Buffer.isBuffer(payload)
          ? payload.length
          : Number(reply.getHeader('content-length') ?? 0)
    // Headers and framing are not counted exactly; 400 bytes a response is a fair allowance.
    sent.add(length + 400)
    sentTo.add(addressOf(req), length + 400)
    return payload
  })

  const view = (s: DemoSession<DemoSandbox>) => {
    const pool = poolOf(s)
    return {
      projectId: options.template.projectId,
      judge: pool === 'judges',
      judgeCodeAvailable: Boolean(options.judgeCode),
      live: {
        available: options.live,
        pool,
        runsLeftToday: Math.max(0, liveRunsPerDay - sessions.liveRunsToday(s)),
        runsPerDay: liveRunsPerDay,
        poolRemainingTodayMicroUsd: options.allowance.remainingToday(pool),
        runReserveMicroUsd: options.liveRunReserveMicroUsd ?? 0,
        model: options.liveModel ?? null,
      },
      presets: options.template.presets,
      mcp: false,
    }
  }

  app.post('/api/v1/demo/session', async (req, reply) => {
    const existing = sessionOf.get(req)
    if (existing) return reply.send(view(existing))
    if (!newSessions.take(addressOf(req))) {
      return deny(reply, 429, {
        code: 'retryable',
        message: 'too many new sessions from this address; try again later',
        issues: [],
      })
    }
    let created: ReturnType<typeof sessions.create>
    try {
      created = sessions.create()
    } catch (error) {
      if (!(error instanceof DemoFullError)) throw error
      return deny(reply, 503, {
        code: 'retryable',
        message: 'The Kalyth demo is full right now. Please try again in a few minutes.',
        issues: [],
        retryAfterMs: 300_000,
      })
    }
    reply.header(
      'set-cookie',
      [
        `${cookieName}=${created.cookie}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=86400',
        ...(options.secure ? ['Secure'] : []),
      ].join('; '),
    )
    return reply.code(201).send(view(created.session))
  })
  app.get('/api/v1/demo/session', async (req, reply) => reply.send(view(session(req))))
  app.post('/api/v1/demo/judge', async (req, reply) => {
    const s = session(req)
    if (!options.judgeCode) {
      return deny(reply, 404, { code: 'not_found', message: 'there is no judge code', issues: [] })
    }
    if (!judgeAttempts.take(addressOf(req)) || !judgeAttempts.take(`session:${s.key}`)) {
      return deny(reply, 429, {
        code: 'retryable',
        message: 'too many attempts; try again later',
        issues: [],
      })
    }
    const given = (req.body as { code?: unknown } | undefined)?.code
    if (typeof given !== 'string' || !sameSecret(given.trim(), options.judgeCode)) {
      return deny(reply, 403, {
        code: 'unauthorized',
        message: 'that code is not right',
        issues: [],
      })
    }
    s.judge = true
    return reply.send(view(s))
  })

  registerApiRoutes(app, workspaceOf, {
    mode: 'demo',
    context: true,
    navigator: true,
    agentTokens: false,
    consent: false,
    taskRepository: false,
    runs: {
      admit: (req) => {
        const s = session(req)
        if (s.running) {
          return {
            code: 'conflicting',
            message: 'a run is already in progress in your copy; wait for it to finish',
            issues: [],
          }
        }
        if (!runs.take(addressOf(req))) {
          return {
            code: 'retryable',
            message: 'too many runs from this address; try again later',
            issues: [],
          }
        }
        options.allowance.refresh()
        return undefined
      },
      started: (req, _workspace, done) => {
        const s = session(req)
        s.running = true
        done
          .then((run) => {
            if (isLive(run)) sessions.countLiveRun(s)
          })
          .catch(() => {})
          .finally(() => {
            s.running = false
          })
      },
    },
  })
  if (options.webRoot) registerWebUi(app, { root: options.webRoot })

  const sweeper = setInterval(() => {
    sessions.sweep()
    for (const limiter of [requests, newSessions, runs, judgeAttempts]) limiter.prune()
  }, 600_000)
  sweeper.unref()
  app.addHook('onClose', async () => {
    clearInterval(sweeper)
    sessions.closeAll()
  })
  return app
}

/** A run counts against a session's live runs if any of its calls reached a live provider. */
function isLive(run: NavigatorRun): boolean {
  return run.calls.some((c) => c.recorded !== true && c.outcome !== 'refused')
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
