import type { Lines, PyAlias, PyArg, PyClass, PyFile, PyFunction, PyType } from './python.ts'

/**
 * Data access, entity references and endpoint parameters for Python (ADR 0021). Everything here
 * is a static reading of syntax trees with names resolved through the repository's own imports;
 * nothing is executed or type-checked. When a name, type or receiver cannot be resolved, no fact
 * is produced: a missing relation is preferred to a wrong one.
 */

export type ImportMap = ReadonlyMap<string, { file: string; symbol?: string }>

/** A span that, jointly with the others of its group, supports an inferred fact (R2). */
export interface SourceRef {
  file: string
  lines: Lines
  symbol: string
}

export interface DataAccess {
  kind: 'reads' | 'writes'
  /** Entity key, as given by the analyzer for the entity's class. */
  entity: string
  /**
   * Jointly required spans: the handler, each function on the call path to the access, and any
   * type alias or function return annotation that told which entity a variable holds.
   */
  support: SourceRef[]
}

export interface EntityReference {
  from: string
  to: string
  support: SourceRef
}

export type ParameterLocation = 'path' | 'query' | 'body' | 'header' | 'cookie' | 'unknown'

/** A type alias rather than an interface, so it is assignable to an attribute's JSON value. */
export type EndpointParameter = {
  name: string
  in: ParameterLocation
  type?: string
}

type Sym =
  | { kind: 'class'; file: string; cls: PyClass }
  | { kind: 'function'; file: string; fn: PyFunction }
  | { kind: 'alias'; file: string; alias: PyAlias }
  | { kind: 'module'; file: string }
  | { kind: 'member'; file: string; cls: PyClass; member: string }

type Typed = { entity: string; via: SourceRef[] }

/** Functions followed below a handler: one or two levels, as in route → crud → helper. */
export const MAX_CALL_DEPTH = 2
const MAX_RESOLVE_DEPTH = 6

/** Ways a SQLModel or Pydantic class builds an instance. */
const CONSTRUCTORS = new Set(['model_validate', 'model_construct', 'from_orm', 'parse_obj'])
/** Query-building calls whose entity arguments are read. */
const READ_CLAUSES = new Set(['select', 'select_from', 'join', 'outerjoin', 'join_from', 'query'])
/** Session methods that write the instances passed to them. */
const PERSIST = new Set(['add', 'add_all', 'merge', 'delete'])
/** SQLAlchemy and SQLModel statement constructors that write the entity they are given. */
const STATEMENTS = new Set(['delete', 'update', 'insert'])
/** Receivers that are taken to be a database session: session, db, db_session, self.session. */
const SESSION_NAME = /(^|\.)(\w+_)?(session|db)$/i

const MARKERS: Record<string, ParameterLocation | 'dependency'> = {
  Depends: 'dependency',
  Security: 'dependency',
  Path: 'path',
  Query: 'query',
  Body: 'body',
  Form: 'body',
  File: 'body',
  Header: 'header',
  Cookie: 'cookie',
}
/** Parameters FastAPI fills from the connection itself, not from the request's data. */
const SPECIAL = new Set([
  'Request',
  'Response',
  'WebSocket',
  'HTTPConnection',
  'BackgroundTasks',
  'SecurityScopes',
])
/** Types FastAPI treats as scalars, so a parameter of one is a query parameter by default. */
const SCALARS = new Set([
  'int',
  'float',
  'str',
  'bool',
  'bytes',
  'Any',
  'UUID',
  'datetime',
  'date',
  'time',
  'timedelta',
  'Decimal',
  'EmailStr',
  'AnyUrl',
  'AnyHttpUrl',
  'HttpUrl',
  'SecretStr',
  'PositiveInt',
  'NonNegativeInt',
  'PositiveFloat',
  'NonNegativeFloat',
])
const SEQUENCES = new Set([
  'list',
  'List',
  'set',
  'Set',
  'frozenset',
  'FrozenSet',
  'tuple',
  'Tuple',
  'Sequence',
  'Iterable',
])
const MAPPINGS = new Set(['dict', 'Dict', 'Mapping'])
const lastPart = (dotted: string) => dotted.split('.').pop() ?? dotted

