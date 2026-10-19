import '@xyflow/react/dist/base.css'
import * as Popover from '@radix-ui/react-popover'
import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { FoldVertical, Funnel, Info, LocateFixed, Search, UnfoldVertical } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClaimFreshness } from '../api/freshness.ts'
import { useWorkbench } from '../app/workbench.ts'
import { EdgeSample, StatusBadge, TypeLabel } from '../components/badges.tsx'
import { BASIS_ICONS, FRESHNESS_ICONS } from '../components/icons.tsx'
import { Button, EmptyState, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural } from '../model/format.ts'
import { objectLabel } from '../model/labels.ts'
import { searchObjects } from '../model/search.ts'
import {
  BASIS_META,
  BASIS_ORDER,
  FRESHNESS_META,
  objectTypeMeta,
  relationMeta,
} from '../model/semantics.ts'
import { ErrorNotice } from '../views/shared.tsx'
import { EdgeMarkers, edgeTypes, type RelationFlowEdge } from './edges.tsx'
import { layoutProjection } from './layout.ts'
import { type GroupFlowNode, nodeTypes, type ObjectFlowNode } from './nodes.tsx'
import { isClusterId, type Projection, projectGraph, typeCounts } from './projection.ts'

type FlowNode = ObjectFlowNode | GroupFlowNode

/** Graph view state survives tab switches within a project (module scope, per project). */
interface GraphPrefs {
  expanded: Set<string>
  hiddenObjectTypes: Set<string>
  hiddenRelationTypes: Set<string>
  legend: boolean
}
const prefsByProject = new Map<string, GraphPrefs>()
function initialPrefs(projectId: string): GraphPrefs {
  return (
    prefsByProject.get(projectId) ?? {
      expanded: new Set(),
      hiddenObjectTypes: new Set(),
      hiddenRelationTypes: new Set(),
      legend: true,
    }
  )
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function GraphView() {
  const wb = useWorkbench()
  if (wb.modelError) {
    return (
      <div className="p-6">
        <ErrorNotice error={wb.modelError} title="The model could not be loaded" />
      </div>
    )
  }
  if (!wb.model) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-fg-muted">
        <Spinner /> Loading the model…
      </div>
    )
  }
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  )
}

