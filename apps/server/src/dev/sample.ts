import { createHash } from 'node:crypto'
import type { Caller, ClaimInput, OperationInput, ProjectSummary, Result } from '@kalyth/contracts'
import { AGENT_SCOPES, ensureLocalOwner, ensurePrincipal, type KalythServices } from '@kalyth/core'

/**
 * Development seed: a small, hand-written sample model for exercising the workbench UI without the
 * analyzer. Everything goes through the application services, exactly as the API would, so
 * validation, authorisation and revisions are real. The source spans and excerpts are invented and
 * say so in their observation coverage; nothing here describes a real repository.
 *
 * Revisions produced: r1 structure (tool origin), r2 decisions and intent (human), r3 data access
 * inferred by an agent, r4 a human correction, r5 an agent question rebased from r3. Proposals left
 * behind: one pending (agent), one stale, one rejected and one invalid.
 */

export const SAMPLE_PROJECT_NAME = 'Sample: fullstack app'

const REPO = 'kalyth-samples/fullstack-app'
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')
const COMMIT = sha1('kalyth-sample-commit-1')
const SEED_TOOL = { tool: 'kalyth-dev-seed', toolVersion: '0.1.0' }
const OBSERVATION = {
  ...SEED_TOOL,
  coverage:
    'Illustrative sample data written by hand for UI development; not produced by analysing a repository.',
  limitations: 'Line spans and excerpts are invented.',
}

type Op = OperationInput

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-56)

function must<T>(result: Result<T>, what: string): T {
  if (!result.ok) {
    const issues = result.error.issues.map((i) => `${i.code}: ${i.message}`).join('; ')
    throw new Error(`${what} failed: ${result.error.code} ${result.error.message} ${issues}`)
  }
  return result.value
}

// ---------- sample content ----------

interface ModuleSpec {
  path: string
  language: 'python' | 'typescript'
  container: 'backend' | 'frontend'
  lines: [number, number]
  excerpt: string
}

const py = (path: string, lines: [number, number], excerpt: string): ModuleSpec => ({
  path,
  language: 'python',
  container: 'backend',
  lines,
  excerpt,
})
const ts = (path: string, lines: [number, number], excerpt: string): ModuleSpec => ({
  path,
  language: 'typescript',
  container: 'frontend',
  lines,
  excerpt,
})

const MODULES: ModuleSpec[] = [
  py('backend/app/main.py', [12, 18], 'app = FastAPI(title=settings.PROJECT_NAME)'),
  py('backend/app/api/main.py', [1, 14], 'api_router.include_router(items.router)'),
  py('backend/app/api/deps.py', [30, 46], 'def get_current_user(session, token) -> User:'),
  py('backend/app/api/routes/items.py', [1, 9], 'router = APIRouter(prefix="/items")'),
  py('backend/app/api/routes/login.py', [1, 12], 'router = APIRouter(tags=["login"])'),
  py('backend/app/api/routes/users.py', [1, 10], 'router = APIRouter(prefix="/users")'),
  py('backend/app/api/routes/utils.py', [1, 8], 'router = APIRouter(prefix="/utils")'),
  py('backend/app/core/config.py', [20, 40], 'class Settings(BaseSettings):'),
  py('backend/app/core/db.py', [5, 9], 'engine = create_engine(settings.database_uri)'),
  py(
    'backend/app/core/security.py',
    [14, 22],
    'def create_access_token(subject, expires_delta) -> str:',
  ),
  py('backend/app/models.py', [60, 72], 'class Item(ItemBase, table=True):'),
  py('backend/app/crud.py', [8, 20], 'def create_user(*, session, user_create) -> User:'),
  py(
    'backend/app/utils.py',
    [30, 48],
    'def send_email(*, email_to, subject, html_content) -> None:',
  ),
  py('backend/app/initial_data.py', [10, 16], 'def init() -> None:'),
  ts('frontend/src/main.tsx', [20, 34], 'createRoot(rootElement).render(<App />)'),
  ts('frontend/src/client/sdk.gen.ts', [1, 40], 'export class ItemsService {'),
  ts(
    'frontend/src/client/core/request.ts',
    [200, 230],
    'export const request = <T>(config, options) =>',
  ),
  ts('frontend/src/hooks/useAuth.ts', [20, 60], 'const useAuth = () => {'),
  ts('frontend/src/routes/login.tsx', [30, 44], 'export const Route = createFileRoute("/login")'),
  ts('frontend/src/routes/_layout/items.tsx', [40, 90], 'function ItemsTable() {'),
  ts('frontend/src/routes/_layout/admin.tsx', [30, 80], 'function UsersTable() {'),
  ts('frontend/src/components/Items/AddItem.tsx', [20, 70], 'const AddItem = () => {'),
  ts('frontend/src/components/Common/Navbar.tsx', [10, 30], 'const Navbar = ({ type }) => {'),
]