export class PythonModel {
  readonly #files: ReadonlyMap<string, PyFile>
  readonly #imports: ReadonlyMap<string, ImportMap>
  readonly #entityKey: (file: string, cls: PyClass) => string | undefined
  /** Local definitions per file; null marks a name defined more than once (ambiguous). */
  readonly #locals = new Map<string, Map<string, Sym | null>>()
  readonly #entitiesByClassName = new Map<string, string[]>()
  readonly #direct = new Map<string, ReturnType<PythonModel['direct']>>()
  /** Functions at the depth limit that call further repository functions. */
  readonly unfollowed = new Set<string>()

  constructor(
    files: ReadonlyMap<string, PyFile>,
    imports: ReadonlyMap<string, ImportMap>,
    entityKey: (file: string, cls: PyClass) => string | undefined,
  ) {
    this.#files = files
    this.#imports = imports
    this.#entityKey = entityKey
    for (const [file, py] of files) {
      const locals = new Map<string, Sym | null>()
      const define = (name: string, sym: Sym) => locals.set(name, locals.has(name) ? null : sym)
      for (const cls of py.classes) {
        define(cls.name, { kind: 'class', file, cls })
        const key = entityKey(file, cls)
        if (key) {
          const list = this.#entitiesByClassName.get(cls.name) ?? []
          if (!list.includes(key)) list.push(key)
          this.#entitiesByClassName.set(cls.name, list)
        }
      }
      for (const fn of py.functions) define(fn.name, { kind: 'function', file, fn })
      for (const alias of py.aliases) define(alias.name, { kind: 'alias', file, alias })
      this.#locals.set(file, locals)
    }
  }

  // ---------- names ----------

