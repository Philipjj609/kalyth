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
  /** The handler's signature and the calls in its body. */
  fn: PyFunction
}

/**
 * A type annotation as written, reduced to what name resolution needs. `generic` covers both
 * `list[Item]` and `Annotated[User, Depends(f)]`; `calls` are the callees of calls among its
 * arguments (the metadata of Annotated). `forward` is a string annotation naming a class.
 */
export type PyType =
  | { kind: 'name'; name: string }
  | { kind: 'forward'; name: string }
  | { kind: 'generic'; name: string; args: PyType[]; calls: string[] }
  | { kind: 'union'; options: PyType[] }
  | { kind: 'none' }
  | { kind: 'other' }

export interface PyParam {
  name: string
  kind: 'plain' | 'args' | 'kwargs'
  type: PyType | null
  /** The annotation as written, whitespace collapsed. */
  typeText: string | null
  /** Dotted callee when the default value is a call, as in `= Query(None)` or `= Depends(f)`. */
  defaultCall: string | null
}

/** A positional call argument, kept only as far as data-access heuristics look into it. */
export type PyArg =
  | { kind: 'name'; name: string }
  | { kind: 'call'; callee: string | null; method: string | null; args: PyArg[] }
  | { kind: 'list'; items: PyArg[] }
  | { kind: 'other' }

/** One call in a function body, in source order. */
export interface PyCall {
  kind: 'call'
  /** The dotted callee when it is a plain name or attribute chain: "select", "crud.create_user". */
  callee: string | null
  /** The called name: the last attribute for method calls ("get" in `session.get`). */
  method: string | null
  /** The receiver of a method call when it is a dotted name ("session"); null otherwise. */
  receiver: string | null
  args: PyArg[]
  /** The local variable the call's result is assigned to, if any. */
  assignedTo: string | null
  line: number
}

/** A local variable assignment that is not a call: a copy, an annotation, or an untracked value. */
export interface PyAssign {
  kind: 'assign'
  variable: string
  from: { kind: 'name'; name: string } | { kind: 'type'; type: PyType } | { kind: 'unknown' }
  line: number
}

export interface PyFunction {
  name: string
  /** From the first decorator to the end of the body. */
  lines: Lines
  params: PyParam[]
  returns: PyType | null
  events: (PyCall | PyAssign)[]
}

/** A module-level type alias: `X = Annotated[...]`, `X = A | None`, or `type X = ...`. */
export interface PyAlias {
  name: string
  type: PyType
  lines: Lines
}

/** A class-body field, with the foreign keys and relationship its value declares. */
export interface PyField {
  name: string
  type: PyType | null
  /** Targets of `foreign_key=` and `ForeignKey(...)` in the value: "user.id" or `User.id`. */
  foreignKeys: Value[]
  /** For `Relationship(...)` or `relationship(...)`: the first positional argument and keywords. */
  relationship: { target: PyType | null; keywords: Record<string, string> } | null
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
  /** `__tablename__` when set to a literal string. */
  tableName: string | null
  fields: PyField[]
}