/** Import edges between modules: [from, to, line]. */
const MODULE_DEPS: [string, string, number][] = [
  ['backend/app/main.py', 'backend/app/api/main.py', 4],
  ['backend/app/main.py', 'backend/app/core/config.py', 5],
  ['backend/app/api/main.py', 'backend/app/api/routes/items.py', 3],
  ['backend/app/api/main.py', 'backend/app/api/routes/login.py', 3],
  ['backend/app/api/main.py', 'backend/app/api/routes/users.py', 3],
  ['backend/app/api/main.py', 'backend/app/api/routes/utils.py', 3],
  ['backend/app/api/routes/items.py', 'backend/app/api/deps.py', 6],
  ['backend/app/api/routes/items.py', 'backend/app/models.py', 7],
  ['backend/app/api/routes/login.py', 'backend/app/api/deps.py', 8],
  ['backend/app/api/routes/login.py', 'backend/app/core/security.py', 10],
  ['backend/app/api/routes/login.py', 'backend/app/crud.py', 7],
  ['backend/app/api/routes/users.py', 'backend/app/api/deps.py', 7],
  ['backend/app/api/routes/users.py', 'backend/app/crud.py', 6],
  ['backend/app/api/routes/users.py', 'backend/app/models.py', 8],
  ['backend/app/api/routes/utils.py', 'backend/app/utils.py', 5],
  ['backend/app/api/deps.py', 'backend/app/core/db.py', 12],
  ['backend/app/api/deps.py', 'backend/app/core/security.py', 11],
  ['backend/app/api/deps.py', 'backend/app/core/config.py', 10],
  ['backend/app/api/deps.py', 'backend/app/models.py', 13],
  ['backend/app/crud.py', 'backend/app/models.py', 4],
  ['backend/app/crud.py', 'backend/app/core/security.py', 3],
  ['backend/app/core/db.py', 'backend/app/core/config.py', 2],
  ['backend/app/core/db.py', 'backend/app/models.py', 3],
  ['backend/app/initial_data.py', 'backend/app/core/db.py', 4],
  ['backend/app/utils.py', 'backend/app/core/config.py', 9],
  ['frontend/src/main.tsx', 'frontend/src/routes/login.tsx', 8],
  ['frontend/src/hooks/useAuth.ts', 'frontend/src/client/sdk.gen.ts', 5],
  ['frontend/src/routes/login.tsx', 'frontend/src/hooks/useAuth.ts', 12],
  ['frontend/src/routes/_layout/items.tsx', 'frontend/src/client/sdk.gen.ts', 14],
  ['frontend/src/routes/_layout/items.tsx', 'frontend/src/components/Items/AddItem.tsx', 16],
  ['frontend/src/routes/_layout/admin.tsx', 'frontend/src/client/sdk.gen.ts', 13],
  ['frontend/src/components/Items/AddItem.tsx', 'frontend/src/client/sdk.gen.ts', 15],
  ['frontend/src/components/Common/Navbar.tsx', 'frontend/src/hooks/useAuth.ts', 6],
  ['frontend/src/client/sdk.gen.ts', 'frontend/src/client/core/request.ts', 4],
]

