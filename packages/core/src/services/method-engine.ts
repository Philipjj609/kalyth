import type {
  ComparisonEntry,
  ContextVerdict,
  EvidenceRecord,
  Explanation,
  JsonValue,
  KnowledgeRead,
  MethodRunInputParsed,
  ObjectVersion,
  OperationInput,
  ParameterNature,
  SelectedItem,
  SelectionSource,
  SourceHit,
  Uncertainty,
} from '@kalyth/contracts'
import { Bm25 } from '../kernel/bm25.ts'
import { missingQuestionText } from '../kernel/checks.ts'
import { evaluate } from '../kernel/evaluate.ts'
import { elementLabel } from '../kernel/impact.ts'
import { disputeOf } from '../kernel/library.ts'
import { resolvePin, versionAt } from '../kernel/pins.ts'
import type { StateView } from '../kernel/state.ts'
import type { SqliteStore } from '../store/sqlite-store.ts'

/** Part of every run record: a change to the engine changes what a run may produce. */
export const ENGINE_VERSION = 'kalyth-method-engine/1'

/** The fixed order of ADR 0029 §4.1 and ADR 0033 §3. */
const SOURCE_ORDER: readonly SelectionSource[] = [
  'explicit',
  'person',
  'parameter',
  'elementType',
  'graph',
  'lexical',
]
const GRAPH_RELATIONS = ['competesWith', 'refines', 'requires']
const CANDIDATE_TYPES = ['knowledge.Pattern', 'knowledge.Principle']
const COLLECTOR = { tool: 'kalyth-method-engine', toolVersion: '1' }

interface Method {
  name: string
  purpose: string
  steps: { id: string; uses: string[]; mode: string; produces: string[] }[]
}

interface Candidate extends SelectedItem {
  /** The pin the run assesses: an existing evidence id or a local ref the proposal records. */
  ref: string
  revision: number
  /** The pin's record, for a pin the proposal records. */
  pending?: EvidenceRecord
}

export interface Plan {
  method: KnowledgeRead | null
  libraryUses: { id: string; library: string; revision: number }[]
  selection: {
    candidates: SelectedItem[]
    cut: SelectedItem[]
    ideas: SelectedItem[]
    excluded: SelectedItem[]
    missingLibraries: string[]
  }
  uncertainties: Uncertainty[]
  comparison: ComparisonEntry[]
  ops: OperationInput[]
  rationale: string
}

export type PlanOutcome =
  | { ok: true; plan: Plan }
  | { ok: false; code: string; message: string; partial: Partial<Plan> }

const rank = (s: SourceHit) => SOURCE_ORDER.indexOf(s.source)
const keyOf = (library: string, id: string) => `${library}:${id}`

/**
 * The deterministic method engine (ADR 0033): select pinned knowledge, assess it in every exact
 * context, ask what is missing, compare the patterns as alternatives and find gaps, all as one
 * proposal's operations. It reads the project at `revision` and each library at the revision the
 * project uses; it knows knowledge types and relations, never a discipline, and makes no model
 * call. The same inputs and revisions give the same operations.
 */
