import { posix } from 'node:path'
import { MAX_CALL_DEPTH, PythonModel, type SourceRef } from './data-access.ts'
import {
  ANALYZER,
  type EvidenceSpan,
  FactBuilder,
  type ObjectFact,
  type RelationFact,
} from './facts.ts'
import type { GitRepository } from './git.ts'
import { countSyntaxErrors, languageOf, loadParsers } from './parsers.ts'
import {
  extractPython,
  makePythonResolver,
  type PyClass,
  type PyFile,
  type PyRoute,
  type PyType,
  type Value,
} from './python.ts'
import { extractTypeScript, makeTypeScriptResolver } from './typescript.ts'

export interface AnalysisResult {
  repo: string
  commit: string
  ref?: string
  /** Git blob of every file used as evidence, keyed by path. Becomes the source snapshot. */
  files: Record<string, string>
  objects: ObjectFact[]
  relations: RelationFact[]
  coverage: string
  limitations: string[]
  stats: Record<string, number>
}

const MANIFESTS = new Set(['pyproject.toml', 'package.json', 'tsconfig.json'])
const MAX_FILE_BYTES = 512 * 1024
const MAX_PARAMETERS = 100

export interface AnalyzeOptions {
  git: GitRepository
  /** Stable repository identifier, for example "github.com/fastapi/full-stack-fastapi-template". */
  repo: string
  ref: string
}