  #resolveName(file: string, name: string, depth = 0): Sym | undefined {
    if (depth > MAX_RESOLVE_DEPTH) return undefined
    const locals = this.#locals.get(file)
    if (locals?.has(name)) return locals.get(name) ?? undefined
    const imported = this.#imports.get(file)?.get(name)
    if (!imported) return undefined
    return imported.symbol
      ? this.#resolveName(imported.file, imported.symbol, depth + 1)
      : { kind: 'module', file: imported.file }
  }

  /** Resolves "crud.create_user", "User" or "Item.owner_id" as seen from one file. */
  resolve(file: string, dotted: string): Sym | undefined {
    const parts = dotted.split('.')
    let sym = this.#resolveName(file, parts[0] ?? '')
    for (let i = 1; i < parts.length && sym; i++) {
      if (sym.kind === 'module') sym = this.#resolveName(sym.file, parts[i] ?? '')
      else if (sym.kind === 'class')
        return { kind: 'member', file: sym.file, cls: sym.cls, member: parts.slice(i).join('.') }
      else return undefined
    }
    return sym
  }

  /** The entity a name denotes as a class (`User`) or through one of its columns (`User.id`). */
  #entityClass(file: string, dotted: string): string | undefined {
    const sym = this.resolve(file, dotted)
    if (sym?.kind === 'class' || sym?.kind === 'member') return this.#entityKey(sym.file, sym.cls)
    return undefined
  }

  /** The entity whose instances a type annotation describes: User, User | None, Optional[User]. */
  instanceEntity(file: string, type: PyType | null, depth = 0): Typed | undefined {
    if (!type || depth > MAX_RESOLVE_DEPTH) return undefined
    switch (type.kind) {
      case 'name':
      case 'forward': {
        const sym = this.resolve(file, type.name)
        if (sym?.kind === 'class') {
          const entity = this.#entityKey(sym.file, sym.cls)
          return entity ? { entity, via: [] } : undefined
        }
        if (sym?.kind === 'alias') {
          const inner = this.instanceEntity(sym.file, sym.alias.type, depth + 1)
          return (
            inner && { entity: inner.entity, via: [aliasRef(sym.file, sym.alias), ...inner.via] }
          )
        }
        // A string annotation names a class the way SQLModel resolves it: by class name.
        if (!sym && type.kind === 'forward') {
          const candidates = this.#entitiesByClassName.get(lastPart(type.name)) ?? []
          return candidates.length === 1 ? { entity: candidates[0] as string, via: [] } : undefined
        }
        return undefined
      }
      case 'generic': {
        const base = lastPart(type.name)
        if (base === 'Optional' || base === 'Annotated' || base === 'Mapped')
          return this.instanceEntity(file, type.args[0] ?? null, depth + 1)
        if (base === 'Union')
          return this.instanceEntity(file, { kind: 'union', options: type.args }, depth + 1)
        return undefined
      }
      case 'union': {
        const options = type.options.filter((o) => o.kind !== 'none')
        return options.length === 1
          ? this.instanceEntity(file, options[0] ?? null, depth + 1)
          : undefined
      }
      default:
        return undefined
    }
  }

  // ---------- data access ----------

  /** Accesses one function performs itself, and the repository functions it calls. */
  direct(
    file: string,
    fn: PyFunction,
  ): {
    accesses: { kind: 'reads' | 'writes'; entity: string; via: SourceRef[] }[]
    calls: { file: string; fn: PyFunction }[]
  } {
    const id = functionId(file, fn)
    const cached = this.#direct.get(id)
    if (cached) return cached
    const vars = new Map<string, Typed>()
    for (const p of fn.params) {
      const typed = p.kind === 'plain' ? this.instanceEntity(file, p.type) : undefined
      if (typed) vars.set(p.name, typed)
    }
    const accesses: { kind: 'reads' | 'writes'; entity: string; via: SourceRef[] }[] = []
    const calls: { file: string; fn: PyFunction }[] = []
    const add = (kind: 'reads' | 'writes', typed: Typed | undefined) => {
      if (typed) accesses.push({ kind, entity: typed.entity, via: typed.via })
    }
    const classArg = (arg: PyArg | undefined): Typed | undefined => {
      if (arg?.kind !== 'name') return undefined
      const entity = this.#entityClass(file, arg.name)
      return entity ? { entity, via: [] } : undefined
    }
    /** The entity a call builds or returns: User(...), User.model_validate(...), crud.get_user(...). */
    const built = (callee: string | null): Typed | undefined => {
      const sym = callee ? this.resolve(file, callee) : undefined
      if (sym?.kind === 'class' || (sym?.kind === 'member' && CONSTRUCTORS.has(sym.member))) {
        const entity = this.#entityKey(sym.file, sym.cls)
        return entity ? { entity, via: [] } : undefined
      }
      if (sym?.kind === 'function' && sym.fn.returns) {
        const returned = this.instanceEntity(sym.file, sym.fn.returns)
        return (
          returned && {
            entity: returned.entity,
            via: [functionRef(sym.file, sym.fn), ...returned.via],
          }
        )
      }
      return undefined
    }
    const instances = (arg: PyArg): Typed[] => {
      if (arg.kind === 'name') {
        const typed = vars.get(arg.name)
        return typed ? [typed] : []
      }
      if (arg.kind === 'call') {
        const typed = built(arg.callee)
        return typed ? [typed] : []
      }
      if (arg.kind === 'list') return arg.items.flatMap(instances)
      return []
    }
    const isSession = (receiver: string) =>
      SESSION_NAME.test(receiver) ||
      fn.params.some((p) => p.name === receiver && /Session/.test(p.typeText ?? ''))

    for (const ev of fn.events) {
      if (ev.kind === 'assign') {
        const typed =
          ev.from.kind === 'name'
            ? vars.get(ev.from.name)
            : ev.from.kind === 'type'
              ? this.instanceEntity(file, ev.from.type)
              : undefined
        if (typed) vars.set(ev.variable, typed)
        else vars.delete(ev.variable)
        continue
      }
      const sym = ev.callee ? this.resolve(file, ev.callee) : undefined
      let result: Typed | undefined
      if (sym?.kind === 'function') {
        if (!calls.some((c) => c.fn === sym.fn)) calls.push({ file: sym.file, fn: sym.fn })
        result = built(ev.callee)
      } else if (sym?.kind === 'class' || sym?.kind === 'member') {
        result = built(ev.callee)
      } else if (ev.method) {
        const m = ev.method
        const session = ev.receiver !== null && isSession(ev.receiver)
        if (READ_CLAUSES.has(m)) {
          for (const arg of ev.args) add('reads', classArg(arg))
        } else if ((m === 'get' || m === 'get_one') && ev.args.length >= 1) {
          result = classArg(ev.args[0])
          add('reads', result)
        } else if (PERSIST.has(m) && session) {
          for (const arg of ev.args) for (const typed of instances(arg)) add('writes', typed)
        } else if (STATEMENTS.has(m) && !session) {
          add('writes', classArg(ev.args[0]))
        } else if (m === 'sqlmodel_update' && ev.receiver) {
          add('writes', vars.get(ev.receiver))
        }
      }
      if (ev.assignedTo) {
        if (result) vars.set(ev.assignedTo, result)
        else vars.delete(ev.assignedTo)
      }
    }
    const summary = { accesses, calls }
    this.#direct.set(id, summary)
    return summary
  }

  /**
   * Reads and writes of a handler, following calls into repository functions up to
   * MAX_CALL_DEPTH levels. `root` is the span that stands for the handler itself.
   */
  accesses(file: string, fn: PyFunction, root: SourceRef): DataAccess[] {
    const out: DataAccess[] = []
    const seen = new Set<string>()
    const visit = (f: string, current: PyFunction, path: SourceRef[], stack: Set<string>) => {
      const direct = this.direct(f, current)
      for (const access of direct.accesses) {
        const support = uniqueRefs([...path, ...access.via])
        const key = `${access.kind}|${access.entity}|${support.map(refKey).join(',')}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ kind: access.kind, entity: access.entity, support })
      }
      if (path.length > MAX_CALL_DEPTH) {
        if (direct.calls.length > 0) this.unfollowed.add(functionId(f, current))
        return
      }
      for (const call of direct.calls) {
        const id = functionId(call.file, call.fn)
        if (stack.has(id)) continue
        visit(
          call.file,
          call.fn,
          [...path, functionRef(call.file, call.fn)],
          new Set([...stack, id]),
        )
      }
    }
    visit(file, fn, [root], new Set([functionId(file, fn)]))
    return out
  }

  // ---------- entity references ----------

  /**
   * `references` between entities: foreign keys (`Field(foreign_key="user.id")`, `ForeignKey(...)`)
   * and scalar relationships (`owner: User | None = Relationship()`). A collection relationship
   * (`items: list[Item]`) is the inverse view of a key the other entity holds, so it adds nothing.
   */
  references(): { references: EntityReference[]; unresolved: number } {
    const tables: { file: string; cls: PyClass; key: string }[] = []
    for (const [file, py] of [...this.#files].sort(([a], [b]) => (a < b ? -1 : 1)))
      for (const cls of py.classes) {
        const key = this.#entityKey(file, cls)
        if (key) tables.push({ file, cls, key })
      }
    const byTable = new Map<string, string[]>()
    for (const t of tables) {
      const name = t.cls.tableName ?? t.cls.name.toLowerCase()
      byTable.set(name, [...(byTable.get(name) ?? []), t.key])
    }
    const references: EntityReference[] = []
    const keysTo = new Map<string, Set<string>>()
    let unresolved = 0
    const fieldRef = (file: string, cls: PyClass, field: PyClass['fields'][number]): SourceRef => ({
      file,
      lines: field.lines,
      symbol: `${cls.name}.${field.name}`,
    })
    for (const { file, cls, key } of tables) {
      for (const field of cls.fields) {
        for (const fk of field.foreignKeys) {
          let target: string | undefined
          if ('literal' in fk) {
            const parts = fk.literal.split('.')
            const candidates =
              parts.length >= 2 ? (byTable.get(parts[parts.length - 2] ?? '') ?? []) : []
            target = candidates.length === 1 ? candidates[0] : undefined
          } else target = this.#entityClass(file, fk.expr)
          if (!target) {
            unresolved++
            continue
          }
          references.push({ from: key, to: target, support: fieldRef(file, cls, field) })
          keysTo.set(key, (keysTo.get(key) ?? new Set()).add(target))
        }
      }
    }
    for (const { file, cls, key } of tables) {
      for (const field of cls.fields) {
        const rel = field.relationship
        if (!rel || 'link_model' in rel.keywords || 'secondary' in rel.keywords) continue
        const declared = field.type ?? rel.target
        const element = declared ? this.#element(file, declared) : undefined
        if (!element?.entity) {
          if (declared) unresolved++
          continue
        }
        // A bare target (relationship("Item")) says nothing about cardinality; an annotation does.
        const uselist = rel.keywords.uselist
        const collection =
          uselist === 'False'
            ? false
            : uselist === 'True'
              ? true
              : field.type
                ? element.collection
                : undefined
        const target = element.entity
        // Without an annotation or uselist, only a key this entity holds says which side it is.
        if (collection === undefined && !keysTo.get(key)?.has(target)) continue
        if (collection) continue
        if (keysTo.get(target)?.has(key)) continue
        references.push({ from: key, to: target, support: fieldRef(file, cls, field) })
      }
    }
    return { references, unresolved }
  }

  /** The entity a relationship annotation points at, and whether it is a collection of them. */
  #element(file: string, type: PyType): { entity: string | undefined; collection: boolean } {
    let current = type
    for (let i = 0; i < MAX_RESOLVE_DEPTH; i++) {
      if (current.kind === 'union') {
        const options = current.options.filter((o) => o.kind !== 'none')
        if (options.length !== 1) return { entity: undefined, collection: false }
        current = options[0] as PyType
      } else if (
        current.kind === 'generic' &&
        ['Mapped', 'Optional'].includes(lastPart(current.name))
      ) {
        current = current.args[0] ?? { kind: 'other' }
      } else break
    }
    if (current.kind === 'generic' && SEQUENCES.has(lastPart(current.name)))
      return {
        entity: this.instanceEntity(file, current.args[0] ?? null)?.entity,
        collection: true,
      }
    return { entity: this.instanceEntity(file, current)?.entity, collection: false }
  }

  // ---------- endpoint parameters ----------

  /** Request parameters of a FastAPI handler, by FastAPI's own rules. Dependencies are left out. */
  parameters(file: string, fn: PyFunction, routePath: string): EndpointParameter[] {
    const inPath = new Set(
      [...routePath.matchAll(/\{([A-Za-z_]\w*)(?::[^}]*)?\}/g)].map((m) => m[1]),
    )
    const out: EndpointParameter[] = []
    for (const p of fn.params) {
      if (p.kind !== 'plain') continue
      const { calls, base } = this.#markers(file, p.type)
      const markers = [p.defaultCall, ...calls]
        .filter((c): c is string => c !== null)
        .map((c) => MARKERS[lastPart(c)])
        .filter((m) => m !== undefined)
      let location: ParameterLocation | 'skip'
      if (markers.includes('dependency')) continue
      if (markers[0]) location = markers[0] as ParameterLocation
      else if (inPath.has(p.name)) location = 'path'
      else if (!p.type) location = 'query'
      else location = base ? this.#location(base.file, base.type) : 'unknown'
      if (location === 'skip') continue
      out.push({
        name: p.name,
        in: location,
        ...(p.typeText ? { type: p.typeText.slice(0, 300) } : {}),
      })
    }
    return out
  }

  /** Calls in Annotated[...] metadata, through aliases, and the type underneath them. */
  #markers(
    file: string,
    type: PyType | null,
    depth = 0,
  ): { calls: string[]; base: { file: string; type: PyType } | null } {
    if (!type || depth > MAX_RESOLVE_DEPTH) return { calls: [], base: null }
    if (type.kind === 'generic' && lastPart(type.name) === 'Annotated') {
      const inner = this.#markers(file, type.args[0] ?? { kind: 'other' }, depth + 1)
      return { calls: [...type.calls, ...inner.calls], base: inner.base }
    }
    if (type.kind === 'name') {
      const sym = this.resolve(file, type.name)
      if (sym?.kind === 'alias') return this.#markers(sym.file, sym.alias.type, depth + 1)
    }
    return { calls: [], base: { file, type } }
  }

  #location(file: string, type: PyType, depth = 0): ParameterLocation | 'skip' {
    if (depth > MAX_RESOLVE_DEPTH) return 'unknown'
    switch (type.kind) {
      case 'name':
      case 'forward': {
        const sym = this.resolve(file, type.name)
        if (sym?.kind === 'class') return this.#isEnum(sym.file, sym.cls) ? 'query' : 'body'
        if (sym?.kind === 'alias') return this.#location(sym.file, sym.alias.type, depth + 1)
        const name = lastPart(type.name)
        if (SPECIAL.has(name)) return 'skip'
        if (SCALARS.has(name)) return 'query'
        if (name === 'UploadFile' || MAPPINGS.has(name)) return 'body'
        return 'unknown'
      }
      case 'generic': {
        const name = lastPart(type.name)
        if (name === 'Optional' || name === 'Annotated')
          return this.#location(file, type.args[0] ?? { kind: 'other' }, depth + 1)
        if (name === 'Union')
          return this.#location(file, { kind: 'union', options: type.args }, depth + 1)
        if (name === 'Literal') return 'query'
        // FastAPI reads a sequence or mapping from the body unless Query(...) says otherwise.
        if (SEQUENCES.has(name) || MAPPINGS.has(name)) return 'body'
        return 'unknown'
      }
      case 'union': {
        const options = type.options
          .filter((o) => o.kind !== 'none')
          .map((o) => this.#location(file, o, depth + 1))
        if (options.length === 0 || options.includes('unknown') || options.includes('skip'))
          return 'unknown'
        return options.every((o) => o === 'query')
          ? 'query'
          : options.includes('body')
            ? 'body'
            : 'unknown'
      }
      default:
        return 'unknown'
    }
  }

  #isEnum(file: string, cls: PyClass, depth = 0): boolean {
    if (depth > MAX_RESOLVE_DEPTH) return false
    return cls.bases.some((base) => {
      if (/(^|\.)(Enum|IntEnum|StrEnum|IntFlag|Flag)$/.test(base)) return true
      const sym = this.resolve(file, base)
      return sym?.kind === 'class' && this.#isEnum(sym.file, sym.cls, depth + 1)
    })
  }
}

export const functionId = (file: string, fn: PyFunction) => `${file}#${fn.name}@${fn.lines.start}`
export const functionRef = (file: string, fn: PyFunction): SourceRef => ({
  file,
  lines: fn.lines,
  symbol: fn.name,
})
const aliasRef = (file: string, alias: PyAlias): SourceRef => ({
  file,
  lines: alias.lines,
  symbol: alias.name,
})
const refKey = (r: SourceRef) => `${r.file}:${r.lines.start}-${r.lines.end}`
const uniqueRefs = (refs: SourceRef[]) => {
  const seen = new Set<string>()
  return refs.filter((r) => {
    const k = refKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
