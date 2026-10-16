import { posix } from 'node:path'
import type { Node } from './parsers.ts'
import { PYTHON_STDLIB } from './python-stdlib.ts'

export interface Lines {
  start: number
  end: number
}

const lines = (n: Node): Lines => ({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 })

/** A literal string, or the source text of a non-literal expression. */
export type Value = { literal: string } | { expr: string }

export interface PyImport {
  kind: 'import' | 'from'
  module: string
  level: number
  names: { name: string; alias: string | null }[]
  lines: Lines
}

export interface PyRouter {
  variable: string
  kind: 'APIRouter' | 'FastAPI'
  prefix: Value
  lines: Lines
}

export interface PyRoute {
  receiver: string
  method: string
  path: Value
  handler: string
  lines: Lines
}

export interface PyInclude {
  receiver: string
  target: string
  prefix: Value
  conditional: boolean
  lines: Lines
}

export interface PyClass {
  name: string
  bases: string[]
  keywords: Record<string, string>
  lines: Lines
}

export interface PyFile {
  imports: PyImport[]
  routers: PyRouter[]
  routes: PyRoute[]
  includes: PyInclude[]
  classes: PyClass[]
  constants: { name: string; value: string }[]
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head'])

function stringValue(n: Node | null): string | undefined {
  if (!n) return undefined
  if (n.type === 'string') {
    if (n.children.some((c) => c.type === 'interpolation')) return undefined
    const start = n.children.find((c) => c.type === 'string_start')?.text ?? ''
    if (/b/i.test(start)) return undefined
    return n.children
      .filter((c) => c.type === 'string_content')
      .map((c) => c.text)
      .join('')
  }
  if (n.type === 'concatenated_string') {
    const parts = n.namedChildren.filter((c) => c.type === 'string').map(stringValue)
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined
  }
  return undefined
}

const toValue = (n: Node | null | undefined): Value => {
  if (!n) return { literal: '' }
  const s = stringValue(n)
  return s === undefined ? { expr: n.text } : { literal: s }
}

function callArguments(call: Node): { positional: Node[]; keywords: Map<string, Node> } {
  const positional: Node[] = []
  const keywords = new Map<string, Node>()
  const args = call.childForFieldName('arguments')
  if (args?.type === 'argument_list') {
    for (const a of args.namedChildren) {
      if (a.type === 'comment' || a.type === 'list_splat' || a.type === 'dictionary_splat') continue
      if (a.type === 'keyword_argument') {
        const name = a.childForFieldName('name')
        const value = a.childForFieldName('value')
        if (name && value) keywords.set(name.text, value)
      } else positional.push(a)
    }
  }
  return { positional, keywords }
}

/** Static facts from one Python file's syntax tree. Nothing is evaluated. */
export function extractPython(root: Node): PyFile {
  const out: PyFile = {
    imports: [],
    routers: [],
    routes: [],
    includes: [],
    classes: [],
    constants: [],
  }

  const visit = (n: Node, inFunction: boolean, conditional: boolean): void => {
    switch (n.type) {
      case 'import_statement': {
        for (const c of n.childrenForFieldName('name')) {
          const name =
            c.type === 'aliased_import' ? (c.childForFieldName('name')?.text ?? '') : c.text
          const alias =
            c.type === 'aliased_import' ? (c.childForFieldName('alias')?.text ?? null) : null
          out.imports.push({
            kind: 'import',
            module: name,
            level: 0,
            names: [{ name, alias }],
            lines: lines(n),
          })
        }
        return
      }
      case 'import_from_statement': {
        const moduleNode = n.childForFieldName('module_name')
        let level = 0
        let module = ''
        if (moduleNode?.type === 'relative_import') {
          level = (moduleNode.children.find((c) => c.type === 'import_prefix')?.text ?? '').length
          module = moduleNode.children.find((c) => c.type === 'dotted_name')?.text ?? ''
        } else if (moduleNode) module = moduleNode.text
        const names = n.childrenForFieldName('name').map((c) =>
          c.type === 'aliased_import'
            ? {
                name: c.childForFieldName('name')?.text ?? '',
                alias: c.childForFieldName('alias')?.text ?? null,
              }
            : { name: c.text, alias: null },
        )
        if (n.children.some((c) => c.type === 'wildcard_import'))
          names.push({ name: '*', alias: null })
        out.imports.push({ kind: 'from', module, level, names, lines: lines(n) })
        return
      }
      case 'assignment': {
        const left = n.childForFieldName('left')
        const right = n.childForFieldName('right')
        if (left?.type === 'identifier' && right?.type === 'call') {
          const fn = right.childForFieldName('function')?.text ?? ''
          const base = fn.split('.').pop()
          if (base === 'APIRouter' || base === 'FastAPI') {
            const { keywords } = callArguments(right)
            out.routers.push({
              variable: left.text,
              kind: base,
              prefix: toValue(keywords.get('prefix')),
              lines: lines(n),
            })
          }
        }
        if (left?.type === 'identifier' && !inFunction) {
          const value = stringValue(right)
          if (value !== undefined) out.constants.push({ name: left.text, value })
        }
        break
      }
      case 'call': {
        const fn = n.childForFieldName('function')
        if (
          fn?.type === 'attribute' &&
          fn.childForFieldName('attribute')?.text === 'include_router'
        ) {
          const { positional, keywords } = callArguments(n)
          const target = positional[0]?.text ?? keywords.get('router')?.text
          if (target) {
            out.includes.push({
              receiver: fn.childForFieldName('object')?.text ?? '',
              target,
              prefix: toValue(keywords.get('prefix')),
              conditional,
              lines: lines(n),
            })
          }
        }
        break
      }
      case 'decorated_definition': {
        const def = n.childForFieldName('definition')
        if (def?.type === 'function_definition') {
          for (const d of n.children.filter((c) => c.type === 'decorator')) {
            const expr = d.namedChildren.find((c) => c.type !== 'comment')
            if (expr?.type !== 'call') continue
            const fn = expr.childForFieldName('function')
            if (fn?.type !== 'attribute') continue
            const attr = fn.childForFieldName('attribute')?.text ?? ''
            if (!HTTP_METHODS.has(attr) && attr !== 'api_route' && attr !== 'websocket') continue
            const { positional, keywords } = callArguments(expr)
            out.routes.push({
              receiver: fn.childForFieldName('object')?.text ?? '',
              method: HTTP_METHODS.has(attr) ? attr.toUpperCase() : 'ANY',
              path: toValue(positional[0] ?? keywords.get('path')),
              handler: def.childForFieldName('name')?.text ?? '(anonymous)',
              lines: { start: d.startPosition.row + 1, end: def.endPosition.row + 1 },
            })
          }
        }
        break
      }
      case 'class_definition': {
        const bases: string[] = []
        const keywords: Record<string, string> = {}
        for (const a of n.childForFieldName('superclasses')?.namedChildren ?? []) {
          if (a.type === 'comment') continue
          if (a.type === 'keyword_argument') {
            const name = a.childForFieldName('name')?.text
            const value = a.childForFieldName('value')?.text
            if (name && value) keywords[name] = value
          } else bases.push(a.text)
        }
        out.classes.push({
          name: n.childForFieldName('name')?.text ?? '',
          bases,
          keywords,
          lines: lines(n),
        })
        break
      }
    }
    const nowInFunction = inFunction || n.type === 'function_definition'
    const nowConditional = conditional || n.type === 'if_statement'
    for (const c of n.children) visit(c, nowInFunction, nowConditional)
  }

  visit(root, false, false)
  return out
}

export type PyResolution =
  | { kind: 'repo'; file: string; via: 'module' | 'submodule' | 'symbol' }
  | { kind: 'stdlib' | 'external' | 'unresolved'; top: string }

/** Resolves Python imports to files in the repository, using pyproject.toml directories as roots. */
export function makePythonResolver(files: readonly string[]) {
  const fileSet = new Set(files)
  const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p))
  const projectRoots = files.filter((f) => posix.basename(f) === 'pyproject.toml').map(dirOf)
  const candidates = (dir: string, parts: string[]) => {
    const base = [dir, ...parts].filter(Boolean).join('/')
    return parts.length > 0
      ? [`${base}.py`, `${base}/__init__.py`]
      : [`${dir ? `${dir}/` : ''}__init__.py`]
  }
  const first = (list: string[]) => list.find((p) => fileSet.has(p))
  const rootsFor = (file: string) => {
    const dir = dirOf(file)
    const own = projectRoots
      .filter((r) => r === '' || dir === r || dir.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)
    return [
      ...own,
      ...projectRoots.filter((r) => !own.includes(r)),
      ...(projectRoots.includes('') ? [] : ['']),
    ]
  }

  return (file: string, imp: PyImport, name: string): PyResolution => {
    const parts = imp.module ? imp.module.split('.') : []
    if (imp.kind === 'import') {
      for (const root of rootsFor(file)) {
        const hit = first(candidates(root, parts))
        if (hit) return { kind: 'repo', file: hit, via: 'module' }
      }
      const top = parts[0] ?? ''
      return { kind: PYTHON_STDLIB.has(top) ? 'stdlib' : 'external', top }
    }
    let bases: string[]
    if (imp.level > 0) {
      let d = dirOf(file)
      for (let i = 1; i < imp.level; i++) d = dirOf(d)
      bases = [d]
    } else bases = rootsFor(file)
    for (const root of bases) {
      if (name !== '*') {
        const sub = first(candidates(root, [...parts, name]))
        if (sub) return { kind: 'repo', file: sub, via: 'submodule' }
      }
      const moduleFile = first(candidates(root, parts))
      if (moduleFile)
        return { kind: 'repo', file: moduleFile, via: name === '*' ? 'module' : 'symbol' }
    }
    if (imp.level > 0) return { kind: 'unresolved', top: imp.module }
    const top = parts[0] ?? ''
    return { kind: PYTHON_STDLIB.has(top) ? 'stdlib' : 'external', top }
  }
}
