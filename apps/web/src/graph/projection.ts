import type { ObjectVersion, RelationVersion } from '@kalyth/contracts'
import { objectLabel } from '../model/labels.ts'
import { compareTypes } from '../model/semantics.ts'

/**
 * Graph projection: turns the records of one revision into the nodes and edges the canvas shows.
 * Pure and deterministic, so it is unit-tested without a DOM.
 *
 * The canvas draws the system's elements. Decisions, alternatives, questions, tasks, reports,
 * verifications, assertions and source snapshots live in change threads and their own views, so
 * they are left out (ADR 0020).
 *
 * The projection is a tree of holders, read with semantic zoom:
 * - Any element that contains others is a holder: a System, Container or Component, and a Module
 *   that defines data entities or exposes endpoints. Structure comes from `contains`, and an
 *   endpoint without a container of its own belongs to the one module that exposes it.
 * - A holder with many modules groups them by directory into packages, splitting the largest
 *   directory until the holder shows about `packageTarget` items.
 * - Top-level elements of one type (for example many Libraries) form a cluster once there are
 *   `clusterMin` of them.
 * - Holders are collapsed unless opened. Systems and modules are open by default, and so are
 *   containers when the whole model is small. A collapsed holder stands for all its members.
 * - `contains` and `exposes` are shown by nesting where nesting applies, and as edges elsewhere.
 *   Other relations are edges. When an endpoint of a relation is hidden inside a collapsed holder,
 *   the edge attaches to the holder and is aggregated per (source, target, type, basis), so every
 *   drawn edge has exactly one relation type and one claim basis.
 */

/** Records that are not drawn on the canvas: they live in change threads and their own views. */
export const OFF_CANVAS_TYPES: ReadonlySet<string> = new Set([
  'core.Decision',
  'core.Alternative',
  'core.Question',
  'core.Task',
  'core.ExecutionReport',
  'core.Verification',
  'core.Assertion',
  'core.SourceSnapshot',
])

export const GROUP_TYPES: ReadonlySet<string> = new Set([
  'software.System',
  'software.Container',
  'software.Component',
])
/** Types that are never folded into a type cluster. */
export const UNCLUSTERED_TYPES: ReadonlySet<string> = new Set([
  'software.System',
  'software.Container',
  'software.Component',
  'software.Module',
])
/** Types drawn as compact rows inside the module that holds them. */
export const ROW_TYPES: ReadonlySet<string> = new Set(['software.Endpoint'])
/** Relation types that are detail between members of one container (module imports). */
export const DETAIL_RELATIONS: ReadonlySet<string> = new Set(['dependsOn'])
/** Relation types that nesting shows when the target is drawn inside its source. */
const STRUCTURAL_RELATIONS: ReadonlySet<string> = new Set(['contains', 'exposes'])

export const DEFAULT_CLUSTER_MIN = 6
export const DEFAULT_PACKAGE_TARGET = 10
export const DEFAULT_PACKAGE_MIN = 3
/** Up to this many elements, containers start open: the whole model fits at a readable zoom. */
export const SMALL_MODEL = 30
/**
 * Beyond that, containers and packages still start open, the largest first, while the first view
 * stays within this many drawn items: a repository that is one large container opens onto its
 * top-level packages instead of a single box.
 */
export const FIRST_VIEW_BUDGET = 48
/** The share of its level's members that makes a holder "most of" the level. */
const DOMINANT_SHARE = 0.8
/** Holders the first view may open to stay informative: containers and components. */
const AUTO_OPEN_TYPES: ReadonlySet<string> = new Set(['software.Container', 'software.Component'])
export const CLUSTER_PREFIX = 'cluster:'
export const PACKAGE_PREFIX = 'pkg:'

const EMPTY: ReadonlySet<string> = new Set()

