import '@xyflow/react/dist/base.css'
import type { DecisionSummary, ObjectVersion } from '@kalyth/contracts'
import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeChange,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_IMPACT_SEEDS, type RevisionModel, useDecisions, useImpact } from '../api/queries.ts'
import { type Lens, useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { Button, EmptyState, Spinner } from '../components/ui.tsx'
import { plural, typePlural } from '../model/format.ts'
import { objectDetail, objectLabel, objectShortLabel } from '../model/labels.ts'
import { basisMeta, compareTypes, objectTypeMeta } from '../model/semantics.ts'
import { ErrorNotice, withoutHandles } from '../views/shared.tsx'
import { EdgeMarkers, edgeTypes, type RelationFlowEdge } from './edges.tsx'
import { EditFlow, type EditKind } from './edit.tsx'
import { renameField } from './edits.ts'
import { readableViewport } from './geometry.ts'
import { type Box, type LayoutResult, layoutProjection, routeBetween } from './layout.ts'
import {
  alternativeKey,
  chooseAlternative,
  DEFAULT_LENS,
  decisionMarks,
  focusSet,
  type Hops,
  impactCaption,
  impactMarks,
  isDimmed,
  lensDescription,
  NEEDS_REVIEW,
  revisionMarks,
  shownDecisions,
} from './lens.ts'
import {
  type HolderFlowNode,
  type HolderNodeData,
  type NodeMarks,
  nodeTypes,
  type ObjectFlowNode,
} from './nodes.tsx'
import { Caption, Legend, sourceLine, TitleBlock, type TitleBlockData } from './overlays.tsx'
import {
  isOpen,
  isSyntheticId,
  OFF_CANVAS_TYPES,
  type ProjectedNode,
  type Projection,
  projectGraph,
  typeCounts,
} from './projection.ts'
import { GraphToolbar } from './toolbar.tsx'

type FlowNode = ObjectFlowNode | HolderFlowNode

/** Canvas state that survives view switches within a project (module scope, per project). */
export interface GraphPrefs {
  expanded: Set<string>
  collapsed: Set<string>
  hiddenObjectTypes: Set<string>
  hiddenRelationTypes: Set<string>
  legend: boolean
  hops: Hops
  /** Draw imports between members of a container always, not only for the selection. */
  imports: boolean
}
const prefsByProject = new Map<string, GraphPrefs>()
function initialPrefs(projectId: string): GraphPrefs {
  return (
    prefsByProject.get(projectId) ?? {
      expanded: new Set(),
      collapsed: new Set(),
      hiddenObjectTypes: new Set(),
      hiddenRelationTypes: new Set(),
      legend: true,
      hops: 0,
      imports: false,
    }
  )
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function GraphView() {
  const wb = useWorkbench()
  // While a new revision loads (after a commit, say), the canvas keeps the previous one, so it
  // and any open dialog stay where they are.
  const last = useRef<{ projectId: string; model: RevisionModel } | null>(null)
  if (wb.model) last.current = { projectId: wb.projectId, model: wb.model }
  const model =
    wb.model ?? (last.current?.projectId === wb.projectId ? last.current.model : undefined)
  if (wb.modelError) {
    return (
      <div className="p-6">
        <ErrorNotice error={wb.modelError} title="The model could not be loaded" />
      </div>
    )
  }
  if (!model) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-fg-muted">
        <Spinner /> Loading the model…
      </div>
    )
  }
  return (
    <ReactFlowProvider>
      <GraphCanvas model={model} />
    </ReactFlowProvider>
  )
}

/** Opens every holder in `ids`. */
function openAll(p: GraphPrefs, ids: readonly string[]): GraphPrefs {
  if (ids.length === 0) return p
  const expanded = new Set(p.expanded)
  const collapsed = new Set(p.collapsed)
  for (const id of ids) {
    expanded.add(id)
    collapsed.delete(id)
  }
  return { ...p, expanded, collapsed }
}

