import { posix } from 'node:path'
import type { Node } from './parsers.ts'
import type { Lines } from './python.ts'

export interface TsImport {
  source: string
  kind: 'import' | 're-export' | 'dynamic'
  typeOnly: boolean
  lines: Lines
}

const lines = (n: Node): Lines => ({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 })

function specifier(n: Node | null | undefined): string | undefined {
  if (n?.type !== 'string') return undefined
  return n.namedChildren.find((c) => c.type === 'string_fragment')?.text ?? n.text.slice(1, -1)
}

/** Static imports, re-exports, and dynamic import()/require() calls with literal specifiers. */
export function extractTypeScript(root: Node): TsImport[] {
  const out: TsImport[] = []
  for (const n of root.namedChildren) {
    if (n.type === 'import_statement') {
      const requireClause = n.namedChildren.find((c) => c.type === 'import_require_clause')
      const source = specifier(
        requireClause ? requireClause.childForFieldName('source') : n.childForFieldName('source'),
      )
      if (source)
        out.push({
          source,
          kind: 'import',
          typeOnly: n.children.some((c) => c.type === 'type'),
          lines: lines(n),
        })
    } else if (n.type === 'export_statement') {
      const source = specifier(n.childForFieldName('source'))
      if (source) out.push({ source, kind: 're-export', typeOnly: false, lines: lines(n) })
    }
  }
  const walk = (n: Node) => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function')
      if (fn && (fn.type === 'import' || fn.text === 'require')) {
        const source = specifier(n.childForFieldName('arguments')?.namedChildren[0])
        if (source) out.push({ source, kind: 'dynamic', typeOnly: false, lines: lines(n) })
      }
    }
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

export type TsResolution =
  | { kind: 'repo'; file: string }
  | { kind: 'external'; pkg: string }
  | { kind: 'builtin' | 'unresolved' }

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'url',
  'util',
  'worker_threads',
  'zlib',
])

/** Removes comments and trailing commas so tsconfig.json can be read as JSON. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

interface TsConfig {
  dir: string
  baseUrl: string | null
  paths: Record<string, string[]> | null
}

/** Resolves module specifiers: relative paths, tsconfig `paths` aliases, then package names. */
export function makeTypeScriptResolver(
  files: readonly string[],
  readText: (path: string) => string | undefined,
) {
  const fileSet = new Set(files)
  const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p))
  const configs = new Map<string, TsConfig>()
  for (const f of files.filter((x) => posix.basename(x) === 'tsconfig.json')) {
    try {
      const json = JSON.parse(stripJsonc(readText(f) ?? '{}')) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
      }
      configs.set(dirOf(f), {
        dir: dirOf(f),
        baseUrl: json.compilerOptions?.baseUrl ?? null,
        paths: json.compilerOptions?.paths ?? null,
      })
    } catch {
      // An unreadable tsconfig means aliases stay unresolved; the coverage note reports it.
    }
  }
  const configFor = (file: string): TsConfig | undefined => {
    let d = dirOf(file)
    for (;;) {
      const c = configs.get(d)
      if (c) return c
      if (d === '') return undefined
      d = dirOf(d)
    }
  }
  const tryFile = (p: string): string | undefined => {
    if (p.endsWith('.js') && fileSet.has(`${p.slice(0, -3)}.ts`)) return `${p.slice(0, -3)}.ts`
    if (p.endsWith('.js') && fileSet.has(`${p.slice(0, -3)}.tsx`)) return `${p.slice(0, -3)}.tsx`
    for (const ext of ['', '.ts', '.tsx', '.d.ts']) if (fileSet.has(p + ext)) return p + ext
    for (const ext of ['.ts', '.tsx'])
      if (fileSet.has(`${p}/index${ext}`)) return `${p}/index${ext}`
    return undefined
  }

  return (file: string, source: string): TsResolution => {
    if (source.startsWith('.')) {
      const hit = tryFile(posix.normalize(posix.join(dirOf(file), source)))
      return hit ? { kind: 'repo', file: hit } : { kind: 'unresolved' }
    }
    const config = configFor(file)
    if (config?.paths) {
      const baseDir = posix.join(config.dir, config.baseUrl ?? '.')
      for (const [pattern, targets] of Object.entries(config.paths)) {
        const star = pattern.indexOf('*')
        const matches =
          star < 0
            ? source === pattern
            : source.startsWith(pattern.slice(0, star)) && source.endsWith(pattern.slice(star + 1))
        if (!matches) continue
        const middle =
          star < 0 ? '' : source.slice(star, source.length - (pattern.length - star - 1))
        for (const target of targets) {
          const hit = tryFile(posix.normalize(posix.join(baseDir, target.replace('*', middle))))
          if (hit) return { kind: 'repo', file: hit }
        }
      }
    }
    if (source.startsWith('node:') || NODE_BUILTINS.has(source.split('/')[0] ?? ''))
      return { kind: 'builtin' }
    // Absolute specifiers ("/assets/logo.svg") are served files, not packages.
    if (source.startsWith('/')) return { kind: 'unresolved' }
    const pkg = source.startsWith('@')
      ? source.split('/').slice(0, 2).join('/')
      : (source.split('/')[0] ?? '')
    return pkg ? { kind: 'external', pkg } : { kind: 'unresolved' }
  }
}