export interface ProjectionOptions {
  /** Holders opened by a person. */
  expanded?: ReadonlySet<string>
  /** Holders a person closed that are open by default (systems, modules, small models). */
  collapsed?: ReadonlySet<string>
  hiddenObjectTypes?: ReadonlySet<string>
  hiddenRelationTypes?: ReadonlySet<string>
  /** Top-level objects of one type are clustered when there are at least this many. */
  clusterMin?: number
  /** A holder with more modules than this groups them by directory. */
  packageTarget?: number
  /** A directory becomes a package only with at least this many modules. */
  packageMin?: number
  /** Optional claim freshness, rolled up onto holders as counts. */
  freshnessOf?: (claimId: string) => string | undefined
  /**
   * A drawn node whose edges are drawn to their exact ends. Other edges between different frames
   * join the frames that separate their ends, so no edge crosses a frame to reach inside it.
   */
  exactFor?: string | undefined
  /**
   * Imports (`dependsOn`) between members of one open container, component, package or module
   * are detail: drawn only for the selection (`exactFor`) unless this is "all".
   */
  detail?: 'selection' | 'all'
  /** False draws every edge to its exact ends (for counting hops); true by default. */
  lift?: boolean
}

interface NodeBase {
  id: string
  /** The holder node this node is drawn inside, when that holder is open. */
  parentId?: string
  /** Nesting depth: 0 at the top level. */
  depth: number
}

export interface ObjectNode extends NodeBase {
  kind: 'object'
  object: ObjectVersion
  /** Drawn as a compact row inside its module (endpoints). */
  row: boolean
}

interface HolderBase extends NodeBase {
  expanded: boolean
  /** Every object it holds, at any depth. */
  memberIds: string[]
  memberCounts: Record<string, number>
  memberFreshness: Record<string, number>
  /**
   * How many of its sibling frames import it, when most of them do: such a hub's import links
   * are left out of the drawing and said here instead.
   */
  importedBy?: number
}

export interface GroupNode extends HolderBase {
  kind: 'group'
  /** The holding object itself; the node id is its object id. */
  object: ObjectVersion
}

export interface PackageNode extends HolderBase {
  kind: 'package'
  /** Directory path, ending with a slash. */
  path: string
  /** The path relative to the level it is shown at. */
  title: string
}

export interface ClusterNode extends HolderBase {
  kind: 'cluster'
  /** Object type shared by every member. */
  type: string
}

export type HolderNode = GroupNode | PackageNode | ClusterNode
export type ProjectedNode = ObjectNode | HolderNode

export interface ProjectedEdge {
  id: string
  source: string
  target: string
  /** Relation type. */
  type: string
  /** Claim basis shared by every relation in the edge. */
  basis: string
  /** True when every relation in the edge is to-be (intended). */
  toBe: boolean
  relationIds: string[]
  /** True when the edge stands for relations of hidden members, or for more than one relation. */
  aggregated: boolean
  /** Index among edges joining the same two nodes in either direction, for curve offsets. */
  parallelIndex: number
  parallelCount: number
}

export interface ProjectionStats {
  objects: number
  relations: number
  /** Active objects removed by the object type filter. */
  hiddenObjects: number
  /** Active relations removed by a filter (their type, or a hidden endpoint). */
  hiddenRelations: number
  /** Relations folded inside one collapsed holder, or shown by nesting. */
  internalRelations: number
  /**
   * Imports between members of one container, not drawn unless asked for or selected: between
   * two modules, or beyond the strongest import of each frame.
   */
  detailRelations: number
  /** Decisions, alternatives, questions and other records that live outside the canvas. */
  offCanvas: number
}

export interface Projection {
  /** Nodes in render order: every holder precedes its children. */
  nodes: ProjectedNode[]
  edges: ProjectedEdge[]
  /** Object id -> id of the node drawn for it now (itself, or its outermost collapsed holder). */
  representative: Map<string, string>
  /** Object id -> the nearest holder it belongs to, open or not. */
  containerOf: Map<string, string>
  /** Object or holder id -> its holders, outermost first. */
  ancestors: Map<string, string[]>
  /** Ids of every holder at any depth, for expand-all. */
  expandable: string[]
  /** Holders that are open unless a person closes them. */
  defaultOpen: Set<string>
  stats: ProjectionStats
}

export const clusterId = (type: string) => `${CLUSTER_PREFIX}${type}`
export const isClusterId = (id: string) => id.startsWith(CLUSTER_PREFIX)
export const packageId = (holder: string, path: string) => `${PACKAGE_PREFIX}${holder}:${path}`
export const isPackageId = (id: string) => id.startsWith(PACKAGE_PREFIX)
/** Synthetic holders (packages and clusters) are not records and cannot be selected. */
export const isSyntheticId = (id: string) => isClusterId(id) || isPackageId(id)