function GraphCanvas({ model }: { model: RevisionModel }) {
  const wb = useWorkbench()
  const [loc, navigate] = useAppLocation()
  const lens: Lens = loc.lens ?? DEFAULT_LENS
  const flow = useReactFlow<FlowNode, RelationFlowEdge>()
  const paneWidth = useStore((s) => s.width)
  const paneHeight = useStore((s) => s.height)

  // Arriving with a selection hidden in a collapsed holder (a deep link, or a pick in another
  // view) opens its holders once and focuses it, so the selection is visible.
  const [initial] = useState(() => {
    const prefs = initialPrefs(wb.projectId)
    if (!wb.selection) return { prefs, focus: null as string | null }
    const p = projectGraph(model.objects, model.relations, prefs)
    const holders = p.ancestors.get(wb.selection) ?? []
    const closed = holders.filter((h) => !isOpen(h, p.defaultOpen, prefs.expanded, prefs.collapsed))
    if (closed.length === 0) return { prefs, focus: wb.selection }
    return { prefs: openAll(prefs, closed), focus: wb.selection }
  })
  const [prefs, setPrefs] = useState<GraphPrefs>(initial.prefs)
  useEffect(() => {
    prefsByProject.set(wb.projectId, prefs)
  }, [wb.projectId, prefs])
  const [focusTarget, setFocusTarget] = useState<string[] | null>(
    initial.focus ? [initial.focus] : null,
  )
  const [edit, setEdit] = useState<EditKind | null>(null)
  /** The zoom floor for the next focus: lower when showing an alternative's spread of changes. */
  const focusFloor = useRef<number | undefined>(undefined)

  const freshnessOf = useCallback(
    (id: string) => wb.freshness.index.get(id)?.status,
    [wb.freshness.index],
  )
  const projection = useMemo(
    () =>
      projectGraph(model.objects, model.relations, {
        expanded: prefs.expanded,
        collapsed: prefs.collapsed,
        hiddenObjectTypes: prefs.hiddenObjectTypes,
        hiddenRelationTypes: prefs.hiddenRelationTypes,
        detail: prefs.imports ? 'all' : 'selection',
        ...(wb.freshness.available ? { freshnessOf } : {}),
      }),
    [model, prefs, wb.freshness.available, freshnessOf],
  )
  const layout = useMemo(() => layoutProjection(projection), [projection])

  // ---------- lens data ----------
  const decisionsQuery = useDecisions(wb.projectId)
  const decisions: DecisionSummary[] = decisionsQuery.data?.decisions ?? []
  const chosen = useMemo(
    () => (lens === 'impact' ? chooseAlternative(decisions, loc.alternative) : null),
    [lens, decisions, loc.alternative],
  )
  const seeds = useMemo(
    () =>
      chosen
        ? [...new Set(chosen.alternative.directChanges.map((c) => c.target))]
            .filter((id) => model.objectById.has(id))
            .slice(0, MAX_IMPACT_SEEDS)
        : [],
    [chosen, model],
  )
  const impact = useImpact(wb.projectId, seeds, wb.revision, lens === 'impact' && seeds.length > 0)
  const impactState = useMemo(
    () =>
      chosen
        ? impactMarks(projection, chosen.alternative, impact.data?.elements, model.objectById)
        : null,
    [chosen, projection, impact.data, model.objectById],
  )
  const revisions = useMemo(
    () =>
      lens === 'freshness' && wb.freshness.available
        ? revisionMarks(projection, model.relations, freshnessOf)
        : null,
    [lens, wb.freshness.available, projection, model.relations, freshnessOf],
  )
  const decisionState = useMemo(
    () => (lens === 'decisions' ? decisionMarks(projection, decisions) : null),
    [lens, projection, decisions],
  )
  const staleClaims = useMemo(
    () => (wb.freshness.report?.claims ?? []).filter((c) => NEEDS_REVIEW.has(c.status)).length,
    [wb.freshness.report],
  )

  // Choosing an alternative opens the holders of its direct changes, so they can be read.
  const revealedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!chosen || revealedFor.current === chosen.alternative.id) return
    revealedFor.current = chosen.alternative.id
    const holders = new Set<string>()
    for (const c of chosen.alternative.directChanges) {
      for (const h of projection.ancestors.get(c.target) ?? []) holders.add(h)
    }
    const closed = [...holders].filter(
      (h) => !isOpen(h, projection.defaultOpen, prefs.expanded, prefs.collapsed),
    )
    if (closed.length > 0 && closed.length <= 12) setPrefs((p) => openAll(p, closed))
    const targets = chosen.alternative.directChanges.map((c) => c.target)
    if (targets.length > 0) {
      focusFloor.current = OVERVIEW_ZOOM
      setFocusTarget(targets)
    }
  }, [chosen, projection, prefs.expanded, prefs.collapsed])

  // ---------- selection and focus ----------
  const selected = wb.selection
  const selectedNode = selected ? (projection.representative.get(selected) ?? selected) : undefined
  // Edges of the selection are drawn to their exact ends; other edges join frames (see projection).
  const drawn = useMemo(
    () =>
      selectedNode === undefined
        ? projection
        : projectGraph(model.objects, model.relations, {
            expanded: prefs.expanded,
            collapsed: prefs.collapsed,
            hiddenObjectTypes: prefs.hiddenObjectTypes,
            hiddenRelationTypes: prefs.hiddenRelationTypes,
            detail: prefs.imports ? 'all' : 'selection',
            exactFor: selectedNode,
          }),
    [projection, selectedNode, model, prefs],
  )
  // Hops count relations to their exact ends, imports included, whatever the frames show.
  const focus = useMemo(
    () =>
      prefs.hops === 0 || selectedNode === undefined
        ? null
        : focusSet(
            projectGraph(model.objects, model.relations, {
              expanded: prefs.expanded,
              collapsed: prefs.collapsed,
              hiddenObjectTypes: prefs.hiddenObjectTypes,
              hiddenRelationTypes: prefs.hiddenRelationTypes,
              lift: false,
            }),
            selectedNode,
            prefs.hops,
          ),
    [model, prefs, selectedNode],
  )

  const projectionRef = useRef<Projection | null>(null)
  projectionRef.current = projection
  const toggle = useCallback((id: string) => {
    setPrefs((p) => {
      const expanded = new Set(p.expanded)
      const collapsed = new Set(p.collapsed)
      const open =
        expanded.has(id) || (projectionRef.current?.defaultOpen.has(id) && !collapsed.has(id))
      if (open) {
        expanded.delete(id)
        collapsed.add(id)
      } else {
        expanded.add(id)
        collapsed.delete(id)
      }
      return { ...p, expanded, collapsed }
    })
    setFocusTarget([id])
  }, [])
  const pathPrefix = useMemo(() => endpointPrefix(model.objects), [model.objects])
  const altKey = chosen ? alternativeKey(chosen.index) : undefined
  const nodes = useMemo(
    () =>
      toFlowNodes(projection, layout.boxes, {
        lens,
        selected,
        selectedNode,
        focus,
        revisions: revisions?.byNode,
        impact: impactState,
        decisions: decisionState?.tags,
        altKey,
        pathPrefix,
        statusOf: freshnessOf,
        onToggle: toggle,
      }),
    [
      projection,
      layout,
      lens,
      selected,
      selectedNode,
      focus,
      revisions,
      impactState,
      decisionState,
      altKey,
      pathPrefix,
      freshnessOf,
      toggle,
    ],
  )
  const edges = useMemo(
    () =>
      toFlowEdges(drawn, layout.routes, lens, selected, focus, impactState?.numbers, model.nameOf),
    [drawn, layout.routes, lens, selected, focus, impactState, model.nameOf],
  )

  // ---------- viewport ----------
  const wide = paneWidth >= 720
  const insets = useMemo(
    () => ({ top: 40, left: 24, bottom: 24, right: wide && prefs.legend ? 244 : 24 }),
    [wide, prefs.legend],
  )
  /** The whole drawing; at first only down to a readable zoom, on request (Fit) entirely. */
  const showAll = useCallback(
    (duration: number, whole = false) => {
      if (paneWidth === 0) return
      const vp = readableViewport(
        { x: 0, y: 0, width: layout.width, height: layout.height },
        paneWidth,
        paneHeight,
        insets,
        whole ? 0.1 : undefined,
      )
      void flow.setViewport(vp, { duration })
    },
    [flow, layout.width, layout.height, paneWidth, paneHeight, insets],
  )
  /** Every node's box on the canvas, from the layout (React Flow's own copy may lag a frame). */
  const absoluteBoxes = useMemo(() => {
    const abs = new Map<string, Box>()
    for (const n of projection.nodes) {
      const box = layout.boxes.get(n.id)
      if (!box) continue
      const parent = n.parentId === undefined ? undefined : abs.get(n.parentId)
      abs.set(n.id, { ...box, x: box.x + (parent?.x ?? 0), y: box.y + (parent?.y ?? 0) })
    }
    return abs
  }, [projection, layout])
  const showNodes = useCallback(
    (ids: readonly string[], duration: number, floor?: number) => {
      if (paneWidth === 0) return false
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const id of ids) {
        const box = absoluteBoxes.get(id)
        if (!box) continue
        minX = Math.min(minX, box.x)
        minY = Math.min(minY, box.y)
        maxX = Math.max(maxX, box.x + box.width)
        maxY = Math.max(maxY, box.y + box.height)
      }
      if (!Number.isFinite(minX)) return false
      const vp = readableViewport(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        paneWidth,
        paneHeight,
        insets,
        floor,
        1.1,
      )
      void flow.setViewport(vp, { duration })
      return true
    },
    [flow, paneWidth, paneHeight, insets, absoluteBoxes],
  )
  const fitted = useRef(false)
  useEffect(() => {
    if (paneWidth === 0 || nodes.length === 0) return
    const duration = reducedMotion() ? 0 : 260
    const frame = requestAnimationFrame(() => {
      if (focusTarget) {
        const targets = [
          ...new Set(focusTarget.map((id) => projection.representative.get(id) ?? id)),
        ]
        if (showNodes(targets, fitted.current ? duration : 0, focusFloor.current)) {
          fitted.current = true
          focusFloor.current = undefined
          setFocusTarget(null)
        }
      } else if (!fitted.current) {
        fitted.current = true
        showAll(0)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [focusTarget, nodes, paneWidth, projection, showAll, showNodes])

  // ---------- interaction ----------
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'select' && change.selected && !isSyntheticId(change.id)) {
          wb.select(change.id)
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
            title: `${nodeName(projection, edge.source, model.nameOf)} —${edge.type}→ ${nodeName(projection, edge.target, model.nameOf)}`,
            relationIds: edge.relationIds,
          })
      }
    },
    [projection, wb, model],
  )
  const reveal = useCallback(
    (objectId: string) => {
      const closed = (projection.ancestors.get(objectId) ?? []).filter(
        (h) => !isOpen(h, projection.defaultOpen, prefs.expanded, prefs.collapsed),
      )
      if (closed.length > 0) setPrefs((p) => openAll(p, closed))
      wb.select(objectId)
      setFocusTarget([objectId])
    },
    [projection, prefs.expanded, prefs.collapsed, wb],
  )

  const counts = useMemo(() => typeCounts(model.objects, model.relations), [model])
  const selectedObject: ObjectVersion | undefined = selected
    ? model.objectById.get(selected)
    : undefined
  const editable =
    selectedObject && !OFF_CANVAS_TYPES.has(selectedObject.type) && !wb.isHistorical
      ? selectedObject
      : undefined
  const addWithin =
    editable && !editable.type.endsWith('Endpoint') && !editable.type.endsWith('DataEntity')
      ? editable.id
      : undefined

  // ---------- caption, legend and title block ----------
  const shown = shownDecisions(decisions)
  const caption = captionFor({
    lens,
    chosen,
    altKey,
    impactState,
    impactLoaded: Boolean(impact.data),
    freshnessAvailable: wb.freshness.available,
    staleClaims,
    source: sourceLine(model.objects),
    decisionsAvailable: decisionsQuery.data !== null,
    shownDecisions: shown.length,
    historical: wb.isHistorical,
  })
  const titleBlock: TitleBlockData = {
    project: wb.overview.project.name,
    source: sourceLine(model.objects),
    revision: wb.isHistorical
      ? `r${wb.revision} (head is r${wb.headRevision})`
      : `r${wb.revision} (head)`,
    lens:
      lens === 'impact'
        ? `impact${altKey ? ` · ${altKey}` : ''}`
        : lens === 'basis'
          ? 'claim basis'
          : lens,
    stale: wb.freshness.available ? plural(staleClaims, 'claim') : 'not assessed',
    shown: `${plural(projection.nodes.length, 'node')} for ${plural(projection.stats.objects, 'element')}${model.truncated ? ' (first 1,000 records)' : ''}`,
  }
  const relationTypes = useMemo(
    () => [...new Set(projection.edges.map((e) => e.type))].sort(),
    [projection],
  )

  const empty = projection.stats.objects === 0
  return (
    <div className="flex h-full min-h-0 flex-col">
      <GraphToolbar
        lens={lens}
        onLens={(next) => navigate({ lens: next }, 'replace')}
        decisions={shown}
        chosen={chosen}
        onAlternative={(id) => navigate({ lens: 'impact', alternative: id }, 'replace')}
        projection={projection}
        prefs={prefs}
        setPrefs={setPrefs}
        counts={counts}
        onReveal={reveal}
        onFit={() => showAll(reducedMotion() ? 0 : 260, true)}
        canEdit={!wb.isHistorical}
        selected={editable}
        canRename={editable ? renameField(editable) !== null : false}
        onEdit={setEdit}
        hasSelection={selectedNode !== undefined}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-border border-b bg-surface px-3 py-1">
        <div className="min-w-0 flex-[1_1_320px]">
          <Caption>{caption}</Caption>
        </div>
        {lens === 'impact' && chosen && chosen.alternative.directChanges.length > 1 && (
          <ChangeStepper
            changes={chosen.alternative.directChanges}
            onShow={(target) => setFocusTarget([target])}
          />
        )}
      </div>
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
          aria-label="Model canvas"
        >
          <Background
            id="minor"
            variant={BackgroundVariant.Lines}
            gap={16}
            lineWidth={1}
            color="var(--k-canvas-dot)"
          />
          <Background
            id="major"
            variant={BackgroundVariant.Lines}
            gap={80}
            lineWidth={1}
            color="var(--k-canvas-major)"
          />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        <div className="pointer-events-none absolute right-3 bottom-3 flex flex-col items-end gap-2">
          {prefs.legend && wide && (
            <Legend
              lens={lens}
              relationTypes={relationTypes}
              decisions={decisionState?.legend ?? []}
              altKey={altKey}
            />
          )}
          <TitleBlock data={titleBlock} compact={!wide} />
        </div>
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <EmptyState title="No elements yet" className="pointer-events-auto max-w-sm bg-surface">
              {projection.stats.offCanvas > 0
                ? 'Decisions and questions live in change threads. '
                : ''}
              Add an element, or ask the Navigator for alternatives; each becomes a proposal you
              review before it is part of the model.
              {!wb.isHistorical && (
                <span className="mt-3 block">
                  <Button variant="primary" size="sm" onClick={() => setEdit('add')}>
                    + Element
                  </Button>
                </span>
              )}
            </EmptyState>
          </div>
        )}
      </div>
      <EditFlow
        kind={edit}
        object={edit === 'add' ? undefined : editable}
        within={edit === 'add' ? addWithin : undefined}
        onClose={() => setEdit(null)}
      />
    </div>
  )
}