/** Static analysis of one commit. Reads git objects only; never executes repository code. */
export async function analyzeRepository(options: AnalyzeOptions): Promise<AnalysisResult> {
  const { git, repo } = options
  const commit = git.resolveCommit(options.ref)
  const limitations: string[] = []
  const stats: Record<string, number> = {}
  const bump = (k: string, n = 1) => {
    stats[k] = (stats[k] ?? 0) + n
  }

  const tree = git.listTree(commit)
  const skippedLinks = tree.filter((e) => e.mode === '120000' || e.mode === '160000').length
  const wanted = tree.filter((e) => {
    if (e.type !== 'blob' || e.mode === '120000') return false
    return languageOf(e.path) !== undefined || MANIFESTS.has(posix.basename(e.path))
  })
  const oversized = wanted.filter((e) => e.size > MAX_FILE_BYTES)
  const selected = wanted.filter((e) => e.size <= MAX_FILE_BYTES)
  const blobs = git.readBlobs(selected.map((e) => e.sha))
  const files = new Map<string, { blobSha: string; text: string }>()
  for (const e of selected) {
    const blob = blobs.get(e.sha)
    if (blob) files.set(e.path, { blobSha: e.sha, text: blob.toString('utf8') })
  }
  if (skippedLinks > 0) limitations.push(`${skippedLinks} symlinks or submodules were not followed`)
  if (oversized.length > 0)
    limitations.push(`${oversized.length} source files over 512 KB were skipped`)

  const paths = [...files.keys()].sort()
  const facts = new FactBuilder(files)
  const parsers = await loadParsers()
  const text = (p: string) => files.get(p)?.text

  // ---------- system and containers ----------
  const manifestPaths = paths.filter(
    (p) => posix.basename(p) === 'pyproject.toml' || posix.basename(p) === 'package.json',
  )
  const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p))
  const manifestDirs = [...new Set(manifestPaths.map(dirOf))]
  const containerDirs =
    manifestDirs.length > 1 ? manifestDirs.filter((d) => d !== '') : manifestDirs
  const systemKey = 'system'
  const systemName =
    repo
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') || repo
  for (const manifest of manifestPaths.slice(0, 8)) {
    facts.object(
      systemKey,
      'software.System',
      { name: systemName, description: `Repository ${repo}` },
      [facts.wholeFile(manifest)],
    )
  }
  if (manifestPaths.length === 0)
    limitations.push('no pyproject.toml or package.json found; containers not identified')

  const containerKey = (dir: string) => `container:${dir || '.'}`
  for (const dir of containerDirs) {
    const own = manifestPaths.filter((m) => dirOf(m) === dir)
    const technology = [
      own.some((m) => m.endsWith('pyproject.toml')) ? 'Python' : null,
      own.some((m) => m.endsWith('package.json')) ? 'Node.js' : null,
    ]
      .filter(Boolean)
      .join(', ')
    for (const m of own) {
      const span = facts.wholeFile(m)
      facts.object(
        containerKey(dir),
        'software.Container',
        { name: dir || systemName, technology },
        [span],
      )
      facts.relation('contains', systemKey, containerKey(dir), [span])
    }
  }
  const containerOf = (path: string) =>
    containerDirs
      .filter((d) => d === '' || path.startsWith(`${d}/`))
      .sort((a, b) => b.length - a.length)[0]
  const manifestSpanFor = (dir: string) => {
    const m = manifestPaths.find((p) => dirOf(p) === dir)
    return m ? facts.wholeFile(m) : undefined
  }

  // ---------- modules ----------
  const moduleKey = (path: string) => `module:${path}`
  const sourcePaths = paths.filter((p) => languageOf(p) !== undefined)
  const pyFiles = new Map<string, PyFile>()
  const tsImports = new Map<string, ReturnType<typeof extractTypeScript>>()
  for (const path of sourcePaths) {
    const language = languageOf(path)
    if (!language) continue
    const root = parsers.parse(language, text(path) ?? '')
    const errors = countSyntaxErrors(root)
    if (errors > 0) {
      bump('filesWithSyntaxErrors')
      limitations.push(`${path}: ${errors} syntax error node(s); extraction there may be partial`)
    }
    bump(language === 'python' ? 'pythonFiles' : 'typescriptFiles')
    const fileSpan = facts.wholeFile(path)
    facts.object(
      moduleKey(path),
      'software.Module',
      { path, language: language === 'python' ? 'python' : 'typescript' },
      [fileSpan],
    )
    const container = containerOf(path)
    if (container !== undefined) {
      const manifest = manifestSpanFor(container)
      facts.relation(
        'contains',
        containerKey(container),
        moduleKey(path),
        manifest ? [manifest, fileSpan] : [fileSpan],
      )
    } else {
      facts.relation('contains', systemKey, moduleKey(path), [fileSpan])
    }
    if (language === 'python') pyFiles.set(path, extractPython(root))
    else tsImports.set(path, extractTypeScript(root))
  }

  // ---------- Python imports, libraries, routes and tables ----------
  const resolvePy = makePythonResolver(paths)
  const importMaps = new Map<string, Map<string, { file: string; symbol?: string }>>()
  for (const [path, py] of pyFiles) {
    const importMap = new Map<string, { file: string; symbol?: string }>()
    for (const imp of py.imports) {
      const span = facts.span(path, imp.lines.start, imp.lines.end, { excerpt: true })
      for (const { name, alias } of imp.names) {
        const res = resolvePy(path, imp, imp.kind === 'import' ? '' : name)
        if (res.kind === 'repo') {
          facts.relation('dependsOn', moduleKey(path), moduleKey(res.file), [span])
          const local = alias ?? (imp.kind === 'import' ? name.split('.')[0] : name)
          if (local && local !== '*') {
            importMap.set(
              local,
              res.via === 'symbol' ? { file: res.file, symbol: name } : { file: res.file },
            )
          }
        } else if (res.kind === 'external' && res.top) {
          const key = `library:pypi:${res.top}`
          facts.object(key, 'software.Library', { name: res.top, ecosystem: 'pypi' }, [span])
          facts.relation('dependsOn', moduleKey(path), key, [span])
        } else if (res.kind === 'unresolved') bump('unresolvedPythonImports')
      }
    }
    importMaps.set(path, importMap)
  }

  const constants = new Map<string, Set<string>>()
  for (const py of pyFiles.values())
    for (const c of py.constants)
      constants.set(c.name, (constants.get(c.name) ?? new Set()).add(c.value))
  const fold = (v: Value): string => {
    if ('literal' in v) return v.literal
    const name = v.expr.split('.').pop() ?? v.expr
    const values = constants.get(name)
    if (values?.size === 1) return [...values][0] as string
    bump('unfoldedRoutePrefixes')
    return `{${v.expr}}`
  }

  type RouterRef = { file: string; variable: string }
  const routerOf = (r: RouterRef) =>
    pyFiles.get(r.file)?.routers.find((x) => x.variable === r.variable)
  const targetOf = (file: string, text: string): RouterRef | undefined => {
    const parts = text.split('.')
    const imports = importMaps.get(file)
    if (parts.length === 1) {
      if (pyFiles.get(file)?.routers.some((r) => r.variable === text))
        return { file, variable: text }
      const imported = imports?.get(text)
      return imported?.symbol ? { file: imported.file, variable: imported.symbol } : undefined
    }
    const head = imports?.get(parts[0] ?? '')
    return head && !head.symbol
      ? { file: head.file, variable: parts[parts.length - 1] ?? '' }
      : undefined
  }
  const mounts = new Map<string, { parent: RouterRef; prefix: string; conditional: boolean }[]>()
  for (const [file, py] of pyFiles) {
    for (const inc of py.includes) {
      const child = targetOf(file, inc.target)
      const parent = targetOf(file, inc.receiver)
      if (!child || !parent) {
        bump('unresolvedIncludes')
        continue
      }
      const id = `${child.file}#${child.variable}`
      mounts.set(id, [
        ...(mounts.get(id) ?? []),
        { parent, prefix: fold(inc.prefix), conditional: inc.conditional },
      ])
    }
  }
  /** Full prefixes at which a router is served, or undefined when it is not mounted on an app. */
  const prefixesOf = (
    r: RouterRef,
    depth = 0,
  ): { prefix: string; conditional: boolean }[] | undefined => {
    const router = routerOf(r)
    if (!router || depth > 12) return undefined
    if (router.kind === 'FastAPI') return [{ prefix: '', conditional: false }]
    const own = fold(router.prefix)
    const result: { prefix: string; conditional: boolean }[] = []
    for (const m of mounts.get(`${r.file}#${r.variable}`) ?? []) {
      for (const p of prefixesOf(m.parent, depth + 1) ?? []) {
        result.push({
          prefix: p.prefix + m.prefix + own,
          conditional: p.conditional || m.conditional,
        })
      }
    }
    return result.length > 0 ? result : undefined
  }

  // Data access, entity references and endpoint parameters (ADR 0021).
  const isTable = (cls: PyClass) => cls.keywords.table === 'True'
  const model = new PythonModel(pyFiles, importMaps, (_file, cls) =>
    isTable(cls) ? `entity:${cls.name}` : undefined,
  )
  const spanOf = (ref: SourceRef) =>
    facts.span(ref.file, ref.lines.start, ref.lines.end, { symbol: ref.symbol, excerpt: true })

  // FastAPI serves "/items/" and "/items" as different paths, so trailing slashes are kept.
  const joinPath = (...parts: string[]) => `/${parts.join('')}`.replace(/\/{2,}/g, '/')
  for (const [file, py] of pyFiles) {
    for (const route of py.routes) addRoute(file, route)
    for (const cls of py.classes) {
      if (!isTable(cls)) continue
      const span = facts.span(file, cls.lines.start, cls.lines.end, {
        symbol: cls.name,
        excerpt: true,
      })
      const key = `entity:${cls.name}`
      const fields = entityFields(cls, py.classes)
      facts.object(
        key,
        'software.DataEntity',
        {
          name: cls.name,
          storage: 'SQL table (SQLModel)',
          ...(fields.length > 0 ? { fields } : {}),
        },
        [span],
      )
      facts.relation('contains', moduleKey(file), key, [span])
      bump('dataEntities')
    }
  }
  function addRoute(file: string, route: PyRoute) {
    const ref = { file, variable: route.receiver }
    const routePath = fold(route.path)
    let mountsFound = prefixesOf(ref)
    if (!mountsFound) {
      bump('unmountedRoutes')
      mountsFound = [
        {
          prefix: routerOf(ref) ? fold((routerOf(ref) as { prefix: Value }).prefix) : '',
          conditional: false,
        },
      ]
    }
    const span = facts.span(file, route.lines.start, route.lines.end, {
      symbol: route.handler,
      excerpt: true,
    })
    const root: SourceRef = { file, lines: route.lines, symbol: route.handler }
    const accesses = model.accesses(file, route.fn, root)
    for (const m of mountsFound) {
      const path = joinPath(m.prefix, routePath)
      const key = `endpoint:${route.method} ${path}`
      const parameters = model.parameters(file, route.fn, path).slice(0, MAX_PARAMETERS)
      facts.object(
        key,
        'software.Endpoint',
        { method: route.method, path, handler: `${file}:${route.handler}`, parameters },
        [span],
      )
      facts.relation('exposes', moduleKey(file), key, [span])
      for (const access of accesses)
        facts.relation(access.kind, key, access.entity, access.support.map(spanOf))
      if (m.conditional) bump('conditionallyMountedRoutes')
      bump('endpoints')
    }
  }

  const entityReferences = model.references()
  for (const ref of entityReferences.references)
    facts.relation('references', ref.from, ref.to, [spanOf(ref.support)])
  if (entityReferences.unresolved > 0)
    bump('unresolvedEntityReferences', entityReferences.unresolved)
  if (model.unfollowed.size > 0) bump('unfollowedCalls', model.unfollowed.size)

  // ---------- TypeScript imports and libraries ----------
  const resolveTs = makeTypeScriptResolver(paths, text)
  for (const [path, imports] of tsImports) {
    for (const imp of imports) {
      const span: EvidenceSpan = facts.span(path, imp.lines.start, imp.lines.end, { excerpt: true })
      const res = resolveTs(path, imp.source)
      if (res.kind === 'repo')
        facts.relation('dependsOn', moduleKey(path), moduleKey(res.file), [span])
      else if (res.kind === 'external') {
        const key = `library:npm:${res.pkg}`
        facts.object(key, 'software.Library', { name: res.pkg, ecosystem: 'npm' }, [span])
        facts.relation('dependsOn', moduleKey(path), key, [span])
      } else if (res.kind === 'unresolved') bump('unresolvedTypeScriptImports')
    }
  }

  const objects = [...facts.objects.values()]
  const relations = [...facts.relations.values()].filter(
    (r) => facts.objects.has(r.from) && facts.objects.has(r.to),
  )
  for (const type of ['reads', 'writes', 'references'])
    stats[`${type}Relations`] = relations.filter((r) => r.type === type).length
  for (const [k, n] of Object.entries({
    unmountedRoutes: 'routes not reachable from a FastAPI app; their paths are relative',
    conditionallyMountedRoutes:
      'routes mounted only under a condition (for example a settings check)',
    unfoldedRoutePrefixes:
      'route prefixes that could not be folded to a literal and are shown as {expression}',
    unresolvedPythonImports: 'relative Python imports that did not resolve to a file',
    unresolvedTypeScriptImports:
      'TypeScript imports that did not resolve to a source file (for example served assets)',
    unresolvedIncludes: 'include_router calls whose router could not be identified',
    unresolvedEntityReferences:
      'foreign keys or relationships of SQLModel tables whose target entity could not be identified',
    unfollowedCalls: `functions ${MAX_CALL_DEPTH} calls below a route handler whose own calls were not followed for data access`,
  })) {
    if (stats[k]) limitations.push(`${stats[k]} ${n}`)
  }
  const usedFiles: Record<string, string> = {}
  for (const p of paths) usedFiles[p] = (files.get(p) as { blobSha: string }).blobSha

  return {
    repo,
    commit,
    ...(options.ref !== commit ? { ref: options.ref } : {}),
    files: usedFiles,
    objects,
    relations,
    coverage:
      `${ANALYZER.tool} ${ANALYZER.toolVersion}: static tree-sitter analysis of ${stats.pythonFiles ?? 0} Python and ` +
      `${stats.typescriptFiles ?? 0} TypeScript files tracked at ${commit}, plus pyproject.toml, package.json and tsconfig.json manifests. ` +
      'Covers modules, imports, external libraries, FastAPI routes with their request parameters, and SQLModel tables. ' +
      `Reads and writes of tables by routes are taken from SQLModel and SQLAlchemy call patterns in each handler and in repository functions it calls, up to ${MAX_CALL_DEPTH} levels deep; ` +
      'FastAPI dependencies, loops and untyped variables are not followed. References between tables come from foreign keys and scalar relationships. ' +
      'No code was executed; runtime behaviour is not observed.',
    limitations,
    stats: { ...stats, objects: objects.length, relations: relations.length },
  }
}