export const isHolder = (n: ProjectedNode): n is HolderNode => n.kind !== 'object'

/** Whether a holder is drawn open, given a person's choices and the default. */
export function isOpen(
  id: string,
  defaultOpen: ReadonlySet<string>,
  expanded: ReadonlySet<string> = EMPTY,
  collapsed: ReadonlySet<string> = EMPTY,
): boolean {
  return expanded.has(id) || (defaultOpen.has(id) && !collapsed.has(id))
}

function byTypeThenLabel(a: ObjectVersion, b: ObjectVersion): number {
  return (
    compareTypes(a.type, b.type) ||
    objectLabel(a).localeCompare(objectLabel(b), 'en') ||
    a.id.localeCompare(b.id)
  )
}

function tally(counts: Record<string, number>, key: string | undefined) {
  if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1
}

// ---------- the tree ----------

type Tree =
  | { kind: 'object'; id: string; object: ObjectVersion; children: Tree[] }
  | { kind: 'package'; id: string; path: string; title: string; children: Tree[] }
  | { kind: 'cluster'; id: string; type: string; children: Tree[] }

const modulePath = (t: Tree): string | undefined => {
  if (t.kind !== 'object' || t.object.type !== 'software.Module') return undefined
  const path = (t.object.attributes as Record<string, unknown>).path
  return typeof path === 'string' && path.includes('/') ? path : undefined
}

/** The longest directory prefix (ending with a slash) shared by every path, or ''. */
export function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const dirs = paths.map((p) => p.slice(0, p.lastIndexOf('/') + 1))
  let prefix = dirs[0] as string
  for (const d of dirs) {
    while (!d.startsWith(prefix)) {
      const cut = prefix.slice(0, -1).lastIndexOf('/')
      prefix = cut < 0 ? '' : prefix.slice(0, cut + 1)
    }
  }
  return prefix
}

interface DirItem {
  dir: string
  members: Tree[]
}

/** Splits modules below `prefix` into directories (with at least `min` modules) and loose items. */
function splitLevel(prefix: string, items: readonly Tree[], min: number): (Tree | DirItem)[] {
  const dirs = new Map<string, Tree[]>()
  const loose: Tree[] = []
  for (const item of items) {
    const path = modulePath(item)
    const rest = path?.startsWith(prefix) ? path.slice(prefix.length) : undefined
    const slash = rest?.indexOf('/') ?? -1
    if (rest === undefined || slash < 0) {
      loose.push(item)
      continue
    }
    const dir = prefix + rest.slice(0, slash + 1)
    const list = dirs.get(dir) ?? []
    list.push(item)
    dirs.set(dir, list)
  }
  const out: (Tree | DirItem)[] = [...loose]
  for (const [dir, members] of dirs) {
    if (members.length >= min) out.push({ dir, members })
    else out.push(...members)
  }
  return out
}

const isDir = (x: Tree | DirItem): x is DirItem => 'dir' in x

const itemKey = (x: Tree | DirItem) => (isDir(x) ? x.dir : (modulePath(x) ?? `~${x.id}`))

/**
 * Groups a holder's modules into directory packages. Starting from the first directories below
 * the modules' common prefix, the largest directory is split into its own entries while the level
 * shows fewer than `target` items and the split keeps it under `target * 1.6`.
 */
function packageModules(
  holderId: string,
  children: readonly Tree[],
  target: number,
  min: number,
): Tree[] {
  const modules = children.filter((c) => modulePath(c) !== undefined)
  const others = children.filter((c) => modulePath(c) === undefined)
  if (modules.length <= target) return [...children]
  const max = Math.floor(target * 1.6)
  const levelPrefix = commonDirectory(modules.map((m) => modulePath(m) as string))
  let items = splitLevel(levelPrefix, modules, min)
  for (;;) {
    if (items.length + others.length >= target) break
    const largest = items
      .filter(isDir)
      .sort((a, b) => b.members.length - a.members.length || a.dir.localeCompare(b.dir))[0]
    if (!largest) break
    const inner = commonDirectory(largest.members.map((m) => modulePath(m) as string))
    const sub = splitLevel(inner, largest.members, min)
    if (items.length - 1 + sub.length + others.length > max) break
    items = [...items.filter((i) => i !== largest), ...sub]
  }
  items.sort((a, b) => itemKey(a).localeCompare(itemKey(b), 'en'))
  const out: Tree[] = []
  for (const item of items) {
    if (!isDir(item)) {
      out.push(item)
      continue
    }
    const id = packageId(holderId, item.dir)
    out.push({
      kind: 'package',
      id,
      path: item.dir,
      title: item.dir.slice(levelPrefix.length) || item.dir,
      children: packageModules(id, item.members, target, min),
    })
  }
  return [...out, ...others]
}