function GraphCanvas() {
  const wb = useWorkbench()
  const model = wb.model as NonNullable<typeof wb.model>
  const flow = useReactFlow<FlowNode, RelationFlowEdge>()
  // Arriving with a selection hidden in a collapsed group (a deep link, or a pick in another
  // view) expands that group once and focuses it, so the selection is visible.
  const [initial] = useState(() => {
    const prefs = initialPrefs(wb.projectId)
    const holder = wb.selection
      ? projectGraph(model.objects, model.relations, prefs).containerOf.get(wb.selection)
      : undefined
    if (holder === undefined || prefs.expanded.has(holder)) return { prefs, focus: null }
    return { prefs: { ...prefs, expanded: new Set(prefs.expanded).add(holder) }, focus: holder }
  })
  const [prefs, setPrefs] = useState<GraphPrefs>(initial.prefs)
  useEffect(() => {
    prefsByProject.set(wb.projectId, prefs)
  }, [wb.projectId, prefs])
  const [focusTarget, setFocusTarget] = useState<string | null>(initial.focus)

  const freshnessOf = useCallback(
    (id: string) => wb.freshness.index.get(id)?.status,
    [wb.freshness.index],
  )
  const projection = useMemo(
    () =>
      projectGraph(model.objects, model.relations, {
        expanded: prefs.expanded,
        hiddenObjectTypes: prefs.hiddenObjectTypes,
        hiddenRelationTypes: prefs.hiddenRelationTypes,
        ...(wb.freshness.available ? { freshnessOf } : {}),
      }),
    [
      model,
      prefs.expanded,
      prefs.hiddenObjectTypes,
      prefs.hiddenRelationTypes,
      wb.freshness.available,
      freshnessOf,
    ],
  )
  const layout = useMemo(() => layoutProjection(projection), [projection])

  const toggle = useCallback((id: string) => {
    setPrefs((p) => {
      const expanded = new Set(p.expanded)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return { ...p, expanded }
    })
    setFocusTarget(id)
  }, [])

  // Selection: the selected record's node, or the collapsed group standing in for it.
  const selected = wb.selection
  const selectedNode = selected ? (projection.representative.get(selected) ?? selected) : undefined
  const neighbourhood = useMemo(() => {
    if (!selectedNode) return null
    const ids = new Set<string>([selectedNode])
    for (const e of projection.edges) {
      if (e.source === selectedNode) ids.add(e.target)
      if (e.target === selectedNode) ids.add(e.source)
    }
    return ids
  }, [projection, selectedNode])

  const nodes = useMemo(
    () =>
      toFlowNodes(
        projection,
        layout.boxes,
        wb.freshness.index,
        selected,
        selectedNode,
        neighbourhood,
        toggle,
      ),
    [projection, layout, wb.freshness.index, selected, selectedNode, neighbourhood, toggle],
  )
  const edges = useMemo(
    () => toFlowEdges(projection, selected, selectedNode, model.nameOf),
    [projection, selected, selectedNode, model.nameOf],
  )

  // Fit the whole graph on first render; after expanding or collapsing, bring that group into view.
  // The padding keeps fitted content clear of the legend panel.
  const fitted = useRef(false)
  const padding = useMemo(
    () =>
      ({
        top: '28px',
        bottom: '28px',
        left: '28px',
        right: prefs.legend ? '280px' : '28px',
      }) as const,
    [prefs.legend],
  )
  const fitAll = useCallback(
    (duration: number) => void flow.fitView({ padding, maxZoom: 1.1, duration }),
    [flow, padding],
  )
  useEffect(() => {
    const duration = reducedMotion() ? 0 : 280
    const frame = requestAnimationFrame(() => {
      if (nodes.length === 0) return
      if (!fitted.current && !focusTarget) {
        fitted.current = true
        fitAll(0)
      } else if (focusTarget) {
        const first = !fitted.current
        fitted.current = true
        void flow.fitView({
          nodes: [{ id: focusTarget }],
          padding,
          maxZoom: 1.1,
          duration: first ? 0 : duration,
        })
        setFocusTarget(null)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [flow, focusTarget, nodes.length, fitAll, padding])

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'select' && change.selected) {
          if (!isClusterId(change.id)) wb.select(change.id)
        }
      }
    },
    [wb],
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange<RelationFlowEdge>[]) => {
      for (const change of changes) {
        if (change.type !== 'select' || !change.selected) continue
        const edge = projection.edges.find((e) => e.id === change.id)
        if (!edge) continue
        if (edge.relationIds.length === 1) wb.select(edge.relationIds[0])
        else
          wb.selectGroup({
            title: `${model.nameOf(edge.source) ?? clusterTitle(edge.source)} —${edge.type}→ ${model.nameOf(edge.target) ?? clusterTitle(edge.target)}`,
            relationIds: edge.relationIds,
          })
      }
    },
    [projection, wb, model],
  )

  const reveal = useCallback(
    (objectId: string) => {
      const holder = projection.containerOf.get(objectId)
      if (holder && !prefs.expanded.has(holder)) {
        setPrefs((p) => ({ ...p, expanded: new Set(p.expanded).add(holder) }))
      }
      wb.select(objectId)
      setFocusTarget(objectId)
    },
    [projection, prefs.expanded, wb],
  )

  const counts = useMemo(() => typeCounts(model.objects, model.relations), [model])

  if (model.objects.length === 0) {
    return (
      <EmptyState title="No objects at this revision" className="h-full">
        Objects appear here once a proposal that creates them is committed.
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        projection={projection}
        prefs={prefs}
        setPrefs={setPrefs}
        counts={counts}
        onReveal={reveal}
        onFit={() => fitAll(reducedMotion() ? 0 : 280)}
      />
      <div className="relative min-h-0 flex-1">
        <EdgeMarkers />
        <ReactFlow<FlowNode, RelationFlowEdge>
          className="kalyth-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onPaneClick={() => wb.select(undefined)}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          selectNodesOnDrag={false}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: false }}
          attributionPosition="bottom-center"
          ariaLabelConfig={{
            'node.a11yDescription.default':
              'Press Enter or Space to select and inspect. Use the expand button inside groups to show their members.',
          }}
          aria-label="Model graph"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.2}
            color="var(--k-canvas-dot)"
          />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            ariaLabel="Overview of the graph"
            nodeColor={(n) =>
              n.type === 'object' ? 'var(--k-surface-3)' : 'var(--k-border-strong)'
            }
            nodeStrokeColor="var(--k-border-strong)"
            nodeBorderRadius={4}
          />
          {prefs.legend && (
            <Panel position="top-right">
              <Legend
                projection={projection}
                freshness={wb.freshness.available}
                onClose={() => setPrefs((p) => ({ ...p, legend: false }))}
              />
            </Panel>
          )}
        </ReactFlow>
      </div>
    </div>
  )
}

