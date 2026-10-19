import type { ChatRequest } from '@kalyth/gateway'
import { MIN_QUOTE_CHARS } from './grounding.ts'
import type { AlternativesOutput, RefineOutput, SummaryOutput } from './schemas.ts'

interface Element {
  handle: string
  type: string
  label: string
}
interface Evidence {
  handle: string
  path: string
  lines: string
  about: string | null
  text: string
}

const FABRICATED = 'this sentence does not appear in any excerpt'

/**
 * A deterministic stand-in for the model, used until paid calls are approved (ADR 0010). It reads
 * the Navigator's own prompt format and answers with structurally valid output built from the
 * listed elements and real quotes. Every text says it is mock output, and each answer includes
 * one deliberately fabricated citation so the grounding validator's rejection is visible.
 */
export function navigatorMockResponder(request: ChatRequest): string {
  const user = request.messages.find((m) => m.role === 'user')?.content ?? ''
  const elements: Element[] = [...user.matchAll(/^(N\d+) \| (\S+) \| (.*)$/gm)].map((m) => ({
    handle: m[1] ?? '',
    type: m[2] ?? '',
    label: m[3] ?? '',
  }))
  const evidence: Evidence[] = [
    ...user.matchAll(
      /<evidence ref="(E\d+)" path="([^"]*)" lines="([^"]*)"(?: about="(N\d+)")?>\n([\s\S]*?)\n<\/evidence>/g,
    ),
  ].map((m) => ({
    handle: m[1] ?? '',
    path: m[2] ?? '',
    lines: m[3] ?? '',
    about: m[4] ?? null,
    text: m[5] ?? '',
  }))
  const statements: Evidence[] = [
    ...user.matchAll(/<statement ref="(S\d+)">\n([\s\S]*?)\n<\/statement>/g),
  ].map((m) => ({
    handle: m[1] ?? '',
    path: 'statement',
    lines: '1',
    about: null,
    text: m[2] ?? '',
  }))
  const task = /^TASK: (\w+)/m.exec(user)?.[1]
  return JSON.stringify(
    task === 'summarize'
      ? summary(evidence)
      : task === 'refine'
        ? refine(user, elements, evidence)
        : elements.length === 0
          ? fromIdea(user, statements)
          : alternatives(user, elements, evidence),
  )
}

/**
 * A project with no elements yet (ADR 0022): every alternative introduces new elements, and the
 * framing cites what the person said.
 */
function fromIdea(user: string, statements: Evidence[]): AlternativesOutput {
  const request = /CHANGE REQUEST \(from a person\):\n(.*)/.exec(user)?.[1]?.trim() ?? 'the idea'
  const said = citation(statements[0])
  const element = (
    ref: string,
    type: AlternativesOutput['newElements'][number]['type'],
    name: string,
    within: string,
  ) => ({
    ref,
    type,
    name,
    description: `Mock output: a ${type.replace('software.', '').toLowerCase()} the idea needs.`,
    within,
    confidence: 'low' as const,
    citations: ref === 'P1' ? said : [],
  })
  const change = (element: string, text: string) => ({
    element,
    change: `Mock: ${text}.`,
    citations: element === 'P2' ? said : [],
  })
  return {
    decision: {
      title: `Mock decision: how to build ${request.slice(0, 120)}`,
      question: `Mock: which first design best serves "${request.slice(0, 400)}"?`,
    },
    newElements: [
      element('P1', 'software.Container', 'Web application', ''),
      element('P2', 'software.DataEntity', 'Core record', 'P1'),
      element('P3', 'software.Endpoint', 'GET /records/', 'P1'),
      element('P4', 'software.Container', 'Worker service', ''),
      element('P5', 'software.Component', 'Unused component', ''),
    ],
    alternatives: [
      {
        title: 'Mock alternative A: one web application',
        summary: 'Mock output. Start with a single application that owns the data and the API.',
        tradeoffs: 'Mock output. Simplest to run; harder to scale parts separately.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: [],
        directChanges: [
          change('P1', 'introduce the web application'),
          change('P2', 'store the core record'),
          change('P3', 'list the records'),
        ],
      },
      {
        title: 'Mock alternative B: application plus a worker',
        summary: 'Mock output. Move slow work to a separate worker from the start.',
        tradeoffs: 'Mock output. Two deployables from day one.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: [],
        directChanges: [
          change('P1', 'introduce the web application'),
          change('P4', 'introduce the worker service'),
          {
            element: 'P2',
            change:
              'Mock change with a fabricated citation, which the grounding validator must reject.',
            citations: [{ ref: statements[0]?.handle ?? 'S1', quote: FABRICATED }],
          },
        ],
      },
      {
        title: 'Mock alternative C: hybrid of A and B',
        summary: 'Mock output. One application now, with the worker split out when needed.',
        tradeoffs: 'Mock output. Defers the second deployable.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: ['A1', 'A2'],
        directChanges: [
          change('P1', 'introduce the web application'),
          change('P2', 'store the core record'),
        ],
      },
    ],
    questions: [
      {
        text: 'Mock question: who uses this first?',
        inquiryRole: 'decision-sensitive',
        options: ['The people who asked for it', 'Their customers', 'An internal team'],
      },
    ],
  }
}

function quoteOf(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.replace(/\s/g, '').length >= MIN_QUOTE_CHARS && !l.startsWith('[...]'))
  return line?.slice(0, 120)
}

function citation(e: Evidence | undefined) {
  const quote = e ? quoteOf(e.text) : undefined
  return e && quote ? [{ ref: e.handle, quote }] : []
}

