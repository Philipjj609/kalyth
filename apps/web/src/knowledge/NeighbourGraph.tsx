import type { KnowledgeView } from '@kalyth/contracts'
import { type Edge, type Node, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo } from 'react'
import { RELATION_TEXT } from '../model/knowledge.ts'

const RADIUS = 190
const MAX = 16

/**
 * The item and its neighbours on the canvas the project graph uses (K5). It is a visual aid: the
 * list beside it says the same in words, so the drawing is hidden from assistive technology.
 * Selecting a neighbour opens it.
 */
export function NeighbourGraph({
  item,
  name,
  onOpen,
}: {
  item: KnowledgeView
  name: string
  onOpen: (id: string) => void
}) {
  const { nodes, edges } = useMemo(() => {
    const neighbours = item.relations
      .filter((r) => r.other.type.startsWith('knowledge.'))
      .slice(0, MAX)
    const nodes: Node[] = [
      {
        id: item.id,
        position: { x: 0, y: 0 },
        data: { label: name },
        className: 'k-kn-node k-kn-centre',
        draggable: false,
      },
      ...neighbours.map((r, i): Node => {
        const angle = (2 * Math.PI * i) / Math.max(neighbours.length, 1) - Math.PI / 2
        return {
          id: r.other.id,
          position: { x: Math.cos(angle) * RADIUS * 1.6, y: Math.sin(angle) * RADIUS },
          data: { label: r.other.name },
          className: 'k-kn-node',
          draggable: false,
        }
      }),
    ]
    const seen = new Set<string>()
    const edges: Edge[] = neighbours.flatMap((r) => {
      if (seen.has(r.id)) return []
      seen.add(r.id)
      const [source, target] = r.direction === 'out' ? [item.id, r.other.id] : [r.other.id, item.id]
      return [
        {
          id: r.id,
          source,
          target,
          label: RELATION_TEXT[r.type]?.[0] ?? r.type,
          className: 'k-kn-edge',
        },
      ]
    })
    return { nodes, edges }
  }, [item, name])

  return (
    <div aria-hidden className="h-72 rounded-md border border-border bg-surface-2">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.id !== item.id) onOpen(node.id)
        }}
      />
    </div>
  )
}