/** Below this zoom labels are no longer read, but an alternative's spread of changes still is. */
const OVERVIEW_ZOOM = 0.45

/**
 * The alternative's direct changes as numbered balloons, matching the ones on the drawing: each
 * brings its element into readable view, so a spread of changes can be read one by one.
 */
function ChangeStepper({
  changes,
  onShow,
}: {
  changes: readonly { relationId: string; target: string; label: string; change: string }[]
  onShow: (target: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="k-eyebrow mr-1">Changes</span>
      {changes.map((c, i) => {
        const label = `${withoutHandles(c.label)}${c.change ? `: ${withoutHandles(c.change)}` : ''}`
        return (
          <button
            key={c.relationId}
            type="button"
            className="k-balloon cursor-pointer hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            title={label}
            aria-label={`Show change ${i + 1}: ${label}`}
            onClick={() => onShow(c.target)}
          >
            {i + 1}
          </button>
        )
      })}
    </div>
  )
}

function captionFor(c: {
  lens: Lens
  chosen: ReturnType<typeof chooseAlternative>
  altKey: string | undefined
  impactState: ReturnType<typeof impactMarks> | null
  impactLoaded: boolean
  freshnessAvailable: boolean
  staleClaims: number
  source: string
  decisionsAvailable: boolean
  shownDecisions: number
  historical: boolean
}): string {
  switch (c.lens) {
    case 'basis':
      return 'Line style says where each claim comes from: solid observed, dashed inferred, a cobalt mark where a person stated it.'
    case 'freshness':
      if (!c.freshnessAvailable) return 'Freshness is not available from this server.'
      return c.staleClaims === 0
        ? `Source at ${c.source}: every claim matches its evidence.`
        : `Source at ${c.source}: ${plural(c.staleClaims, 'claim')} no longer match${c.staleClaims === 1 ? 'es' : ''} their evidence; revision marks show where.`
    case 'impact': {
      if (!c.decisionsAvailable) return 'Decisions are not available from this server.'
      if (!c.chosen || !c.altKey || !c.impactState)
        return 'No open or accepted decision has alternatives yet. Ask the Navigator for alternatives to see their impact here.'
      const summary = impactCaption(c.altKey, c.impactState.summary, c.impactLoaded)
      return `${summary} · ${withoutHandles(c.chosen.alternative.title)}${c.historical ? ' (decisions as at the head)' : ''}`
    }
    case 'decisions':
      if (!c.decisionsAvailable) return 'Decisions are not available from this server.'
      return c.shownDecisions === 0
        ? 'No open or accepted decision changes the model yet.'
        : `Flagged: elements that ${plural(c.shownDecisions, 'open or accepted decision')} change. Decisions themselves live in change threads.`
  }
}

/** "imported by 27", for a hub most of its neighbours import, whose import links are not drawn. */
const importedBy = (n: { importedBy?: number }) =>
  n.importedBy ? `imported by ${n.importedBy}` : ''

/** The path prefix every endpoint shares, such as /api/v1, left out of endpoint rows. */
function endpointPrefix(objects: readonly ObjectVersion[]): string {
  const paths = objects
    .filter((o) => o.type === 'software.Endpoint' && o.lifecycle === 'active')
    .map((o) => (o.attributes as Record<string, unknown>).path)
    .filter((p): p is string => typeof p === 'string')
  if (paths.length < 3) return ''
  const split = paths.map((p) => p.split('/'))
  const first = split[0] as string[]
  let n = 0
  while (n < first.length - 1 && split.every((s) => s.length > n + 1 && s[n] === first[n])) n++
  return n <= 1 ? '' : first.slice(0, n).join('/')
}

function nodeName(
  projection: Projection,
  id: string,
  nameOf: (id: string) => string | undefined,
): string {
  const node = projection.nodes.find((n) => n.id === id)
  if (node?.kind === 'package') return node.title
  if (node?.kind === 'cluster') return objectTypeMeta(node.type).label
  return nameOf(id) ?? id
}

function memberSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => compareTypes(a, b))
    .map(([type, n]) => typePlural(type, n))
    .join(' · ')
}