function collectMembers(tree: Tree, into: ObjectVersion[]) {
  for (const child of tree.children) {
    if (child.kind === 'object') into.push(child.object)
    collectMembers(child, into)
  }
}

// ---------- projection ----------

export function projectGraph(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
  options: ProjectionOptions = {},
): Projection {
  const expanded = options.expanded ?? EMPTY
  const collapsed = options.collapsed ?? EMPTY
  const hiddenObjectTypes = options.hiddenObjectTypes ?? EMPTY
  const hiddenRelationTypes = options.hiddenRelationTypes ?? EMPTY
  const clusterMin = options.clusterMin ?? DEFAULT_CLUSTER_MIN
  const packageTarget = options.packageTarget ?? DEFAULT_PACKAGE_TARGET
  const packageMin = options.packageMin ?? DEFAULT_PACKAGE_MIN

  const active = objects.filter((o) => o.lifecycle === 'active')
  const onCanvas = active.filter((o) => !OFF_CANVAS_TYPES.has(o.type))
  const canvasIds = new Set(onCanvas.map((o) => o.id))
  const visible = onCanvas.filter((o) => !hiddenObjectTypes.has(o.type)).sort(byTypeThenLabel)
  const byId = new Map(visible.map((o) => [o.id, o]))
  const activeRelations = relations.filter((r) => r.lifecycle === 'active')
  const canvasRelations = activeRelations.filter(
    (r) => canvasIds.has(r.from) && canvasIds.has(r.to),
  )

  // Structural parents over every canvas object, so hidden intermediate types are skipped over.
  const parentOf = new Map<string, string>()
  const exposers = new Map<string, string[]>()
  for (const r of canvasRelations) {
    if (r.type === 'contains') parentOf.set(r.to, r.from)
    if (r.type === 'exposes') exposers.set(r.to, [...(exposers.get(r.to) ?? []), r.from])
  }
  const chainOf = (id: string): string[] => {
    const chain: string[] = []
    const seen = new Set([id])
    for (let p = parentOf.get(id); p !== undefined && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p)
      chain.push(p)
    }
    return chain
  }
  // An endpoint belongs to the one module exposing it, when that module sits inside the endpoint's
  // own container (or the endpoint has none).
  for (const [endpoint, from] of exposers) {
    if (from.length !== 1) continue
    const module = from[0] as string
    const own = parentOf.get(endpoint)
    if (module === endpoint || chainOf(module).includes(endpoint)) continue
    if (own === undefined || chainOf(module).includes(own)) parentOf.set(endpoint, module)
  }
  const visibleParent = new Map<string, string>()
  for (const o of visible) {
    const parent = chainOf(o.id).find((p) => byId.has(p))
    if (parent !== undefined) visibleParent.set(o.id, parent)
  }

  // Object trees, children in type-then-label order.
  const trees = new Map<string, Tree & { kind: 'object' }>()
  for (const o of visible) trees.set(o.id, { kind: 'object', id: o.id, object: o, children: [] })
  const roots: Tree[] = []
  for (const o of visible) {
    const tree = trees.get(o.id) as Tree
    const parent = visibleParent.get(o.id)
    if (parent === undefined) roots.push(tree)
    else trees.get(parent)?.children.push(tree)
  }
  for (const tree of trees.values()) {
    if (tree.children.length > 0)
      tree.children = packageModules(tree.id, tree.children, packageTarget, packageMin)
  }

  // Top level: modules by directory, other plain elements of one type as clusters.
  const looseModules = packageModules('root', roots, packageTarget, packageMin)
  const byType = new Map<string, Tree[]>()
  for (const t of looseModules) {
    if (t.kind !== 'object' || UNCLUSTERED_TYPES.has(t.object.type) || t.children.length > 0)
      continue
    byType.set(t.object.type, [...(byType.get(t.object.type) ?? []), t])
  }
  const clustered = new Map<string, Tree>()
  for (const [type, list] of byType) {
    if (list.length < clusterMin) continue
    const cluster: Tree = { kind: 'cluster', id: clusterId(type), type, children: list }
    for (const t of list) clustered.set(t.id, cluster)
  }
  const top: Tree[] = []
  const placed = new Set<string>()
  for (const t of looseModules) {
    const cluster = clustered.get(t.id)
    if (!cluster) top.push(t)
    else if (!placed.has(cluster.id)) {
      placed.add(cluster.id)
      top.push(cluster)
    }
  }

  // Which holders are open by default.
  const defaultOpen = new Set<string>()
  const small = visible.length <= SMALL_MODEL
  for (const tree of trees.values()) {
    if (tree.children.length === 0) continue
    const type = tree.object.type
    if (type === 'software.System' || type === 'software.Module' || small) defaultOpen.add(tree.id)
  }
  // Then a container or package that is most of its level (one big box tells a reader nothing)
  // opens, the largest first, while its members fit the first view. A level that already shows
  // its parts stays as it is. Hidden folders (.github, .semgrep) are tooling and stay shut.
  if (!small) {
    const size = new Map<Tree, number>()
    const sizeOf = (t: Tree): number => {
      const known = size.get(t)
      if (known !== undefined) return known
      const n = t.children.length === 0 ? 1 : t.children.reduce((sum, c) => sum + sizeOf(c), 0)
      size.set(t, n)
      return n
    }
    const openable = (t: Tree) =>
      t.children.length > 0 &&
      ((t.kind === 'package' &&
        !(t.title ?? t.path).replace(/\/$/, '').split('/').pop()?.startsWith('.')) ||
        (t.kind === 'object' && AUTO_OPEN_TYPES.has(t.object.type)))
    let drawn = top.length
    const reachable: Tree[] = []
    const reach = (trees: readonly Tree[]) => {
      const level = trees.reduce((sum, t) => sum + sizeOf(t), 0)
      for (const t of trees) {
        if (t.kind === 'cluster' || t.children.length === 0) continue
        if (defaultOpen.has(t.id)) {
          drawn += t.children.length
          reach(t.children)
        } else if (openable(t) && sizeOf(t) >= DOMINANT_SHARE * level) reachable.push(t)
      }
    }
    reach(top)
    for (;;) {
      const fits = reachable
        .filter((t) => drawn + t.children.length <= FIRST_VIEW_BUDGET)
        .sort((a, b) => sizeOf(b) - sizeOf(a))
      const next = fits[0]
      if (!next) break
      reachable.splice(reachable.indexOf(next), 1)
      defaultOpen.add(next.id)
      drawn += next.children.length
      reach(next.children)
    }
  }

  // Walk the tree: nodes in render order, representatives and ancestors.
  const nodes: ProjectedNode[] = []
  const representative = new Map<string, string>()
  const containerOf = new Map<string, string>()
  const ancestors = new Map<string, string[]>()
  const expandable: string[] = []
  const freshnessCounts = (members: readonly ObjectVersion[]) => {
    const counts: Record<string, number> = {}
    if (options.freshnessOf) for (const m of members) tally(counts, options.freshnessOf(m.id))
    return counts
  }

  const walk = (
    tree: Tree,
    chain: string[],
    drawnAs: string | undefined,
    parent: Tree | undefined,
  ) => {
    ancestors.set(tree.id, chain)
    if (tree.kind === 'object') {
      representative.set(tree.id, drawnAs ?? tree.id)
      const holder = chain[chain.length - 1]
      if (holder !== undefined) containerOf.set(tree.id, holder)
    }
    const holder = tree.children.length > 0
    const open = holder && isOpen(tree.id, defaultOpen, expanded, collapsed)
    if (drawnAs === undefined) {
      const base = {
        id: tree.id,
        depth: chain.length,
        ...(chain.length > 0 ? { parentId: chain[chain.length - 1] as string } : {}),
      }
      if (!holder && tree.kind === 'object') {
        const row =
          ROW_TYPES.has(tree.object.type) &&
          parent?.kind === 'object' &&
          parent.object.type === 'software.Module'
        nodes.push({ kind: 'object', ...base, object: tree.object, row })
      } else {
        const members: ObjectVersion[] = []
        collectMembers(tree, members)
        const memberCounts: Record<string, number> = {}
        for (const m of members) tally(memberCounts, m.type)
        const holderBase = {
          ...base,
          expanded: open,
          memberIds: members.map((m) => m.id),
          memberCounts,
          memberFreshness: freshnessCounts(members),
        }
        if (tree.kind === 'object')
          nodes.push({ kind: 'group', ...holderBase, object: tree.object })
        else if (tree.kind === 'package')
          nodes.push({ kind: 'package', ...holderBase, path: tree.path, title: tree.title })
        else nodes.push({ kind: 'cluster', ...holderBase, type: tree.type })
      }
    }
    if (holder) expandable.push(tree.id)
    const childDrawnAs = drawnAs ?? (open ? undefined : tree.id)
    const childChain = holder ? [...chain, tree.id] : chain
    for (const child of tree.children) walk(child, childChain, childDrawnAs, tree)
  }
  // Parents precede children: emit level by level within each top-level tree.
  for (const t of top) walk(t, [], undefined, undefined)
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  nodes.sort(
    (a, b) => a.depth - b.depth || (order.get(a.id) as number) - (order.get(b.id) as number),
  )

  // Edges.
  let hiddenRelations = 0
  let internalRelations = 0
  let detailRelations = 0
  /** Merged import edges between frames inside one holder: thinned to a backbone below. */
  const bundled = new Set<string>()
  const showDetail = options.detail === 'all'
  const drawnById = new Map(nodes.map((n) => [n.id, n]))
  const merged = new Map<string, Omit<ProjectedEdge, 'parallelIndex' | 'parallelCount'>>()
  for (const r of canvasRelations) {
    if (hiddenRelationTypes.has(r.type) || !byId.has(r.from) || !byId.has(r.to)) {
      hiddenRelations++
      continue
    }
    const drawnSource = representative.get(r.from) as string
    const drawnTarget = representative.get(r.to) as string
    if (drawnSource === drawnTarget) {
      internalRelations++
      continue
    }
    // Nesting already shows that an open holder holds this member.
    if (
      STRUCTURAL_RELATIONS.has(r.type) &&
      drawnSource === r.from &&
      (ancestors.get(r.to) ?? []).includes(r.from)
    ) {
      internalRelations++
      continue
    }
    // Between different frames, the edge joins the frames that separate its ends, unless one end
    // is drawn in full: then a person sees exactly where it goes.
    const exact =
      options.lift === false ||
      (options.exactFor !== undefined &&
        (drawnSource === options.exactFor || drawnTarget === options.exactFor))
    const [source, target] = exact
      ? [drawnSource, drawnTarget]
      : siblingsBetween(drawnSource, drawnTarget, ancestors)
    // Imports between two modules of one container are detail: drawn for the selection, or on
    // request. Imports between packages or other frames bundle many of them and show how the
    // container is put together, so they are drawn.
    if (!exact && !showDetail && DETAIL_RELATIONS.has(r.type)) {
      const level = (ancestors.get(source) ?? []).at(-1)
      const holder = level === undefined ? undefined : drawnById.get(level)
      const between =
        drawnById.get(source)?.kind === 'object' || drawnById.get(target)?.kind === 'object'
      const inside =
        holder && !(holder.kind === 'group' && holder.object.type === 'software.System')
      if (inside && between) {
        detailRelations++
        continue
      }
      if (inside) bundled.add(`${source}>${target}:${r.type}:${r.claim.basis}`)
    }
    const basis = r.claim.basis
    const key = `${source}>${target}:${r.type}:${basis}`
    const existing = merged.get(key)
    if (existing) {
      existing.relationIds.push(r.id)
      existing.aggregated = true
      existing.toBe = existing.toBe && r.stance === 'toBe'
    } else {
      merged.set(key, {
        id: `e:${key}`,
        source,
        target,
        type: r.type,
        basis,
        toBe: r.stance === 'toBe',
        relationIds: [r.id],
        aggregated: source !== r.from || target !== r.to,
      })
    }
  }

  // Packages of one codebase import each other densely (a Django app has hundreds of such links,
  // many in cycles). A frame most of its siblings import is a hub: its links would make a star,
  // so the hub says how many import it instead. Every other frame keeps only its strongest
  // import, so the structure reads; selecting a frame draws all of its links exactly.
  const importers = new Map<string, Set<string>>()
  for (const key of bundled) {
    const e = merged.get(key)
    if (e) importers.set(e.target, (importers.get(e.target) ?? new Set()).add(e.source))
  }
  const siblings = new Map<string | undefined, number>()
  // Frames only: a loose module's imports are detail, so it neither counts nor votes.
  for (const n of nodes)
    if (n.kind !== 'object') siblings.set(n.parentId, (siblings.get(n.parentId) ?? 0) + 1)
  const hubs = new Map<string, number>()
  for (const [target, from] of importers) {
    const others = (siblings.get(drawnById.get(target)?.parentId) ?? 1) - 1
    if (from.size >= 5 && from.size >= others / 2) hubs.set(target, from.size)
  }
  for (const n of nodes) {
    const count = hubs.get(n.id)
    if (count !== undefined && n.kind !== 'object') n.importedBy = count
  }
  const strongest = new Map<string, string>()
  for (const key of bundled) {
    const e = merged.get(key)
    if (!e || hubs.has(e.target)) continue
    const best = strongest.get(e.source)
    const other = best ? merged.get(best) : undefined
    if (!other || e.relationIds.length > other.relationIds.length) strongest.set(e.source, key)
  }
  const kept = new Set(strongest.values())
  for (const key of bundled) {
    const e = merged.get(key)
    if (!e || kept.has(key)) continue
    detailRelations += e.relationIds.length
    merged.delete(key)
  }

  const edges = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
  const pairs = new Map<string, number>()
  const pairKey = (e: { source: string; target: string }) =>
    e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
  for (const e of edges) pairs.set(pairKey(e), (pairs.get(pairKey(e)) ?? 0) + 1)
  const seenPairs = new Map<string, number>()
  const finalEdges: ProjectedEdge[] = edges.map((e) => {
    const key = pairKey(e)
    const index = seenPairs.get(key) ?? 0
    seenPairs.set(key, index + 1)
    return { ...e, parallelIndex: index, parallelCount: pairs.get(key) ?? 1 }
  })

  return {
    nodes,
    edges: finalEdges,
    representative,
    containerOf,
    ancestors,
    expandable,
    defaultOpen,
    stats: {
      objects: visible.length,
      relations: canvasRelations.length - hiddenRelations,
      hiddenObjects: onCanvas.length - visible.length,
      hiddenRelations,
      internalRelations,
      detailRelations,
      offCanvas: active.length - onCanvas.length,
    },
  }
}