function clusterTitle(id: string): string {
  return isClusterId(id) ? objectTypeMeta(id.slice('cluster:'.length)).label : id
}

// ---------- projection -> React Flow ----------

function toFlowNodes(
  projection: Projection,
  boxes: ReturnType<typeof layoutProjection>['boxes'],
  freshness: ReadonlyMap<string, ClaimFreshness>,
  selected: string | undefined,
  selectedNode: string | undefined,
  neighbourhood: Set<string> | null,
  onToggle: (id: string) => void,
): FlowNode[] {
  const dim = (id: string, parentId: string | undefined) =>
    neighbourhood !== null && !neighbourhood.has(id) && !(parentId && neighbourhood.has(parentId))
  return projection.nodes.map((n): FlowNode => {
    const box = boxes.get(n.id) ?? { x: 0, y: 0, width: 200, height: 60 }
    const base = {
      id: n.id,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      // The layout knows every size; passing it as measured keeps fitView and the minimap exact
      // when node objects are rebuilt (React Flow would otherwise wait for a resize to re-measure).
      measured: { width: box.width, height: box.height },
      selected: n.id === selected,
      ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
    }
    if (n.kind === 'object') {
      return {
        ...base,
        type: 'object',
        ariaLabel: `${objectTypeMeta(n.object.type).label} ${objectLabel(n.object)}, ${BASIS_META[n.object.claim.basis as keyof typeof BASIS_META]?.label ?? n.object.claim.basis}`,
        data: {
          object: n.object,
          freshness: freshness.get(n.id)?.status,
          holdsSelection: false,
          dimmed: dim(n.id, n.parentId),
        },
      }
    }
    const holdsSelection = selected !== undefined && selected !== n.id && selectedNode === n.id
    const memberCounts = n.kind === 'group' ? n.memberCounts : { [n.type]: n.memberIds.length }
    const total = n.memberIds.length
    const name = n.kind === 'group' ? objectLabel(n.object) : objectTypeMeta(n.type).label
    return {
      ...base,
      type: n.kind,
      selected: n.kind === 'group' && n.id === selected,
      selectable: n.kind === 'group',
      ariaLabel: `${n.kind === 'group' ? objectTypeMeta(n.object.type).label : 'Group of'} ${name}, ${plural(total, 'member')}, ${n.expanded ? 'expanded' : 'collapsed'}`,
      data: {
        ...(n.kind === 'group' ? { object: n.object } : { clusterType: n.type }),
        expanded: n.expanded,
        memberCounts,
        memberFreshness: n.memberFreshness,
        holdsSelection,
        dimmed: !n.expanded && dim(n.id, undefined),
        onToggle,
      },
    }
  })
}

function toFlowEdges(
  projection: Projection,
  selected: string | undefined,
  selectedNode: string | undefined,
  nameOf: (id: string) => string | undefined,
): RelationFlowEdge[] {
  return projection.edges.map((e) => {
    const basisLabel = BASIS_META[e.basis as keyof typeof BASIS_META]?.label ?? e.basis
    const count = e.relationIds.length
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'relation',
      selected: count === 1 && e.relationIds[0] === selected,
      ariaLabel: `${e.type} from ${nameOf(e.source) ?? clusterTitle(e.source)} to ${nameOf(e.target) ?? clusterTitle(e.target)}, ${basisLabel}${count > 1 ? `, ${count} relations` : ''}`,
      data: {
        relationType: e.type,
        basis: e.basis,
        count,
        aggregated: e.aggregated,
        parallelIndex: e.parallelIndex,
        parallelCount: e.parallelCount,
        dimmed:
          selectedNode !== undefined && e.source !== selectedNode && e.target !== selectedNode,
      },
    }
  })
}

