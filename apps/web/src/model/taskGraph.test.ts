import { describe, expect, it } from 'vitest'
import { formatLocation, parseLocation } from '../app/location.ts'
import { ALT_A, DECISION } from '../test/navigator.ts'
import { runningTask, TASK, TASK_B, taskView } from '../test/tasks.ts'
import { layoutTaskGraph, routePath, taskGraphModel } from './taskGraph.ts'

describe('task graph', () => {
  it('links tasks to what they require and implement, once per target', () => {
    const model = taskGraphModel([runningTask(), taskView()])
    expect(model.nodes.map((n) => [n.id, n.kind])).toEqual(
      [
        [TASK, 'task'],
        [TASK_B, 'task'],
        [DECISION, 'target'],
        [ALT_A, 'target'],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    )
    expect(model.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'requires',
          source: TASK,
          target: TASK_B,
          satisfied: false,
        }),
        expect.objectContaining({
          kind: 'requires',
          source: DECISION,
          target: TASK_B,
          satisfied: true,
        }),
        expect.objectContaining({ kind: 'implements', source: ALT_A, target: TASK_B }),
        expect.objectContaining({ kind: 'implements', source: DECISION, target: TASK }),
      ]),
    )
    expect(model.edges).toHaveLength(4)
  })

  it('places prerequisites and targets above the tasks that depend on them, deterministically', () => {
    const model = taskGraphModel([runningTask(), taskView()])
    const first = layoutTaskGraph(model)
    const y = Object.fromEntries(first.nodes.map((n) => [n.id, n.y]))
    expect(y[DECISION]).toBeLessThan(y[TASK] as number)
    expect(y[TASK]).toBeLessThan(y[TASK_B] as number)
    expect(y[ALT_A]).toBeLessThan(y[TASK_B] as number)
    expect(layoutTaskGraph(taskGraphModel([taskView(), runningTask()]))).toEqual(first)
  })

  it('handles a project without tasks', () => {
    expect(layoutTaskGraph(taskGraphModel([])).nodes).toEqual([])
  })
})

describe('task layout in the URL', () => {
  it('keeps the graph layout for the Tasks view only', () => {
    const loc = parseLocation(`?view=tasks&layout=graph&task=${TASK}`)
    expect(loc).toMatchObject({ view: 'tasks', taskLayout: 'graph', task: TASK })
    expect(formatLocation(loc)).toBe(`?view=tasks&task=${TASK}&layout=graph`)
    expect(formatLocation({ ...loc, view: 'graph' })).toBe('?view=graph')
    expect(parseLocation('?view=tasks&layout=sideways').taskLayout).toBeUndefined()
  })
})

describe('edge routes', () => {
  it('gives every edge a route from its source to its target', () => {
    const laidOut = layoutTaskGraph(taskGraphModel([runningTask(), taskView()]))
    const centre = new Map(laidOut.nodes.map((n) => [n.id, n.y + n.height / 2]))
    for (const e of taskGraphModel([runningTask(), taskView()]).edges) {
      const route = laidOut.routes.get(e.id) ?? []
      expect(route.length).toBeGreaterThanOrEqual(2)
      expect(route[0]?.y).toBeGreaterThan(centre.get(e.source) as number)
      expect(route.at(-1)?.y).toBeLessThan(centre.get(e.target) as number)
    }
  })

  it('draws a route as a path with rounded corners', () => {
    expect(routePath([])).toBe('')
    expect(
      routePath([
        { x: 0, y: 0 },
        { x: 0, y: 40 },
      ]),
    ).toBe('M 0 0 L 0 40')
    expect(
      routePath([
        { x: 0, y: 0 },
        { x: 0, y: 40 },
        { x: 40, y: 40 },
      ]),
    ).toBe('M 0 0 L 0 30 Q 0 40 10 40 L 40 40')
  })
})