/** Type counts for the filter UI, over active records drawn on the canvas. */
export function typeCounts(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
): { objectTypes: [string, number][]; relationTypes: [string, number][] } {
  const o: Record<string, number> = {}
  const r: Record<string, number> = {}
  const onCanvas = new Set<string>()
  for (const x of objects) {
    if (x.lifecycle !== 'active' || OFF_CANVAS_TYPES.has(x.type)) continue
    onCanvas.add(x.id)
    tally(o, x.type)
  }
  for (const x of relations)
    if (x.lifecycle === 'active' && onCanvas.has(x.from) && onCanvas.has(x.to)) tally(r, x.type)
  return {
    objectTypes: Object.entries(o).sort(([a], [b]) => compareTypes(a, b)),
    relationTypes: Object.entries(r).sort(([a], [b]) => a.localeCompare(b)),
  }
}

/**
 * The two nodes that stand for an edge's ends at the level where they meet: the ancestors (or
 * the ends themselves) just below their deepest common holder. When one end holds the other, the
 * ends are kept.
 */
export function siblingsBetween(
  source: string,
  target: string,
  ancestors: ReadonlyMap<string, readonly string[]>,
): [string, string] {
  const a = [...(ancestors.get(source) ?? []), source]
  const b = [...(ancestors.get(target) ?? []), target]
  let k = 0
  while (k < a.length && k < b.length && a[k] === b[k]) k++
  if (k >= a.length || k >= b.length) return [source, target]
  return [a[k] as string, b[k] as string]
}

/** The holders to open so that an object is drawn itself. */
export function holdersToOpen(projection: Projection, objectId: string): string[] {
  return projection.ancestors.get(objectId) ?? []
}