// ---------- toolbar, filters, legend ----------

function Toolbar({
  projection,
  prefs,
  setPrefs,
  counts,
  onReveal,
  onFit,
}: {
  projection: Projection
  prefs: GraphPrefs
  setPrefs: (update: (p: GraphPrefs) => GraphPrefs) => void
  counts: ReturnType<typeof typeCounts>
  onReveal: (id: string) => void
  onFit: () => void
}) {
  const hidden = prefs.hiddenObjectTypes.size + prefs.hiddenRelationTypes.size
  const allExpanded =
    projection.expandable.length > 0 && projection.expandable.every((id) => prefs.expanded.has(id))
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-surface px-3 py-2">
      <GraphSearch onReveal={onReveal} />
      <FilterMenu counts={counts} prefs={prefs} setPrefs={setPrefs} hidden={hidden} />
      <span aria-hidden className="mx-1 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        disabled={projection.expandable.length === 0}
        onClick={() =>
          setPrefs((p) => ({
            ...p,
            expanded: allExpanded ? new Set() : new Set(projection.expandable),
          }))
        }
      >
        {allExpanded ? <FoldVertical aria-hidden /> : <UnfoldVertical aria-hidden />}
        {allExpanded ? 'Collapse all' : 'Expand all'}
      </Button>
      <Button size="sm" variant="ghost" onClick={onFit}>
        <LocateFixed aria-hidden /> Fit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={prefs.legend}
        onClick={() => setPrefs((p) => ({ ...p, legend: !p.legend }))}
      >
        <Info aria-hidden /> Legend
      </Button>
      <p className="ml-auto text-fg-muted text-xs tabular-nums">
        {plural(projection.nodes.length, 'node')} · {plural(projection.edges.length, 'edge')}
        <span className="text-fg-subtle">
          {' '}
          for {plural(projection.stats.objects, 'object')},{' '}
          {plural(projection.stats.relations, 'relation')}
          {projection.stats.hiddenObjects + projection.stats.hiddenRelations > 0 &&
            ` · ${projection.stats.hiddenObjects + projection.stats.hiddenRelations} filtered`}
        </span>
      </p>
    </div>
  )
}