export function planMethodRun(
  store: SqliteStore,
  projectId: string,
  revision: number,
  input: MethodRunInputParsed,
): PlanOutcome {
  const view = store.view(projectId, revision)
  const partial: Partial<Plan> = {}
  const failed = (code: string, message: string): PlanOutcome => ({
    ok: false,
    code,
    message,
    partial,
  })

  // ---------- the method ----------
  const methodRecord = view.getEvidence(input.method)
  const methodPin = methodRecord?.source.kind === 'knowledge' ? methodRecord.source : undefined
  const methodContent =
    methodPin?.target === 'object' ? resolvePin(store, projectId, methodPin) : undefined
  const content =
    methodContent?.state === 'resolved'
      ? (methodContent.content as { type?: string; attributes?: Method })
      : undefined
  partial.method =
    methodPin?.versionSha256 && methodPin.target === 'object'
      ? {
          library: methodPin.library,
          target: 'object',
          id: methodPin.id,
          revision: methodPin.revision,
          versionSha256: methodPin.versionSha256,
        }
      : null
  if (!methodPin || content?.type !== 'knowledge.Method' || !content.attributes)
    return failed('method.not_resolved', `${input.method} is not a resolved pin of a method`)
  const method = content.attributes
  const modelSteps = method.steps.filter((s) => s.mode === 'model').map((s) => s.id)
  if (modelSteps.length > 0)
    return failed(
      'method.model_steps_not_enabled',
      `steps ${modelSteps.join(', ')} need a model, which K6a does not run`,
    )
  const produces = new Set(method.steps.flatMap((s) => s.produces))

  // ---------- the libraries in use ----------
  const uses = view
    .listObjects({ types: ['core.LibraryUse'] })
    .map((u) => ({
      id: u.id,
      library: String(u.attributes.library),
      revision: Number(u.attributes.revision),
    }))
    .sort((a, b) => (a.library < b.library ? -1 : 1))
  partial.libraryUses = uses
  const present = uses.filter((u) => store.getProject(u.library)?.kind === 'library')
  const missingLibraries = uses.filter((u) => !present.includes(u)).map((u) => u.library)
  const libs = new Map(
    present.map((u) => [u.library, { use: u, view: store.view(u.library, u.revision) }]),
  )

  // ---------- select (§3) ----------
  const hits = new Map<string, { library: string; item: ObjectVersion; sources: SourceHit[] }>()
  const hit = (library: string, id: string, source: SourceHit) => {
    const lib = libs.get(library)
    const item = lib?.view.getObject(id)
    if (item?.lifecycle !== 'active' || !CANDIDATE_TYPES.includes(item.type)) return
    const key = keyOf(library, id)
    const entry = hits.get(key) ?? { library, item, sources: [] }
    if (!entry.sources.some((s) => s.source === source.source)) entry.sources.push(source)
    hits.set(key, entry)
  }

  // explicit: what the method uses, at the revision it was pinned
  const methodLib = libs.get(methodPin.library)
  if (methodLib) {
    const at = store.view(methodPin.library, methodPin.revision)
    for (const r of at.listRelations({ types: ['uses'], from: methodPin.id }))
      hit(methodPin.library, r.to, { source: 'explicit', path: [r.id] })
    for (const step of method.steps)
      for (const id of step.uses)
        hit(methodPin.library, id, { source: 'explicit', path: [step.id] })
  }
  // person: pins a person adds
  for (const pinId of input.add ?? []) {
    const e = view.getEvidence(pinId)
    if (e?.source.kind === 'knowledge' && e.source.target === 'object')
      hit(e.source.library, e.source.id, { source: 'person', path: [pinId] })
  }
  // parameter: items whose conditions or `addresses` name a concept with a parameter here
  const chains = new Set<string>()
  for (const s of input.scenarios)
    for (let id: string | undefined = s; id && !chains.has(id); ) {
      chains.add(id)
      const base: JsonValue | undefined = view.getObject(id)?.attributes.base
      id = typeof base === 'string' ? base : undefined
    }
  const parameterConcepts = new Map<string, string>()
  for (const p of view.listObjects({ types: ['core.Parameter'] })) {
    if (!chains.has(String(p.attributes.scenario))) continue
    if (!input.natures.includes(p.attributes.nature as ParameterNature)) continue
    const e = view.getEvidence(String(p.attributes.concept))
    if (e?.source.kind !== 'knowledge') continue
    const key = keyOf(e.source.library, e.source.id)
    if (!parameterConcepts.has(key)) parameterConcepts.set(key, p.id)
  }
  for (const [library, { view: lib }] of libs) {
    for (const item of lib.listObjects({ types: CANDIDATE_TYPES })) {
      for (const r of lib.listRelations({ from: item.id }).sort(byId)) {
        let concept: string | undefined
        if (r.type === 'addresses') concept = r.to
        else if (['appliesWhen', 'unsuitableWhen', 'exceptWhen'].includes(r.type))
          concept = String(lib.getObject(r.to)?.attributes.subject ?? '')
        const parameter = concept ? parameterConcepts.get(keyOf(library, concept)) : undefined
        if (parameter) hit(library, item.id, { source: 'parameter', path: [parameter, r.id] })
      }
    }
  }
  // elementType: items that address a concept describing a chosen element's type
  const elementTypes = new Set(
    (input.elements ?? []).map((e) => view.getObject(e)?.type).filter(Boolean) as string[],
  )
  if (elementTypes.size > 0)
    for (const [library, { view: lib }] of libs)
      for (const c of lib.listObjects({ types: ['knowledge.Concept'] })) {
        const types = (c.attributes.projectTypes as string[] | undefined) ?? []
        if (!types.some((t) => elementTypes.has(t))) continue
        for (const r of lib.listRelations({ types: ['addresses'], to: c.id }).sort(byId))
          hit(library, r.from, { source: 'elementType', path: [c.id, r.id] })
      }
  // graph: competesWith, refines and requires, either way, from items selected so far
  const seeds = [...hits.values()].sort((a, b) =>
    cmp(keyOf(a.library, a.item.id), keyOf(b.library, b.item.id)),
  )
  const best = new Map<string, SourceHit & { from: string }>()
  for (const seed of seeds) {
    const lib = libs.get(seed.library)?.view as StateView
    const seen = new Map<string, string[]>([[seed.item.id, []]])
    let frontier = [seed.item.id]
    for (let hops = 1; hops <= input.limits.maxHops && frontier.length > 0; hops++) {
      const next: string[] = []
      for (const id of frontier) {
        const around = [
          ...lib.listRelations({ types: GRAPH_RELATIONS, from: id }).map((r) => ({ r, to: r.to })),
          ...lib.listRelations({ types: GRAPH_RELATIONS, to: id }).map((r) => ({ r, to: r.from })),
        ].sort((a, b) => cmp(a.r.id, b.r.id))
        for (const { r, to } of around) {
          if (seen.has(to)) continue
          const path = [...(seen.get(id) as string[]), r.id]
          seen.set(to, path)
          next.push(to)
          const key = keyOf(seed.library, to)
          const was = best.get(key)
          if (!was || (was.hops as number) > hops)
            best.set(key, { source: 'graph', hops, path, from: seed.item.id })
        }
      }
      frontier = next
    }
  }
  for (const [key, { from, ...h }] of best) {
    const [library, id] = key.split(':') as [string, string]
    hit(library, id, { ...h, path: [from, ...(h.path ?? [])] })
  }
  // lexical: names and aliases matching the request, by BM25
  if (input.request) {
    const docs = [...libs].flatMap(([library, { view: lib }]) =>
      lib.listObjects({ types: CANDIDATE_TYPES }).map((o) => ({ library, o })),
    )
    docs.sort((a, b) => cmp(keyOf(a.library, a.o.id), keyOf(b.library, b.o.id)))
    const text = (o: ObjectVersion) =>
      [
        o.attributes.name ?? o.attributes.statement,
        ...((o.attributes.aliases as string[]) ?? []),
      ].join(' ')
    for (const { index, score } of new Bm25(docs.map((d) => text(d.o))).rank(input.request)) {
      const d = docs[index] as (typeof docs)[number]
      hit(d.library, d.o.id, { source: 'lexical', score: Math.round(score * 1e6) / 1e6 })
    }
  }

  // Order, then cut, ideas and exclusions (§3).
  const ordered = [...hits.values()]
    .map((h) => ({ ...h, sources: [...h.sources].sort((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => {
      const [x, y] = [a.sources[0] as SourceHit, b.sources[0] as SourceHit]
      return (
        rank(x) - rank(y) ||
        (x.hops ?? 0) - (y.hops ?? 0) ||
        (y.score ?? 0) - (x.score ?? 0) ||
        cmp(keyOf(a.library, a.item.id), keyOf(b.library, b.item.id))
      )
    })
  const describe = (h: (typeof ordered)[number], reason?: string): SelectedItem => ({
    library: h.library,
    id: h.item.id,
    type: h.item.type,
    name: nameOf(h.item),
    sources: h.sources,
    ...(reason ? { reason } : {}),
  })
  const ideas = ordered.filter((h) => h.item.attributes.maturity === 'hypothesis')
  const excluded = ordered.filter((h) => h.item.attributes.maturity === 'deprecated')
  const eligible = ordered.filter((h) => !ideas.includes(h) && !excluded.includes(h))
  const chosen = eligible.slice(0, input.limits.maxCandidates)
  const cut = eligible.slice(input.limits.maxCandidates)
  const selection: Plan['selection'] = {
    candidates: [],
    cut: cut.map((h) => describe(h, `beyond maxCandidates ${input.limits.maxCandidates}`)),
    ideas: ideas.map((h) => describe(h, 'a hypothesis is an idea, never a candidate')),
    excluded: excluded.map((h) => describe(h, 'deprecated')),
    missingLibraries,
  }
  partial.selection = selection

  // ---------- pins ----------
  const ops: OperationInput[] = []
  const pins = new Map<string, EvidenceRecord>()
  const existingPins = [...store.evidenceMapAt(projectId, revision).values()]
    .filter((e) => e.source.kind === 'knowledge' && e.source.target === 'object')
    .sort((a, b) => cmp(a.id, b.id))
  const candidates: Candidate[] = []
  chosen.forEach((h, i) => {
    const use = libs.get(h.library)?.use as (typeof uses)[number]
    const at = versionAt(store, {
      library: h.library,
      target: 'object',
      id: h.item.id,
      revision: use.revision,
    })
    const base = describe(h)
    if (!at.ok) {
      selection.cut.push({ ...base, reason: `cannot be pinned: ${at.detail}` })
      return
    }
    const same = existingPins.find(
      (e) =>
        e.source.kind === 'knowledge' &&
        e.source.library === h.library &&
        e.source.id === h.item.id &&
        e.source.versionSha256 === at.sha256,
    )
    if (same) {
      candidates.push({ ...base, pin: same.id, ref: same.id, revision: use.revision })
      return
    }
    const ref = `$pin${i}`
    const source = {
      kind: 'knowledge' as const,
      library: h.library,
      target: 'object' as const,
      id: h.item.id,
      revision: use.revision,
    }
    ops.push({ op: 'recordEvidence', ref, evidence: { source, collectedBy: COLLECTOR } })
    const pending: EvidenceRecord = {
      id: ref,
      source: { ...source, versionHash: 'v1', versionSha256: at.sha256 },
      excerpt: null,
      collectedBy: COLLECTOR,
      collectedAt: '1970-01-01T00:00:00.000Z',
    }
    pins.set(ref, pending)
    candidates.push({ ...base, pin: ref, ref, revision: use.revision, pending })
  })
  selection.candidates = candidates.map(({ ref: _r, revision: _v, pending: _p, ...c }) => c)
  if (candidates.length === 0)
    return failed(
      'method.no_candidates',
      missingLibraries.length > 0
        ? `nothing to select: libraries not present here: ${missingLibraries.join(', ')}`
        : 'no pattern or principle of the libraries in use is selected',
    )

  // ---------- assess (§5) ----------
  const elements: (string | undefined)[] = input.elements?.length ? input.elements : [undefined]
  const contexts = input.scenarios.flatMap((scenario) =>
    elements.flatMap((element) => input.natures.map((nature) => ({ scenario, element, nature }))),
  )
  const product = candidates.length * contexts.length
  if (product > input.limits.maxAssessments)
    return failed(
      'method.too_many_assessments',
      `${candidates.length} candidates × ${input.scenarios.length} scenarios × ${elements.length} elements × ${input.natures.length} natures = ${product}, above maxAssessments ${input.limits.maxAssessments}`,
    )

  const openQuestions = new Set(
    view
      .listObjects({ types: ['core.Question'], attributeEquals: { status: 'open' } })
      .map((q) => String(q.attributes.text)),
  )
  const questionOps: OperationInput[] = []
  const asked = new Set<string>()
  const ask = (text: string, concerns: string) => {
    if (openQuestions.has(text) || asked.has(text)) return
    const ref = `$question${asked.size}`
    asked.add(text)
    questionOps.push(
      {
        op: 'createObject',
        ref,
        type: 'core.Question',
        stance: 'toBe',
        attributes: { text, inquiryRole: 'decision-sensitive' },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'concerns',
        from: ref,
        to: concerns,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    )
  }
  const uncertainties: Uncertainty[] = []
  partial.uncertainties = uncertainties
  for (const scenario of input.scenarios) {
    const status = view.getObject(scenario)?.attributes.status
    if (status === 'assumed' || status === 'planned')
      for (const nature of input.natures)
        uncertainties.push({
          kind: status === 'assumed' ? 'scenario-assumed' : 'scenario-planned',
          scenario,
          nature,
          detail: `the scenario is ${status}, not committed`,
        })
  }

  const assessmentOps: OperationInput[] = []
  const verdicts = new Map<string, ContextVerdict[]>()
  const earlierAssessments = view.listObjects({ types: ['core.Assessment'] })
  let n = 0
  for (const c of [...candidates]) {
    // Every context is evaluated before anything is kept, so a candidate that cannot be
    // assessed is listed with its reason and leaves no operation behind (§10).
    const evaluated = contexts.map((ctx) => ({
      ctx,
      e: evaluate(
        store,
        projectId,
        revision,
        { item: c.ref, ...ctx },
        { pins: (id) => pins.get(id) },
      ),
    }))
    const bad = evaluated.find((x) => !x.e.ok)?.e
    if (bad && !bad.ok) {
      candidates.splice(candidates.indexOf(c), 1)
      const at = selection.candidates.findIndex((s) => s.id === c.id && s.library === c.library)
      const [moved] = selection.candidates.splice(at, 1)
      if (moved)
        selection.cut.push({ ...moved, reason: `not assessed: ${bad.code}: ${bad.message}` })
      if (c.pending)
        ops.splice(
          ops.findIndex((op) => op.op === 'recordEvidence' && op.ref === c.ref),
          1,
        )
      continue
    }
    const found: ContextVerdict[] = []
    for (const { ctx, e } of evaluated) {
      if (!e.ok) continue
      const ref = `$assessment${n++}`
      found.push({
        scenario: ctx.scenario,
        ...(ctx.element ? { element: ctx.element } : {}),
        nature: ctx.nature,
        verdict: e.verdict,
        specification: e.explanation.specification ?? 'sufficient',
        assessment: ref,
      })
      assessmentOps.push({
        op: 'createObject',
        ref,
        type: 'core.Assessment',
        stance: 'toBe',
        attributes: {
          item: c.ref,
          scenario: ctx.scenario,
          ...(ctx.element ? { element: ctx.element } : {}),
          nature: ctx.nature,
          verdict: e.verdict,
          explanation: e.explanation as unknown as JsonValue,
          inputs: e.inputs as unknown as JsonValue,
          producedBy: { kind: 'evaluator', evaluatorVersion: e.inputs.evaluatorVersion },
        },
        claim: {
          basis: 'inferred',
          confidence: {
            level: 'high',
            rationale:
              'A deterministic evaluation of declared conditions; it says nothing beyond them.',
          },
          supports: [{ allOf: [c.ref] }],
          derivedFrom: e.inputs.parameters.map((p) => p.id),
        },
      })
      // A re-run supersedes the current assessments of the same exact context (ADR 0029 I1).
      for (const a of earlierAssessments)
        if (
          a.attributes.item === c.ref &&
          a.attributes.scenario === ctx.scenario &&
          a.attributes.element === ctx.element &&
          a.attributes.nature === ctx.nature &&
          view.listRelations({ types: ['supersedes'], to: a.id }).length === 0
        )
          assessmentOps.push({
            op: 'createRelation',
            type: 'supersedes',
            from: ref,
            to: a.id,
            stance: 'toBe',
            claim: { basis: 'stated' },
          })
      for (const u of uncertaintiesOf(e.explanation, c.ref, ctx)) uncertainties.push(u)
      if (produces.has('question'))
        for (const m of e.explanation.missing) ask(missingQuestionText(m), m.scenario)
    }
    verdicts.set(c.ref, found)
    if (produces.has('question') && found.some((f) => f.specification === 'underspecified'))
      ask(
        `Which conditions must hold for "${c.name}"? Its library declares none, so whether it applies is not established.`,
        input.scenarios[0] as string,
      )
  }
  if (candidates.length === 0)
    return failed('method.no_candidates', 'no selected item could be assessed')

  // ---------- compare (§6) ----------
  const comparison: ComparisonEntry[] = []
  partial.comparison = comparison
  const alternativeOps: OperationInput[] = []
  const decisionRef = input.decision ?? '$decision'
  if (input.decision) {
    const d = view.getObject(input.decision)
    if (d?.type !== 'core.Decision' || d.lifecycle !== 'active' || d.attributes.status !== 'open')
      return failed('method.decision_not_open', `${input.decision} is not an open decision`)
  }
  const elementNames = (input.elements ?? []).map((e) => {
    const o = view.getObject(e)
    return o ? elementLabel(o) : e
  })
  if (produces.has('alternative') && !input.decision)
    alternativeOps.push({
      op: 'createObject',
      ref: '$decision',
      type: 'core.Decision',
      stance: 'toBe',
      attributes: {
        title: clip(`${method.name}: ${elementNames.join(', ') || 'the whole system'}`, 300),
        question: clip(input.question ?? method.purpose, 8000),
      },
      claim: { basis: 'stated' },
    })
  const byItem = new Map(candidates.map((c) => [c.id, c]))
  for (const c of candidates) {
    const lib = libs.get(c.library)?.view as StateView
    const item = lib.getObject(c.id) as ObjectVersion
    const contextsOf = verdicts.get(c.ref) ?? []
    const parent = lib
      .listRelations({ types: ['refines'], from: c.id })
      .map((r) => byItem.get(r.to))
      .find((p) => p?.type === 'knowledge.Pattern' && p.library === c.library)
    if (parent && c.type === 'knowledge.Pattern') continue
    const tradeoffs = lib
      .listRelations({ types: ['affects'], from: c.id })
      .sort(byId)
      .map((r) => ({
        effect: r.properties.effect as 'improves' | 'worsens' | 'mixed',
        quality: nameOf(lib.getObject(r.to)),
        note: String(r.properties.note ?? ''),
      }))
    const constraints = lib
      .listRelations({ types: ['realizesPrinciple'], from: c.id })
      .sort(byId)
      .map((r) => ({
        id: r.to,
        statement: String(lib.getObject(r.to)?.attributes.statement ?? r.to),
      }))
    const refinedBy = candidates
      .filter(
        (x) =>
          lib.listRelations({ types: ['refines'], from: x.id, to: c.id }).length > 0 &&
          x.library === c.library,
      )
      .map((x) => ({ id: x.id, name: x.name, contexts: verdicts.get(x.ref) ?? [] }))
    const covers = contextsOf.filter(
      (v) => v.verdict === 'conditionsMet' || v.verdict === 'unknown',
    )
    const ruledOut = contextsOf.filter((v) => v.verdict === 'conditionsNotMet')
    const underspecified = contextsOf.some((v) => v.specification === 'underspecified')
    const entry: ComparisonEntry = {
      library: c.library,
      id: c.id,
      name: c.name,
      contexts: contextsOf,
      tradeoffs,
      constraints,
      refinedBy,
      underspecified,
      ruledOutEverywhere: covers.length === 0 && ruledOut.length > 0,
    }
    comparison.push(entry)
    // Principles are constraints, never alternatives; an alternative needs a covered context.
    if (c.type !== 'knowledge.Pattern' || covers.length === 0 || !produces.has('alternative'))
      continue
    const ref = `$alternative${comparison.length - 1}`
    entry.alternative = ref
    const library = store.getProject(c.library)?.name ?? c.library
    const worsens = tradeoffs.filter((t) => t.effect === 'worsens').map((t) => t.quality)
    alternativeOps.push(
      {
        op: 'createObject',
        ref,
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: {
          title: clip(c.name, 300),
          summary: clip(String(item.attributes.solution ?? c.name), 8000),
          ...(tradeoffs.length > 0
            ? {
                tradeoffs: clip(
                  tradeoffs
                    .map((t) => `${t.effect}: ${t.quality} — ${t.note}`)
                    .concat(`(from "${c.name}" in ${library}, revision ${c.revision})`)
                    .join('\n'),
                  8000,
                ),
              }
            : {}),
          basis: {
            pins: [c.ref],
            covers: covers.map((v) => v.assessment),
            ruledOut: ruledOut.map((v) => v.assessment),
            disclosed: {
              disputed: disputeOf(lib, item).status === 'disputed' ? [c.ref] : [],
              hypotheses: [],
              worsens: [...new Set(worsens)].sort(),
              underspecified: underspecified ? [c.ref] : [],
            },
            unbacked: false,
          },
        },
        claim: {
          basis: 'imported',
          supports: [{ allOf: [c.ref] }],
          derivedFrom: [...covers, ...ruledOut].map((v) => v.assessment),
        },
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: ref,
        to: decisionRef,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    )
  }

  // ---------- find gaps (§7) ----------
  const gapsFrom = questionOps.length
  if (produces.has('question'))
    for (const ctx of contexts) {
      const met = candidates.some((c) =>
        (verdicts.get(c.ref) ?? []).some(
          (v) =>
            v.scenario === ctx.scenario &&
            v.element === ctx.element &&
            v.nature === ctx.nature &&
            v.verdict === 'conditionsMet',
        ),
      )
      if (met) continue
      const scenario = view.getObject(ctx.scenario)
      const where = ctx.element
        ? (elementNames[elements.indexOf(ctx.element)] ?? ctx.element)
        : 'the whole system'
      ask(
        `No pinned knowledge has its declared conditions met for ${where} in ${nameOf(scenario)} (${ctx.nature} values). Is there an approach outside the libraries in use?`,
        ctx.scenario,
      )
    }

  // Pins, Questions, Assessments, the Decision and Alternatives, then the gap Questions (§9).
  const gapQuestions = questionOps.splice(gapsFrom)
  ops.push(...questionOps, ...assessmentOps, ...alternativeOps, ...gapQuestions)
  return {
    ok: true,
    plan: {
      method: partial.method ?? null,
      libraryUses: uses,
      selection,
      uncertainties,
      comparison,
      ops,
      rationale: `Method "${method.name}" (${ENGINE_VERSION})`,
    },
  }
}

function uncertaintiesOf(
  e: Explanation,
  item: string,
  ctx: { scenario: string; element: string | undefined; nature: ParameterNature },
): Uncertainty[] {
  const where = {
    item,
    scenario: ctx.scenario,
    ...(ctx.element ? { element: ctx.element } : {}),
    nature: ctx.nature,
  }
  const out: Uncertainty[] = []
  for (const s of e.steps)
    if (s.result === 'unknown' && s.reason && s.reason !== 'notAssessed')
      out.push({
        kind: s.reason as Uncertainty['kind'],
        ...where,
        ...(s.concept ? { concept: s.concept } : {}),
        detail: `${s.text}: ${s.reason}${s.note ? ` (${s.note})` : ''}`,
      })
  if (e.specification === 'underspecified')
    out.push({
      kind: 'underspecified',
      ...where,
      detail: `${e.item.name} declares nothing that must hold`,
    })
  return out
}

const byId = (a: { id: string }, b: { id: string }) => cmp(a.id, b.id)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const nameOf = (o: ObjectVersion | undefined) =>
  String(o?.attributes.name ?? o?.attributes.statement ?? o?.id ?? '')