const ENDPOINTS: { method: string; path: string; handler: string; module: string; line: number }[] =
  [
    {
      method: 'POST',
      path: '/api/v1/login/access-token',
      handler: 'login.login_access_token',
      module: 'backend/app/api/routes/login.py',
      line: 20,
    },
    {
      method: 'GET',
      path: '/api/v1/users/me',
      handler: 'users.read_user_me',
      module: 'backend/app/api/routes/users.py',
      line: 70,
    },
    {
      method: 'GET',
      path: '/api/v1/items/',
      handler: 'items.read_items',
      module: 'backend/app/api/routes/items.py',
      line: 14,
    },
    {
      method: 'POST',
      path: '/api/v1/items/',
      handler: 'items.create_item',
      module: 'backend/app/api/routes/items.py',
      line: 60,
    },
    {
      method: 'DELETE',
      path: '/api/v1/items/{id}',
      handler: 'items.delete_item',
      module: 'backend/app/api/routes/items.py',
      line: 98,
    },
    {
      method: 'GET',
      path: '/api/v1/utils/health-check/',
      handler: 'utils.health_check',
      module: 'backend/app/api/routes/utils.py',
      line: 26,
    },
  ]

const LIBRARIES: {
  name: string
  version: string
  ecosystem: string
  from: string
  manifest: string
  line: number
}[] = [
  {
    name: 'fastapi',
    version: '0.115',
    ecosystem: 'pypi',
    from: 'backend',
    manifest: 'backend/pyproject.toml',
    line: 7,
  },
  {
    name: 'sqlmodel',
    version: '0.0.22',
    ecosystem: 'pypi',
    from: 'backend',
    manifest: 'backend/pyproject.toml',
    line: 12,
  },
  {
    name: 'pydantic',
    version: '2.9',
    ecosystem: 'pypi',
    from: 'backend',
    manifest: 'backend/pyproject.toml',
    line: 9,
  },
  {
    name: 'pyjwt',
    version: '2.9',
    ecosystem: 'pypi',
    from: 'backend',
    manifest: 'backend/pyproject.toml',
    line: 15,
  },
  {
    name: 'react',
    version: '18.3',
    ecosystem: 'npm',
    from: 'frontend',
    manifest: 'frontend/package.json',
    line: 22,
  },
  {
    name: '@tanstack/react-query',
    version: '5.59',
    ecosystem: 'npm',
    from: 'frontend',
    manifest: 'frontend/package.json',
    line: 18,
  },
  {
    name: '@tanstack/react-router',
    version: '1.19',
    ecosystem: 'npm',
    from: 'frontend',
    manifest: 'frontend/package.json',
    line: 19,
  },
  {
    name: 'axios',
    version: '1.7',
    ecosystem: 'npm',
    from: 'frontend',
    manifest: 'frontend/package.json',
    line: 16,
  },
]

// ---------- builders ----------

function evidence(ref: string, path: string, lines: [number, number], excerpt: string): Op {
  return {
    op: 'recordEvidence',
    ref,
    evidence: {
      source: {
        kind: 'sourceSpan',
        repo: REPO,
        commit: COMMIT,
        path,
        blobSha: sha1(`blob:${path}`),
        span: { startLine: lines[0], endLine: lines[1] },
      },
      excerpt,
      collectedBy: SEED_TOOL,
    },
  }
}

const observed = (...groups: string[][]): ClaimInput => ({
  basis: 'observed',
  observation: OBSERVATION,
  supports: groups.map((allOf) => ({ allOf })),
})
const stated: ClaimInput = { basis: 'stated' }
const inferred = (
  level: 'low' | 'medium' | 'high',
  rationale: string,
  derivedFrom: string[],
): ClaimInput => ({
  basis: 'inferred',
  confidence: { level, rationale },
  derivedFrom,
  method: 'sample-agent-reasoning',
  model: { provider: 'sample', model: 'illustrative-agent' },
})

// ---------- seeding ----------

export interface SeedResult {
  project: ProjectSummary
  created: boolean
}