// ---------- projection -> React Flow ----------

interface FlowContext {
  lens: Lens
  selected: string | undefined
  selectedNode: string | undefined
  focus: Set<string> | null
  revisions: Map<string, number> | undefined
  impact: ReturnType<typeof impactMarks> | null
  decisions: Map<string, string[]> | undefined
  altKey: string | undefined
  pathPrefix: string
  statusOf: (claimId: string) => string | undefined
  onToggle: (id: string) => void
}

function marksFor(n: ProjectedNode, ctx: FlowContext): NodeMarks {
  const object = n.kind === 'object' || n.kind === 'group' ? n.object : undefined
  return {
    dimmed: isDimmed(ctx.focus, {
      id: n.id,
      ...(n.kind !== 'object' ? { expanded: n.expanded } : {}),
    }),
    draft: object?.stance === 'toBe',
    basis: ctx.lens === 'basis' ? object?.claim.basis : undefined,
    changes: ctx.lens === 'impact' ? ctx.impact?.numbers.get(n.id) : undefined,
    reached: ctx.lens === 'impact' ? ctx.impact?.reached.has(n.id) : undefined,
    revisions: ctx.lens === 'freshness' ? ctx.revisions?.get(n.id) : undefined,
    decisions: ctx.lens === 'decisions' ? ctx.decisions?.get(n.id) : undefined,
    holdsSelection:
      ctx.selected !== undefined && ctx.selected !== n.id && ctx.selectedNode === n.id,
  }
}