export interface PyFile {
  imports: PyImport[]
  routers: PyRouter[]
  routes: PyRoute[]
  includes: PyInclude[]
  classes: PyClass[]
  constants: { name: string; value: string }[]
  /** Module-level functions (not methods or nested functions). */
  functions: PyFunction[]
  aliases: PyAlias[]
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

/** "a.b.c" for an identifier or attribute chain; undefined for any other expression. */
export function dotted(n: Node | null | undefined): string | undefined {
  if (!n) return undefined
  if (n.type === 'identifier') return n.text
  if (n.type === 'attribute') {
    const object = dotted(n.childForFieldName('object'))
    const attribute = n.childForFieldName('attribute')?.text
    return object && attribute ? `${object}.${attribute}` : undefined
  }
  return undefined
}

/** Strips `await` and parentheses around an expression. */
function unwrap(n: Node | null | undefined): Node | null {
  let current = n ?? null
  while (current && (current.type === 'await' || current.type === 'parenthesized_expression'))
    current = current.namedChildren.find((c) => c.type !== 'comment') ?? null
  return current
}

const DOTTED = /^[A-Za-z_][\w.]*$/

function forwardType(text: string): PyType {
  const options = text.split('|').map((t) => t.trim())
  const parsed = options.map(
    (t): PyType =>
      t === 'None'
        ? { kind: 'none' }
        : DOTTED.test(t)
          ? { kind: 'forward', name: t }
          : { kind: 'other' },
  )
  return parsed.length === 1 ? (parsed[0] as PyType) : { kind: 'union', options: parsed }
}

/** The structure of a type expression, as far as name resolution needs it. */
export function typeOf(n: Node | null | undefined): PyType {
  if (!n) return { kind: 'other' }
  switch (n.type) {
    case 'type':
    case 'parenthesized_expression':
      return typeOf(n.namedChildren.find((c) => c.type !== 'comment'))
    case 'identifier':
    case 'attribute': {
      const name = dotted(n)
      return name ? { kind: 'name', name } : { kind: 'other' }
    }
    case 'none':
      return { kind: 'none' }
    case 'string': {
      const text = stringValue(n)
      return text === undefined ? { kind: 'other' } : forwardType(text)
    }
    case 'subscript':
    case 'generic_type': {
      const head = n.type === 'subscript' ? n.childForFieldName('value') : n.namedChildren[0]
      const name = dotted(head)
      if (!name) return { kind: 'other' }
      const entries =
        n.type === 'subscript'
          ? n.childrenForFieldName('subscript')
          : (n.namedChildren
              .find((c) => c.type === 'type_parameter')
              ?.namedChildren.map((t) =>
                t.type === 'type' ? (t.namedChildren.find((c) => c.type !== 'comment') ?? t) : t,
              ) ?? [])
      const args: PyType[] = []
      const calls: string[] = []
      for (const e of entries) {
        if (e.type === 'comment') continue
        if (e.type === 'call') {
          const callee = dotted(e.childForFieldName('function'))
          if (callee) calls.push(callee)
        } else args.push(typeOf(e))
      }
      return { kind: 'generic', name, args, calls }
    }
    case 'binary_operator': {
      if (n.childForFieldName('operator')?.type !== '|') return { kind: 'other' }
      const options: PyType[] = []
      for (const side of [n.childForFieldName('left'), n.childForFieldName('right')]) {
        const t = typeOf(side)
        if (t.kind === 'union') options.push(...t.options)
        else options.push(t)
      }
      return { kind: 'union', options }
    }
    default:
      return { kind: 'other' }
  }
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

function argOf(n: Node): PyArg {
  const e = unwrap(n)
  if (!e) return { kind: 'other' }
  const name = dotted(e)
  if (name) return { kind: 'name', name }
  if (e.type === 'call') {
    const fn = e.childForFieldName('function')
    return {
      kind: 'call',
      callee: dotted(fn) ?? null,
      method:
        fn?.type === 'attribute'
          ? (fn.childForFieldName('attribute')?.text ?? null)
          : (dotted(fn) ?? null),
      args: callArguments(e).positional.map(argOf),
    }
  }
  if (e.type === 'list' || e.type === 'tuple' || e.type === 'set')
    return { kind: 'list', items: e.namedChildren.filter((c) => c.type !== 'comment').map(argOf) }
  return { kind: 'other' }
}

function parametersOf(def: Node): PyParam[] {
  const params: PyParam[] = []
  for (const p of def.childForFieldName('parameters')?.namedChildren ?? []) {
    let nameNode: Node | null = null
    let typeNode: Node | null = null
    let value: Node | null = null
    switch (p.type) {
      case 'identifier':
        nameNode = p
        break
      case 'typed_parameter':
        nameNode = p.namedChildren.find((c) => c.type !== 'type' && c.type !== 'comment') ?? null
        typeNode = p.childForFieldName('type')
        break
      case 'default_parameter':
      case 'typed_default_parameter':
        nameNode = p.childForFieldName('name')
        typeNode = p.childForFieldName('type')
        value = p.childForFieldName('value')
        break
      case 'list_splat_pattern':
      case 'dictionary_splat_pattern':
        nameNode = p
        break
      default:
        continue
    }
    if (!nameNode) continue
    const kind =
      nameNode.type === 'list_splat_pattern'
        ? 'args'
        : nameNode.type === 'dictionary_splat_pattern'
          ? 'kwargs'
          : 'plain'
    const name = kind === 'plain' ? nameNode.text : (nameNode.namedChildren[0]?.text ?? '')
    const v = unwrap(value)
    params.push({
      name,
      kind,
      type: typeNode ? typeOf(typeNode) : null,
      typeText: typeNode ? collapse(typeNode.text) : null,
      defaultCall: v?.type === 'call' ? (dotted(v.childForFieldName('function')) ?? null) : null,
    })
  }
  return params
}

/** Identifiers bound by an assignment or loop target, including inside tuples and lists. */
function boundNames(target: Node | null): string[] {
  if (!target) return []
  if (target.type === 'identifier') return [target.text]
  if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list'].includes(target.type))
    return target.namedChildren.flatMap(boundNames)
  return []
}

/** The signature of a function and the calls and assignments in its body, in source order. */
function summarizeFunction(def: Node, outer: Node): PyFunction {
  const events: (PyCall | PyAssign)[] = []
  const assignedCalls = new Map<number, string>()
  const walk = (n: Node): void => {
    switch (n.type) {
      case 'function_definition':
      case 'class_definition':
        // Nested definitions run elsewhere, if at all; their bodies are not this function's.
        return
      case 'assignment': {
        const left = n.childForFieldName('left')
        const right = unwrap(n.childForFieldName('right'))
        const type = n.childForFieldName('type')
        const names = boundNames(left)
        const line = n.startPosition.row + 1
        if (left?.type === 'identifier' && right?.type === 'call')
          assignedCalls.set(right.startIndex, left.text)
        for (const c of n.children) walk(c)
        if (left?.type === 'identifier' && type) {
          events.push({
            kind: 'assign',
            variable: left.text,
            from: { kind: 'type', type: typeOf(type) },
            line,
          })
        } else if (left?.type === 'identifier' && right?.type !== 'call') {
          const source = dotted(right)
          events.push({
            kind: 'assign',
            variable: left.text,
            from:
              right?.type === 'identifier' && source
                ? { kind: 'name', name: source }
                : { kind: 'unknown' },
            line,
          })
        } else if (left?.type !== 'identifier') {
          for (const variable of names)
            events.push({ kind: 'assign', variable, from: { kind: 'unknown' }, line })
        }
        return
      }
      case 'for_statement':
      case 'for_in_clause':
        for (const variable of boundNames(n.childForFieldName('left')))
          events.push({
            kind: 'assign',
            variable,
            from: { kind: 'unknown' },
            line: n.startPosition.row + 1,
          })
        break
      case 'call': {
        const fn = n.childForFieldName('function')
        const callee = dotted(fn) ?? null
        events.push({
          kind: 'call',
          callee,
          method:
            fn?.type === 'attribute' ? (fn.childForFieldName('attribute')?.text ?? null) : callee,
          receiver:
            fn?.type === 'attribute' ? (dotted(fn.childForFieldName('object')) ?? null) : null,
          args: callArguments(n).positional.map(argOf),
          assignedTo: assignedCalls.get(n.startIndex) ?? null,
          line: n.startPosition.row + 1,
        })
        break
      }
    }
    for (const c of n.children) walk(c)
  }
  const body = def.childForFieldName('body')
  if (body) walk(body)
  const returns = def.childForFieldName('return_type')
  return {
    name: def.childForFieldName('name')?.text ?? '(anonymous)',
    lines: lines(outer),
    params: parametersOf(def),
    returns: returns ? typeOf(returns) : null,
    events,
  }
}

const RELATIONSHIP_CALLS = new Set(['Relationship', 'relationship'])

/** Fields of a class body, with the foreign keys and relationships their values declare. */
function classBody(cls: Node): { tableName: string | null; fields: PyField[] } {
  let tableName: string | null = null
  const fields: PyField[] = []
  for (const statement of cls.childForFieldName('body')?.namedChildren ?? []) {
    if (statement.type !== 'expression_statement') continue
    const assignment = statement.namedChildren[0]
    if (assignment?.type !== 'assignment') continue
    const left = assignment.childForFieldName('left')
    if (left?.type !== 'identifier') continue
    const right = assignment.childForFieldName('right')
    if (left.text === '__tablename__') {
      tableName = stringValue(right) ?? null
      continue
    }
    const foreignKeys: Value[] = []
    const visitValue = (n: Node): void => {
      if (n.type === 'call') {
        const base = dotted(n.childForFieldName('function'))?.split('.').pop() ?? ''
        const { positional, keywords } = callArguments(n)
        const fk = keywords.get('foreign_key')
        if (fk) foreignKeys.push(toValue(fk))
        if (base === 'ForeignKey' && positional[0]) foreignKeys.push(toValue(positional[0]))
      }
      for (const c of n.namedChildren) visitValue(c)
    }
    if (right) visitValue(right)
    let relationship: PyField['relationship'] = null
    const value = unwrap(right)
    if (value?.type === 'call') {
      const base = dotted(value.childForFieldName('function'))?.split('.').pop() ?? ''
      if (RELATIONSHIP_CALLS.has(base)) {
        const { positional, keywords } = callArguments(value)
        relationship = {
          target: positional[0] ? typeOf(positional[0]) : null,
          keywords: Object.fromEntries([...keywords].map(([k, v]) => [k, collapse(v.text)])),
        }
      }
    }
    const type = assignment.childForFieldName('type')
    fields.push({
      name: left.text,
      type: type ? typeOf(type) : null,
      foreignKeys,
      relationship,
      lines: lines(statement),
    })
  }
  return { tableName, fields }
}

/** Whether a node sits at module level: not inside any function or class. */
function isTopLevel(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent)
    if (p.type === 'function_definition' || p.type === 'class_definition') return false
  return true
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
    functions: [],
    aliases: [],
  }
  const summaries = new Map<number, PyFunction>()
  const summaryOf = (def: Node): PyFunction => {
    let summary = summaries.get(def.startIndex)
    if (!summary) {
      const outer = def.parent?.type === 'decorated_definition' ? def.parent : def
      summary = summarizeFunction(def, outer)
      summaries.set(def.startIndex, summary)
    }
    return summary
  }
  const ALIAS_VALUES = new Set(['subscript', 'binary_operator', 'identifier', 'attribute'])

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
        if (left?.type === 'identifier' && right && isTopLevel(n)) {
          const annotation = n.childForFieldName('type')?.text ?? ''
          if (ALIAS_VALUES.has(right.type) || /\bTypeAlias$/.test(annotation))
            out.aliases.push({ name: left.text, type: typeOf(right), lines: lines(n) })
        }
        break
      }
      case 'type_alias_statement': {
        const name = n.childForFieldName('left')?.namedChildren[0]
        const value = n.childForFieldName('right')
        if (name?.type === 'identifier' && value && isTopLevel(n))
          out.aliases.push({ name: name.text, type: typeOf(value), lines: lines(n) })
        break
      }
      case 'function_definition':
        if (isTopLevel(n)) out.functions.push(summaryOf(n))
        break
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
              fn: summaryOf(def),
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
          ...classBody(n),
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