export function seedSampleProject(services: KalythServices): SeedResult {
  const owner = ensureLocalOwner(services)
  const human: Caller = { principalId: owner.id, origin: 'human' }
  const analyzer = ensurePrincipal(services, 'dev-seed-analyzer', 'tool', 'Sample analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])
  const tool: Caller = { principalId: analyzer.id, origin: 'tool' }
  const agentPrincipal = ensurePrincipal(
    services,
    'dev-seed-agent',
    'agent',
    'Sample coding agent',
    AGENT_SCOPES,
  )
  const agent: Caller = { principalId: agentPrincipal.id, origin: 'agent' }

  const existing = must(services.listProjects(human), 'listProjects').projects.find(
    (p) => p.name === SAMPLE_PROJECT_NAME,
  )
  if (existing) return { project: existing, created: false }

  const project = must(
    services.createProject(human, {
      name: SAMPLE_PROJECT_NAME,
      description:
        'Hand-written sample model (two containers, modules, endpoints, data, libraries, a decision) for developing the workbench UI.',
    }),
    'createProject',
  )
  const projectId = project.id

  const propose = (caller: Caller, baseRevision: number, rationale: string, ops: Op[]) => {
    const out = must(
      services.proposeChange(caller, { projectId, baseRevision, rationale, ops }),
      `propose "${rationale}"`,
    )
    return out
  }
  const commit = (proposalId: string) =>
    must(services.commitProposal(human, { proposalId }), `commit ${proposalId}`)
  const ids = () => objectIds(services, human, projectId)

  // r1: structure, as the analyzer would propose it (observed, tool origin).
  const r1: Op[] = [
    evidence('$ev-readme', 'README.md', [1, 6], '# Fullstack app: FastAPI backend, React frontend'),
    evidence('$ev-compose', 'docker-compose.yml', [1, 40], 'services:\n  backend:\n  frontend:'),
    {
      op: 'createObject',
      ref: '$system',
      type: 'software.System',
      stance: 'asIs',
      attributes: { name: 'Fullstack app', description: 'Web application with an API and a SPA.' },
      claim: observed(['$ev-readme']),
    },
  ]
  for (const [key, technology] of [
    ['backend', 'Python, FastAPI'],
    ['frontend', 'TypeScript, React'],
  ] as const) {
    r1.push(
      evidence(
        `$ev-${key}`,
        `${key}/Dockerfile`,
        [1, 12],
        `FROM ${key === 'backend' ? 'python:3.12' : 'node:20'}`,
      ),
      {
        op: 'createObject',
        ref: `$${key}`,
        type: 'software.Container',
        stance: 'asIs',
        attributes: { name: key, technology },
        claim: observed(['$ev-compose', `$ev-${key}`]),
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$system',
        to: `$${key}`,
        stance: 'asIs',
        claim: observed(['$ev-compose']),
      },
    )
  }
  for (const m of MODULES) {
    const ref = `$m-${slug(m.path)}`
    const ev = `$ev-${slug(m.path)}`
    const groups = [[ev]]
    if (m.path === 'backend/app/core/config.py') {
      // A second, alternative support group whose excerpt matches the kernel's secret patterns, so
      // the UI shows two evidence groups and a redaction marker. Assembled at runtime so
      // repository secret scanners do not flag this fixture.
      const assignment = `${['SEC', 'RET', '_KEY'].join('')} = "${['sample', 'only', 'placeholder', 'value'].join('-')}"`
      r1.push(evidence('$ev-config-secret', m.path, [31, 31], assignment))
      groups.push(['$ev-config-secret', '$ev-readme'])
    }
    r1.push(
      evidence(ev, m.path, m.lines, m.excerpt),
      {
        op: 'createObject',
        ref,
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: m.path, language: m.language },
        claim: observed(...groups),
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: `$${m.container}`,
        to: ref,
        stance: 'asIs',
        claim: observed([ev]),
      },
    )
  }
  for (const [index, [from, to, line]] of MODULE_DEPS.entries()) {
    const ev = `$ev-dep-${index}`
    const target =
      to
        .split('/')
        .at(-1)
        ?.replace(/\.(py|tsx?)$/, '') ?? to
    const statement = from.endsWith('.py')
      ? `from .${target} import …`
      : `import { … } from './${target}'`
    r1.push(evidence(ev, from, [line, line], statement), {
      op: 'createRelation',
      type: 'dependsOn',
      from: `$m-${slug(from)}`,
      to: `$m-${slug(to)}`,
      stance: 'asIs',
      claim: observed([ev]),
    })
  }
  for (const e of ENDPOINTS) {
    const key = slug(`${e.method}-${e.path}`)
    r1.push(
      evidence(
        `$ev-ep-${key}`,
        e.module,
        [e.line, e.line + 3],
        `@router.${e.method.toLowerCase()}("${e.path.replace(/^\/api\/v1\/[a-z-]+/, '') || '/'}")`,
      ),
      {
        op: 'createObject',
        ref: `$ep-${key}`,
        type: 'software.Endpoint',
        stance: 'asIs',
        attributes: { method: e.method, path: e.path, handler: e.handler },
        claim: observed([`$ev-ep-${key}`]),
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$backend',
        to: `$ep-${key}`,
        stance: 'asIs',
        claim: observed([`$ev-ep-${key}`]),
      },
      {
        op: 'createRelation',
        type: 'exposes',
        from: `$m-${slug(e.module)}`,
        to: `$ep-${key}`,
        stance: 'asIs',
        claim: observed([`$ev-ep-${key}`]),
      },
    )
  }
  for (const [name, line] of [
    ['User', 40],
    ['Item', 60],
  ] as const) {
    r1.push(
      evidence(
        `$ev-entity-${name}`,
        'backend/app/models.py',
        [line, line + 10],
        `class ${name}(${name}Base, table=True):`,
      ),
      {
        op: 'createObject',
        ref: `$entity-${name}`,
        type: 'software.DataEntity',
        stance: 'asIs',
        attributes: { name, storage: 'postgresql' },
        claim: observed([`$ev-entity-${name}`]),
      },
    )
  }
  for (const lib of LIBRARIES) {
    const key = slug(lib.name)
    r1.push(
      evidence(
        `$ev-lib-${key}`,
        lib.manifest,
        [lib.line, lib.line],
        `"${lib.name}": "^${lib.version}"`,
      ),
      {
        op: 'createObject',
        ref: `$lib-${key}`,
        type: 'software.Library',
        stance: 'asIs',
        attributes: { name: lib.name, version: lib.version, ecosystem: lib.ecosystem },
        claim: observed([`$ev-lib-${key}`]),
      },
      {
        op: 'createRelation',
        type: 'dependsOn',
        from: `$${lib.from}`,
        to: `$lib-${key}`,
        stance: 'asIs',
        // Two alternative support groups: the manifest alone, or the lockfile plus an import.
        claim: observed(
          [`$ev-lib-${key}`],
          ...(lib.name === 'fastapi' ? [['$ev-backend', '$ev-backend-app-main-py']] : []),
        ),
      },
    )
  }
  const p1 = propose(
    tool,
    0,
    'Sample analyzer: system, containers, modules, endpoints, data and libraries',
    r1,
  )
  commit(p1.proposalId)

  // r2: decisions, intent and a correction by the owner (stated, human origin).
  let o = ids()
  const navbar = id(o, 'frontend/src/components/Common/Navbar.tsx')
  const navbarRelations = must(
    services.queryRelations(human, { projectId, to: navbar }),
    'relations to Navbar',
  ).relations.concat(
    must(services.queryRelations(human, { projectId, from: navbar }), 'relations from Navbar')
      .relations,
  )
  const p2 = propose(
    human,
    1,
    'Owner: session-token decision, intended worker, and a removed module',
    [
      {
        op: 'createObject',
        ref: '$decision',
        type: 'core.Decision',
        stance: 'toBe',
        attributes: {
          title: 'Where does the web client keep its session token?',
          question:
            'The SPA authenticates with a bearer token. Choose where it lives between requests, given XSS exposure and logout behaviour.',
        },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$alt-storage',
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: {
          title: 'Bearer token in localStorage',
          summary:
            'Keep the current approach: the token is read by the generated client on each call.',
          tradeoffs:
            'Simple and already implemented; readable by any script that runs in the page.',
        },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$alt-cookie',
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: {
          title: 'HttpOnly session cookie',
          summary:
            'The backend sets an HttpOnly, SameSite=Strict cookie; the client stops handling tokens.',
          tradeoffs: 'Not readable by scripts; needs CSRF protection and backend changes to login.',
        },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: '$alt-storage',
        to: '$decision',
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: '$alt-cookie',
        to: '$decision',
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'decides',
        from: '$decision',
        to: id(o, 'frontend'),
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'decides',
        from: '$decision',
        to: id(o, 'backend/app/api/routes/login.py'),
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$requirement',
        type: 'core.Requirement',
        stance: 'toBe',
        attributes: {
          title: 'Sign in with email and password',
          statement:
            'Users sign in with email and password and stay signed in across page reloads.',
          priority: 'must',
        },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$constraint',
        type: 'core.Constraint',
        stance: 'toBe',
        attributes: {
          title: 'Never log credentials',
          statement: 'Passwords, tokens and cookies must never be written to logs.',
          severity: 'must',
        },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'satisfies',
        from: '$alt-cookie',
        to: '$requirement',
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'constrains',
        from: '$constraint',
        to: id(o, 'backend'),
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$worker',
        type: 'software.Container',
        stance: 'toBe',
        attributes: {
          name: 'worker',
          technology: 'Python',
          description: 'Intended background worker for sending email outside the request path.',
        },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: id(o, 'Fullstack app'),
        to: '$worker',
        stance: 'toBe',
        claim: stated,
      },
      ...navbarRelations.map(
        (r): Op => ({
          op: 'retireRelation',
          id: r.id,
          reason: 'Navbar.tsx was removed from the sample',
        }),
      ),
      { op: 'retireObject', id: navbar, reason: 'Navbar.tsx was removed from the sample' },
    ],
  )
  commit(p2.proposalId)

  // r3: data access inferred by an agent from endpoints and handler modules.
  o = ids()
  const access: [string, 'reads' | 'writes', string, 'low' | 'medium' | 'high'][] = [
    ['POST /api/v1/login/access-token', 'reads', 'User', 'high'],
    ['GET /api/v1/users/me', 'reads', 'User', 'high'],
    ['GET /api/v1/items/', 'reads', 'Item', 'high'],
    ['POST /api/v1/items/', 'writes', 'Item', 'high'],
    ['DELETE /api/v1/items/{id}', 'writes', 'Item', 'medium'],
  ]
  const p3 = propose(agent, 2, 'Agent: endpoints read and write the User and Item tables', [
    ...access.map(
      ([endpoint, type, entity, level]): Op => ({
        op: 'createRelation',
        type,
        from: id(o, endpoint),
        to: id(o, entity),
        stance: 'asIs',
        claim: inferred(
          level,
          `The handler for ${endpoint} queries the ${entity} model through the session dependency.`,
          [id(o, endpoint), id(o, entity)],
        ),
      }),
    ),
    {
      op: 'createRelation',
      type: 'writes',
      from: id(o, 'backend/app/crud.py'),
      to: id(o, 'User'),
      stance: 'asIs',
      claim: inferred('medium', 'create_user adds a User to the session and commits.', [
        id(o, 'backend/app/crud.py'),
        id(o, 'User'),
      ]),
    },
  ])
  commit(p3.proposalId)

  // r4 and r5: a stale agent proposal and a rebased one, both based on r3.
  o = ids()
  const item = id(o, 'Item')
  const agentStorage = propose(agent, 3, 'Agent: Item storage is PostgreSQL 16', [
    {
      op: 'updateObject',
      id: item,
      set: { storage: 'postgresql 16' },
      claim: inferred('low', 'docker-compose pins postgres:16 (guess from the image tag).', [
        id(o, 'backend/app/core/db.py'),
      ]),
    },
  ])
  const question = propose(agent, 3, 'Agent: open question about item pagination', [
    {
      op: 'createObject',
      ref: '$q',
      type: 'core.Question',
      stance: 'asIs',
      attributes: {
        text: 'Is GET /api/v1/items/ paginated on the server, or does the client fetch everything?',
        inquiryRole: 'model-sensitive',
      },
      claim: inferred('medium', 'read_items accepts skip and limit parameters.', [
        id(o, 'GET /api/v1/items/'),
      ]),
    },
    {
      op: 'createRelation',
      type: 'concerns',
      from: '$q',
      to: id(o, 'GET /api/v1/items/'),
      stance: 'asIs',
      claim: stated,
    },
  ])
  const ownerStorage = propose(human, 3, 'Owner: Item lives in PostgreSQL 17', [
    { op: 'updateObject', id: item, set: { storage: 'postgresql 17' }, claim: stated },
  ])
  commit(ownerStorage.proposalId)
  const stale = services.commitProposal(human, { proposalId: agentStorage.proposalId })
  if (stale.ok) throw new Error('expected the agent storage proposal to be stale')
  commit(question.proposalId)

  // Left for review: a rejected, an invalid and a pending agent proposal.
  o = ids()
  const wrong = propose(agent, 5, 'Agent: crud.py uses axios', [
    {
      op: 'createRelation',
      type: 'dependsOn',
      from: id(o, 'backend/app/crud.py'),
      to: id(o, 'axios'),
      stance: 'asIs',
      claim: inferred('low', 'Both handle HTTP requests.', [id(o, 'backend/app/crud.py')]),
    },
  ])
  must(
    services.rejectProposal(human, {
      proposalId: wrong.proposalId,
      reason:
        'crud.py is Python and axios is a frontend npm package; the import evidence is from request.ts.',
    }),
    'reject',
  )
  propose(agent, 5, 'Agent: login endpoint writes User (missing confidence)', [
    {
      op: 'createRelation',
      type: 'writes',
      from: id(o, 'POST /api/v1/login/access-token'),
      to: id(o, 'User'),
      stance: 'asIs',
      claim: { basis: 'inferred', derivedFrom: [id(o, 'POST /api/v1/login/access-token')] },
    },
  ])
  propose(agent, 5, 'Agent: the frontend depends on the backend through the generated API client', [
    {
      op: 'createRelation',
      type: 'dependsOn',
      from: id(o, 'frontend'),
      to: id(o, 'backend'),
      stance: 'asIs',
      claim: inferred(
        'high',
        'sdk.gen.ts calls /api/v1 routes that backend/app/api/main.py registers; the client is generated from the backend OpenAPI schema.',
        [id(o, 'frontend/src/client/sdk.gen.ts'), id(o, 'GET /api/v1/items/')],
      ),
    },
    {
      op: 'createObject',
      ref: '$assertion',
      type: 'core.Assertion',
      stance: 'asIs',
      attributes: {
        statement: 'The frontend client must be regenerated whenever backend routes change.',
      },
      claim: inferred('medium', 'The client is generated code with no runtime schema check.', [
        id(o, 'frontend/src/client/sdk.gen.ts'),
      ]),
    },
    {
      op: 'createRelation',
      type: 'concerns',
      from: '$assertion',
      to: id(o, 'frontend'),
      stance: 'asIs',
      claim: stated,
    },
  ])

  const final = must(services.listProjects(human), 'listProjects').projects.find(
    (p) => p.id === projectId,
  )
  return { project: final ?? project, created: true }
}

/** Maps readable keys (module path, "METHOD path", name or title) to object ids at head. */
function objectIds(services: KalythServices, caller: Caller, projectId: string) {
  const { objects } = must(
    services.queryObjects(caller, { projectId, limit: 1000 }),
    'queryObjects',
  )
  const map = new Map<string, string>()
  for (const object of objects) {
    const a = object.attributes as Record<string, unknown>
    const key =
      object.type === 'software.Endpoint'
        ? `${String(a.method)} ${String(a.path)}`
        : String(a.path ?? a.name ?? a.title ?? object.id)
    map.set(key, object.id)
  }
  return map
}

function id(map: Map<string, string>, key: string): string {
  const value = map.get(key)
  if (!value) throw new Error(`seed: no object for ${key}`)
  return value
}
