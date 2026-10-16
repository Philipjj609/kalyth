import type { ChatRequest } from '@kalyth/gateway'
import { MIN_QUOTE_CHARS } from './grounding.ts'
import type { AlternativesOutput, SummaryOutput } from './schemas.ts'

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
  const task = /^TASK: (\w+)/m.exec(user)?.[1]
  return JSON.stringify(
    task === 'summarize' ? summary(evidence) : alternatives(user, elements, evidence),
  )
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
    alternatives: [
      {
        title: 'Mock alternative A: change the data model',
        summary: 'Mock output. Extend the persisted entities to carry what the change needs.',
        tradeoffs: 'Mock output. Touches every query on the changed entities; needs a migration.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        directChanges: changes(entities.length > 0 ? entities : first, 'extend'),
      },
      {
        title: 'Mock alternative B: change the API layer',
        summary: 'Mock output. Enforce the change where requests enter the system.',
        tradeoffs: 'Mock output. Smaller change, but every new endpoint must remember it.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
        directChanges: changes(endpoints.length > 0 ? endpoints : first, 'guard'),
      },
      {
        title: 'Mock alternative C: separate deployments',
        summary: 'Mock output. Run one isolated deployment per case instead of sharing one.',
        tradeoffs: 'Mock output. Least code change, most operational cost.',
        confidence: 'low',
        rationale: 'Mock output; not a model inference.',
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