function accessibleState(n: ProjectedNode, marks: NodeMarks, ctx: FlowContext): string {
  const object = n.kind === 'object' || n.kind === 'group' ? n.object : undefined
  return lensDescription(ctx.lens, {
    ...(marks.changes ? { changeNumbers: marks.changes } : {}),
    ...(ctx.altKey ? { alternativeKey: ctx.altKey } : {}),
    ...(marks.reached ? { reached: true } : {}),
    ...(marks.revisions ? { revisions: marks.revisions } : {}),
    ...(marks.decisions ? { decisionTags: marks.decisions } : {}),
    proposed: marks.draft,
    ...(object ? { basisLabel: basisMeta(object.claim.basis).label } : {}),
    stale: object ? NEEDS_REVIEW.has(ctx.statusOf(object.id) ?? '') : false,
  })
}

function toFlowNodes(
  projection: Projection,
  boxes: ReadonlyMap<string, Box>,
  ctx: FlowContext,
): FlowNode[] {
  return projection.nodes.map((n): FlowNode => {
    const box = boxes.get(n.id) ?? { x: 0, y: 0, width: 200, height: 50 }
    const marks = marksFor(n, ctx)
    const state = accessibleState(n, marks, ctx)
    const base = {
      id: n.id,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      // The layout knows every size; passing it as measured keeps fitting exact when node objects
      // are rebuilt (React Flow would otherwise wait for a resize to re-measure).
      measured: { width: box.width, height: box.height },
      selected: n.id === ctx.selected,
      ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
    }
    if (n.kind === 'object') {
      const type = objectTypeMeta(n.object.type).label
      return {
        ...base,
        type: 'object',
        ariaLabel: `${type} ${objectLabel(n.object)}${state ? `, ${state}` : ''}`,
        data: { object: n.object, row: n.row, pathPrefix: ctx.pathPrefix, marks },
      }
    }
    const total = n.memberIds.length
    let data: Pick<HolderNodeData, 'holder' | 'tag' | 'title' | 'summary' | 'boundary'> & {
      object?: ObjectVersion
    }
    if (n.kind === 'group') {
      const isModule = n.object.type === 'software.Module'
      const detail = objectDetail(n.object)
      const meta = objectTypeMeta(n.object.type).label
      const rows = n.memberCounts['software.Endpoint'] ?? 0
      data = {
        holder: 'group',
        object: n.object,
        tag: isModule ? meta : [meta, detail].filter(Boolean).join(' · '),
        title: isModule ? objectShortLabel(n.object).label : objectLabel(n.object),
        summary:
          isModule && n.expanded
            ? rows > 0 && ctx.pathPrefix
              ? `under ${ctx.pathPrefix}`
              : ''
            : [n.expanded && detail ? detail : '', memberSummary(n.memberCounts), importedBy(n)]
                .filter(Boolean)
                .join(' · '),
        boundary: n.object.type === 'software.System',
      }
    } else if (n.kind === 'package') {
      data = {
        holder: 'package',
        tag: 'Package',
        title: n.title,
        summary: [memberSummary(n.memberCounts), importedBy(n)].filter(Boolean).join(' · '),
        boundary: false,
      }
    } else {
      data = {
        holder: 'cluster',
        tag: 'Group',
        title: `${typePlural(n.type, total).replace(/^[\d,]+ /, '')} · ${total}`.replace(
          /^./,
          (c) => c.toUpperCase(),
        ),
        summary: `Top-level ${typePlural(n.type, total).replace(/^[\d,]+ /, '')}`,
        boundary: false,
      }
    }
    const kind =
      n.kind === 'group'
        ? objectTypeMeta(n.object.type).label
        : n.kind === 'package'
          ? 'Package'
          : 'Group'
    return {
      ...base,
      type: 'holder',
      selected: n.kind === 'group' && n.id === ctx.selected,
      selectable: n.kind === 'group',
      ariaLabel: `${kind} ${data.title}, ${plural(total, 'member')}, ${n.expanded ? 'expanded' : 'collapsed'}${state ? `, ${state}` : ''}`,
      data: {
        ...data,
        expanded: n.expanded,
        memberTotal: total,
        marks,
        onToggle: ctx.onToggle,
      },
    }
  })
}

