import type { ContextCompiler } from '@kalyth/context'
import {
  type Caller,
  canonicalJson,
  type KernelError,
  type ModelCallRecord,
} from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import type { ProviderGateway } from '@kalyth/gateway'
import { alternativesContext, ProjectReader, renderContext } from '@kalyth/navigator'
import type { z } from 'zod'
import {
  ANSWER_SYSTEM,
  AnswerOutput,
  answerUser,
  SEED_SYSTEM,
  SeedOutput,
  seedUser,
} from './prompts.ts'
import { type Chunk, retrieve } from './retrieval.ts'

export type Condition = 'baseline' | 'kalyth'

export interface EvalEnv {
  services: KalythServices
  /** A principal that can read the evaluation project. */
  caller: Caller
  projectId: string
  gateway: ProviderGateway
  context: ContextCompiler
  chunks: readonly Chunk[]
  /** Character budget for the context of the final call, the same in both conditions. */
  budgetChars: number
}

export interface ConditionResult {
  condition: Condition
  predicted: string[]
  contextChars: number
  calls: ModelCallRecord[]
  /** Kalyth condition: the seed elements and the package they produced. */
  seeds: { id: string; label: string }[]
  packageId: string | null
  error: KernelError | null
}

async function finalAnswer(
  env: EvalEnv,
  condition: Condition,
  request: string,
  context: string,
  calls: ModelCallRecord[],
): Promise<Pick<ConditionResult, 'predicted' | 'error'>> {
  const out = await env.gateway.generate({
    projectId: env.projectId,
    purpose: `eval.answer.${condition}`,
    model: env.gateway.modelFor('evaluate'),
    system: ANSWER_SYSTEM,
    user: answerUser(request, context),
    schema: AnswerOutput as z.ZodType<AnswerOutput>,
    schemaName: 'kalyth_eval_answer',
    maxOutputTokens: 3000,
    reasoning: false,
    temperature: 0.2,
  })
  calls.push(...out.calls)
  if (!out.ok) return { predicted: [], error: out.error }
  return { predicted: out.value.files.map((f) => f.path), error: null }
}

/** Lexical retrieval: BM25-ranked chunks within the budget, then the final call. */
export async function runBaseline(env: EvalEnv, request: string): Promise<ConditionResult> {
  const calls: ModelCallRecord[] = []
  const retrieved = retrieve(env.chunks, request, env.budgetChars)
  const answer = await finalAnswer(env, 'baseline', request, retrieved.text, calls)
  return {
    condition: 'baseline',
    ...answer,
    contextChars: retrieved.chars,
    calls,
    seeds: [],
    packageId: null,
  }
}

/** Kalyth: the model picks the elements changed directly, Kalyth compiles the package, final call. */
export async function runKalyth(env: EvalEnv, request: string): Promise<ConditionResult> {
  const calls: ModelCallRecord[] = []
  const failed = (error: KernelError, seeds: ConditionResult['seeds'] = []): ConditionResult => ({
    condition: 'kalyth',
    predicted: [],
    contextChars: 0,
    calls,
    seeds,
    packageId: null,
    error,
  })
  const overview = env.services.getProjectOverview(env.caller, { projectId: env.projectId })
  if (!overview.ok) return failed(overview.error)
  const reader = new ProjectReader(
    env.services,
    env.caller,
    env.projectId,
    overview.value.project.headRevision,
  )
  const catalogue = alternativesContext(reader, [])
  const seedOut = await env.gateway.generate({
    projectId: env.projectId,
    purpose: 'eval.seed.kalyth',
    model: env.gateway.modelFor('evaluate'),
    system: SEED_SYSTEM,
    user: seedUser(request, renderContext(catalogue, 700)),
    schema: SeedOutput as z.ZodType<SeedOutput>,
    schemaName: 'kalyth_eval_seed',
    maxOutputTokens: 1500,
    reasoning: false,
    temperature: 0.2,
  })
  calls.push(...seedOut.calls)
  if (!seedOut.ok) return failed(seedOut.error)
  const byHandle = new Map(catalogue.elements.map((e) => [e.handle, e]))
  const seeds = [
    ...new Map(
      seedOut.value.elements
        .flatMap((s) => byHandle.get(s.element) ?? [])
        .map((e) => [e.id, { id: e.id, label: e.label }]),
    ).values(),
  ]
  if (seeds.length === 0) {
    return failed({
      code: 'invalid',
      message: 'the model named no element from the list',
      issues: [],
    })
  }
  const compiled = env.context.compile(env.caller, {
    projectId: env.projectId,
    focus: seeds.map((s) => s.id),
    maxChars: env.budgetChars,
  })
  if (!compiled.ok) return failed(compiled.error, seeds)
  const pkg = compiled.value.package
  if (pkg.status === 'blocked') {
    return failed(
      {
        code: 'invalid',
        message: 'the context package is blocked: its mandatory part exceeds the budget',
        issues: [],
      },
      seeds,
    )
  }
  const text = canonicalJson(pkg)
  const answer = await finalAnswer(env, 'kalyth', request, text, calls)
  return {
    condition: 'kalyth',
    ...answer,
    contextChars: text.length,
    calls,
    seeds,
    packageId: pkg.id,
  }
}