function summary(evidence: Evidence[]): SummaryOutput {
  const statements: SummaryOutput['statements'] = evidence
    .filter((e) => quoteOf(e.text) !== undefined)
    .slice(0, 3)
    .map((e) => ({
      text: `Mock summary: ${e.path} (lines ${e.lines}) contains "${quoteOf(e.text)?.slice(0, 60)}".`,
      citations: citation(e),
      confidence: 'low' as const,
      rationale: 'Mock output that restates an excerpt; not a model inference.',
    }))
  statements.push({
    text: 'Mock statement with a fabricated citation, which the grounding validator must reject.',
    citations: [{ ref: evidence[0]?.handle ?? 'E1', quote: FABRICATED }],
    confidence: 'low',
    rationale: 'Exercises the grounding validator.',
  })
  return { statements }
}

function alternatives(user: string, elements: Element[], evidence: Evidence[]): AlternativesOutput {
  const request = /CHANGE REQUEST \(from a person\):\n(.*)/.exec(user)?.[1]?.trim() ?? 'the change'
  const ofType = (type: string) => elements.filter((e) => e.type === type)
  const about = (handle: string) => evidence.find((e) => e.about === handle)
  const changes = (picked: Element[], verb: string) =>
    picked.map((e) => ({
      element: e.handle,
      change: `Mock: ${verb} ${e.label}.`,
      citations: citation(about(e.handle)),
    }))
  const first = elements.slice(0, 1)
  const entities = ofType('software.DataEntity').slice(0, 3)
  const endpoints = ofType('software.Endpoint').slice(0, 3)
  const containers = ofType('software.Container').slice(0, 2)
  return {
    decision: {
      title: `Mock decision: ${request.slice(0, 120)}`,
      question: `Mock: how should the system change to satisfy "${request.slice(0, 400)}"?`,
    },
    newElements: [],
    alternatives: [
      {
        title: 'Mock alternative A: change the data model',
        summary: 'Mock output. Extend the persisted entities to carry what the change needs.',
        tradeoffs: 'Mock output. Touches every query on the changed entities; needs a migration.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: [],
        directChanges: changes(entities.length > 0 ? entities : first, 'extend'),
      },
      {
        title: 'Mock alternative B: change the API layer',
        summary: 'Mock output. Enforce the change where requests enter the system.',
        tradeoffs: 'Mock output. Smaller change, but every new endpoint must remember it.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: [],
        directChanges: changes(endpoints.length > 0 ? endpoints : first, 'guard'),
      },
      {
        title: 'Mock alternative C: separate deployments',
        summary: 'Mock output. Run one isolated deployment per case instead of sharing one.',
        tradeoffs: 'Mock output. Least code change, most operational cost.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: [],
        directChanges: [
          ...changes(containers.length > 0 ? containers : first, 'deploy separately'),
          {
            element: first[0]?.handle ?? 'N1',
            change:
              'Mock change with a fabricated citation, which the grounding validator must reject.',
            citations: [{ ref: evidence[0]?.handle ?? 'E1', quote: FABRICATED }],
          },
        ],
      },
      {
        title: 'Mock alternative D: hybrid of A and C',
        summary:
          'Mock output. Extend the data model, and deploy the most sensitive cases separately.',
        tradeoffs: 'Mock output. Two kinds of change to run; isolation where it matters most.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        combines: ['A1', 'A3'],
        directChanges: changes(
          [...(entities.length > 0 ? entities : first).slice(0, 1), ...containers.slice(0, 1)],
          'combine changes for',
        ),
      },
    ],
    questions: [
      {
        text: 'Mock question: which constraint matters most for this change?',
        inquiryRole: 'decision-sensitive',
        options: ['Lowest operating cost', 'Strongest isolation', 'Smallest code change'],
      },
    ],
  }
}

/** Exploring a decision again: one refined alternative and a hybrid of the first two existing. */
function refine(user: string, elements: Element[], evidence: Evidence[]): RefineOutput {
  const existing = [...user.matchAll(/^A(\d+) \| /gm)].length
  const answers = [...user.matchAll(/^A: /gm)].length
  const about = (handle: string) => evidence.find((e) => e.about === handle)
  const pick = elements.filter((e) => e.type === 'software.DataEntity').slice(0, 1)
  const target = pick.length > 0 ? pick : elements.slice(0, 1)
  const changes = (picked: Element[], verb: string) =>
    picked.map((e) => ({
      element: e.handle,
      change: `Mock: ${verb} ${e.label}.`,
      citations: citation(about(e.handle)),
    }))
  const out: RefineOutput = {
    newElements: [],
    alternatives: [
      {
        title: `Mock alternative: refined with ${answers} answer${answers === 1 ? '' : 's'}`,
        summary: 'Mock output. A variant that follows the answers given so far.',
        tradeoffs: 'Mock output. Depends on the answers holding.',
        confidence: 'low',
        rationale: `Mock output; relies on ${answers} answered question(s).`,
        combines: [],
        directChanges: changes(target, 'refine'),
      },
    ],
    questions: [
      {
        text: 'Mock question: does anything in the answers rule out an alternative?',
        inquiryRole: 'exploratory',
        options: [],
      },
    ],
  }
  if (existing >= 2) {
    out.alternatives.push({
      title: 'Mock hybrid of A1 and A2',
      summary: 'Mock output. Combine the first two alternatives on the table.',
      tradeoffs: 'Mock output. More moving parts than either alone.',
      confidence: 'low',
      rationale: 'Mock output; not a model inference.',
      combines: ['A1', 'A2'],
      directChanges: changes(target, 'combine changes for'),
    })
  }
  return out
}