function GraphSearch({ onReveal }: { onReveal: (id: string) => void }) {
  const wb = useWorkbench()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const listId = 'graph-search-results'
  const matches = useMemo(() => {
    if (!wb.model) return []
    return searchObjects(wb.model.objects, query, 8)
  }, [query, wb.model])
  const choose = (id: string) => {
    onReveal(id)
    setOpen(false)
  }
  return (
    <div className="relative">
      <label className="relative flex items-center">
        <span className="sr-only">Find an object</span>
        <Search aria-hidden className="pointer-events-none absolute left-2 size-4 text-fg-subtle" />
        <input
          data-view-search
          type="search"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          value={query}
          placeholder="Find and focus an object  /"
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              setActive((a) => Math.min(a + 1, matches.length - 1))
              e.preventDefault()
            } else if (e.key === 'ArrowUp') {
              setActive((a) => Math.max(a - 1, 0))
              e.preventDefault()
            } else if (e.key === 'Enter' && matches[active]) {
              choose(matches[active].id)
              e.preventDefault()
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          className="h-8 w-64 rounded-md border border-border-strong bg-surface pr-2 pl-8 text-sm placeholder:text-fg-subtle"
        />
      </label>
      {open && matches.length > 0 && (
        <div
          id={listId}
          role="listbox"
          aria-label="Matching objects"
          className="absolute top-9 left-0 z-40 w-80 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-pop"
        >
          {matches.map((o, i) => (
            <div
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(o.id)
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm',
                i === active && 'bg-accent-soft',
              )}
            >
              <TypeLabel type={o.type} className="w-24 shrink-0 text-fg-muted text-xs" />
              <span className="truncate">{objectLabel(o)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FilterMenu({
  counts,
  prefs,
  setPrefs,
  hidden,
}: {
  counts: ReturnType<typeof typeCounts>
  prefs: GraphPrefs
  setPrefs: (update: (p: GraphPrefs) => GraphPrefs) => void
  hidden: number
}) {
  const toggle = (key: 'hiddenObjectTypes' | 'hiddenRelationTypes', type: string) =>
    setPrefs((p) => {
      const next = new Set(p[key])
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return { ...p, [key]: next }
    })
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant={hidden > 0 ? 'primary' : 'secondary'}>
          <Funnel aria-hidden /> Filter
          {hidden > 0 && <span className="tabular-nums">· {hidden} hidden</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 grid w-[520px] grid-cols-2 gap-4 rounded-lg border border-border bg-surface p-3 shadow-pop"
        >
          <fieldset className="min-w-0">
            <legend className="mb-1.5 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
              Object types
            </legend>
            <ul className="space-y-0.5">
              {counts.objectTypes.map(([type, n]) => (
                <li key={type}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--k-accent)]"
                      checked={!prefs.hiddenObjectTypes.has(type)}
                      onChange={() => toggle('hiddenObjectTypes', type)}
                    />
                    <TypeLabel type={type} className="min-w-0 flex-1 text-sm" />
                    <span className="font-mono text-fg-subtle text-xs tabular-nums">{n}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
              Relation types
            </legend>
            <ul className="space-y-0.5">
              {counts.relationTypes.map(([type, n]) => (
                <li key={type}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--k-accent)]"
                      checked={!prefs.hiddenRelationTypes.has(type)}
                      onChange={() => toggle('hiddenRelationTypes', type)}
                    />
                    <EdgeSample color={relationMeta(type).color} dash={undefined} width={16} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{type}</span>
                    <span className="font-mono text-fg-subtle text-xs tabular-nums">{n}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-2xs text-fg-subtle">
              Hiding <span className="font-mono">contains</span> hides its edges; grouping by
              container stays.
            </p>
          </fieldset>
          <div className="col-span-2 flex justify-end gap-2 border-border border-t pt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setPrefs((p) => ({
                  ...p,
                  hiddenObjectTypes: new Set(),
                  hiddenRelationTypes: new Set(),
                }))
              }
            >
              Show everything
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Legend({
  projection,
  freshness,
  onClose,
}: {
  projection: Projection
  freshness: boolean
  onClose: () => void
}) {
  const relationTypes = [...new Set(projection.edges.map((e) => e.type))].sort()
  return (
    <section
      aria-label="Legend"
      className="w-60 rounded-lg border border-border bg-surface/95 p-3 text-xs shadow-pop backdrop-blur-sm"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
          Legend
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1 text-fg-subtle text-xs hover:bg-surface-2 hover:text-fg"
        >
          Hide
        </button>
      </div>
      <p className="mb-1 font-medium text-fg-muted">Claim basis · line and border</p>
      <ul className="mb-3 space-y-1">
        {BASIS_ORDER.map((b) => {
          const meta = BASIS_META[b]
          return (
            <li key={b} className="flex items-center gap-2" title={meta.description}>
              <EdgeSample color="var(--k-fg-muted)" dash={meta.dash} width={30} />
              <StatusBadge tone={meta.tone} icon={BASIS_ICONS[b]} label={meta.label} size="sm" />
            </li>
          )
        })}
      </ul>
      {relationTypes.length > 0 && (
        <>
          <p className="mb-1 font-medium text-fg-muted">Relation type · colour</p>
          <ul className="mb-3 grid grid-cols-2 gap-x-2 gap-y-1">
            {relationTypes.map((t) => (
              <li
                key={t}
                className="flex min-w-0 items-center gap-1.5"
                title={relationMeta(t).description}
              >
                <EdgeSample color={relationMeta(t).color} dash={undefined} width={14} />
                <span className="truncate font-mono text-[11px]">{t}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-fg-subtle leading-snug">
        A number on an edge counts the relations it stands for. Hatched nodes are to-be (intended).
      </p>
      {freshness && (
        <>
          <p className="mt-3 mb-1 font-medium text-fg-muted">Freshness</p>
          <ul className="flex flex-wrap gap-1">
            {(['current', 'weakened', 'stale', 'derived-stale', 'unknown'] as const).map((s) => (
              <li key={s}>
                <StatusBadge
                  tone={FRESHNESS_META[s].tone}
                  icon={FRESHNESS_ICONS[s]}
                  label={FRESHNESS_META[s].label}
                  description={FRESHNESS_META[s].description}
                  size="sm"
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