const MAX_FIELDS = 200

/** A Python annotation as written, for example `uuid.UUID`, `str | None` or `list[Item]`. */
function typeLabel(t: PyType): string {
  switch (t.kind) {
    case 'name':
    case 'forward':
      return t.name
    case 'generic':
      return `${t.name}[${t.args.map(typeLabel).join(', ')}]`
    case 'union':
      return t.options.map(typeLabel).join(' | ')
    case 'none':
      return 'None'
    default:
      return '?'
  }
}

/**
 * The fields of a table class as declared, including those of base classes in the same module
 * (SQLModel's `UserBase` pattern), each with its annotation, the foreign key it holds and the
 * entity a relationship points at. Later declarations override earlier ones of the same name.
 */
function entityFields(cls: PyClass, classes: readonly PyClass[]): Record<string, string>[] {
  const byName = new Map(classes.map((c) => [c.name, c]))
  const seen = new Set<string>()
  const ordered: PyClass[] = []
  const visit = (c: PyClass) => {
    if (seen.has(c.name)) return
    seen.add(c.name)
    for (const base of c.bases) {
      const b = byName.get(base)
      if (b) visit(b)
    }
    ordered.push(c)
  }
  visit(cls)
  const fields = new Map<string, Record<string, string>>()
  for (const c of ordered) {
    for (const f of c.fields) {
      const field: Record<string, string> = { name: f.name }
      if (f.type) field.type = typeLabel(f.type)
      const fk = f.foreignKeys[0]
      if (fk) field.references = 'literal' in fk ? fk.literal : fk.expr
      const target = f.relationship ? (f.type ?? f.relationship.target) : null
      if (target) field.relationship = typeLabel(target)
      fields.delete(f.name)
      fields.set(f.name, field)
    }
  }
  return [...fields.values()].slice(0, MAX_FIELDS)
}