function toFlowEdges(
  projection: Projection,
  routes: LayoutResult['routes'],
  lens: Lens,
  selected: string | undefined,
  focus: Set<string> | null,
  changed: ReadonlyMap<string, number[]> | undefined,
  nameOf: (id: string) => string | undefined,
): RelationFlowEdge[] {
  return projection.edges.map((e) => {
    const basisLabel = basisMeta(e.basis).label
    const count = e.relationIds.length
    const hot =
      lens === 'impact' && changed !== undefined && (changed.has(e.source) || changed.has(e.target))
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'relation',
      selected: count === 1 && e.relationIds[0] === selected,
      ariaLabel: `${e.type} from ${nodeName(projection, e.source, nameOf)} to ${nodeName(projection, e.target, nameOf)}, ${basisLabel}${e.toBe ? ', proposed' : ''}${count > 1 ? `, ${count} relations` : ''}`,
      data: {
        relationType: e.type,
        basis: e.basis,
        toBe: e.toBe,
        count,
        aggregated: e.aggregated,
        parallelIndex: e.parallelIndex,
        parallelCount: e.parallelCount,
        dimmed: focus !== null && !(focus.has(e.source) && focus.has(e.target)),
        hot,
        annotate: lens === 'basis',
        route: routeBetween(routes, e.source, e.target),
      },
    }
  })
}
