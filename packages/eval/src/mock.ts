import type { ChatRequest } from '@kalyth/gateway'
import { navigatorMockResponder } from '@kalyth/navigator'
import { tokenize } from './retrieval.ts'

const LIMIT = 12

/**
 * A deterministic stand-in for the model in evaluation runs (ADR 0012). It exercises the pipeline:
 * seeds are elements whose labels share words with the request, and answers are the first paths in
 * the context. Its scores say nothing about Kalyth and every report labels them as mock output.
 */
export function evalMockResponder(request: ChatRequest): string {
  const user = request.messages.find((m) => m.role === 'user')?.content ?? ''
  switch (request.responseSchema.name) {
    case 'kalyth_eval_seed':
      return JSON.stringify(seed(user))
    case 'kalyth_eval_answer':
      return JSON.stringify(answer(user))
    default:
      return navigatorMockResponder(request)
  }
}

function requestOf(user: string): string {
  return /CHANGE REQUEST:\n(.*)/.exec(user)?.[1] ?? ''
}

function seed(user: string) {
  const wanted = new Set(tokenize(requestOf(user)))
  const elements = [...user.matchAll(/^(N\d+) \| (\S+) \| (.*)$/gm)].map((m) => ({
    handle: m[1] ?? '',
    type: m[2] ?? '',
    label: m[3] ?? '',
  }))
  const scored = elements
    .filter((e) => ['software.DataEntity', 'software.Endpoint', 'software.Module'].includes(e.type))
    .map((e) => ({ e, overlap: tokenize(e.label).filter((t) => wanted.has(t)).length }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map((s) => s.e)
  const picked =
    scored.length > 0
      ? scored
      : [elements.find((e) => e.type === 'software.DataEntity') ?? elements[0]].filter(
          (e) => e !== undefined,
        )
  return {
    elements: picked.map((e) => ({
      element: e.handle,
      reason: 'Mock: the label shares words with the request.',
    })),
  }
}

function answer(user: string) {
  const context = user.slice(user.indexOf('CONTEXT:\n') + 'CONTEXT:\n'.length)
  const paths: string[] = []
  const add = (p: string | undefined) => {
    if (p && !paths.includes(p)) paths.push(p)
  }
  if (context.startsWith('{')) {
    try {
      const pkg = JSON.parse(context) as {
        items?: { type: string; label: string; evidence: { location: string }[] }[]
      }
      for (const item of pkg.items ?? []) {
        if (item.type === 'software.Module') add(item.label)
        for (const e of item.evidence) add(e.location.split(':')[0])
      }
    } catch {
      // Not a package; fall through to file tags.
    }
  }
  for (const m of context.matchAll(/<file path="([^"]+)"/g)) add(m[1])
  return {
    files: paths.slice(0, LIMIT).map((path) => ({ path, reason: 'Mock: appears in the context.' })),
  }
}
