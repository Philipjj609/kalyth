import type { KernelError, ModelCallRecord, NavigatorStatus } from '@kalyth/contracts'
import { z } from 'zod'
import { costMicroUsd, findModel, type ModelSpec, reservationMicroUsd } from './catalog.ts'
import type { BudgetLedger } from './ledger.ts'
import {
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type Provider,
  ProviderError,
} from './provider.ts'

export interface GenerateRequest<T> {
  projectId: string
  /** What the call is for, recorded in the ledger, e.g. "navigator.alternatives". */
  purpose: string
  model: string
  system: string
  user: string
  schema: z.ZodType<T>
  schemaName: string
  maxOutputTokens: number
  reasoning: boolean
  temperature?: number
}

export type GenerateOutcome<T> =
  | { ok: true; value: T; calls: ModelCallRecord[] }
  | { ok: false; error: KernelError; calls: ModelCallRecord[] }

/** What answers live in place of a configured model (ADR 0019, live runs on Super). */
export interface LiveModel {
  /** A catalogued model of the same provider. */
  model: string
  /** Overrides the caller's reasoning setting for live calls; recordings keep the caller's. */
  reasoning?: boolean
  /** With reasoning on, the thinking budget sent with live calls. */
  reasoningBudget?: number
  /** Overrides the caller's output cap for live calls; the reservation is priced on it. */
  maxOutputTokens?: number
}

export interface GatewayOptions {
  provider: Provider
  ledger: BudgetLedger
  /** Model id per Navigator role for this provider. */
  roleModels: Readonly<Record<string, string>>
  /**
   * The model that answers live in place of a configured one when no recording answers (ADR 0019,
   * live runs on Super): the hosted demo replays its Nemotron Ultra recordings and calls Nemotron
   * Super live, with a bounded reasoning budget. A live model passes the same catalogue, consent
   * and budget checks as any other.
   */
  liveModels?: Readonly<Record<string, LiveModel>>
  catalog?: readonly ModelSpec[]
  timeoutMs?: number
  /** Corrective retries after output that fails the schema (ADR 0010: at most two). */
  maxCorrections?: number
}

/**
 * The only path to a model provider (ADR 0010): catalogue, consent and budget checks before every
 * call, actual usage recorded after it, and output validated against the caller's schema. A
 * request the provider has a recording for is answered from it, with no reservation and no charge
 * (ADR 0019).
 */
export class ProviderGateway {
  readonly provider: Provider
  readonly ledger: BudgetLedger
  readonly roleModels: Readonly<Record<string, string>>
  readonly #liveModels: Readonly<Record<string, LiveModel>>
  readonly #catalog: readonly ModelSpec[] | undefined
  readonly #timeoutMs: number
  readonly #maxCorrections: number

  constructor(options: GatewayOptions) {
    this.provider = options.provider
    this.ledger = options.ledger
    this.roleModels = options.roleModels
    this.#liveModels = options.liveModels ?? {}
    this.#catalog = options.catalog
    this.#timeoutMs = options.timeoutMs ?? 180_000
    this.#maxCorrections = Math.min(options.maxCorrections ?? 2, 2)
  }

  modelFor(role: string): string {
    const model = this.roleModels[role]
    if (!model) throw new Error(`no model configured for role ${role}`)
    return model
  }

  /** The model a live call for `role` goes to: its configured model, or that model's live one. */
  liveModelFor(role: string): string {
    const model = this.modelFor(role)
    return this.#liveModels[model]?.model ?? model
  }

  /** Corrective retries after output that fails the schema; each is a further reserved call. */
  get maxCorrections(): number {
    return this.#maxCorrections
  }

  /**
   * The most the first live call for `req` would reserve, computed as `generate` computes it but
   * without calling or reserving anything; null if the model is not in the catalogue.
   */
  liveReservationMicroUsd(req: GenerateRequest<unknown>): number | null {
    const spec = findModel(req.model, this.#catalog)
    if (!spec || spec.provider !== this.#providerFamily()) return null
    const live = this.#live(spec)
    if (!live) return null
    return reservationMicroUsd(
      live.spec,
      this.#messages(req),
      live.maxOutputTokens ?? req.maxOutputTokens,
    )
  }

  status(projectId: string): NavigatorStatus {
    return {
      provider: {
        id: this.provider.id,
        external: this.provider.external,
        paid: this.provider.paid,
      },
      models: { ...this.roleModels },
      budget: this.ledger.status(),
      consent: {
        required: this.provider.external,
        ...this.ledger.consent(projectId, this.provider.id),
      },
    }
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateOutcome<T>> {
    const calls: ModelCallRecord[] = []
    const failWith = (code: KernelError['code'], message: string): GenerateOutcome<T> => ({
      ok: false,
      error: { code, message, issues: [] },
      calls,
    })

    const spec = findModel(req.model, this.#catalog)
    if (!spec || spec.provider !== this.#providerFamily()) {
      return failWith(
        'invalid',
        `model ${req.model} is not in the catalogue for ${this.provider.id}`,
      )
    }
    const live = this.#live(spec)
    if (!live) {
      return failWith(
        'invalid',
        `the live model for ${req.model} is not in the catalogue for ${this.provider.id}`,
      )
    }
    // Consent guards content leaving the machine, so a recorded answer does not need it.
    const consented = () =>
      !this.provider.external || this.ledger.consent(req.projectId, this.provider.id).granted

    const schema = jsonSchemaOf(req.schema)
    const messages = this.#messages(req)

    for (let attempt = 1; attempt <= this.#maxCorrections + 1; attempt++) {
      const request: ChatRequest = {
        model: spec.id,
        messages: [...messages],
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0.2,
        responseSchema: { name: req.schemaName, schema },
        reasoning: req.reasoning,
      }
      const recorded = this.provider.recorded?.(request)
      if (recorded) {
        const record = {
          purpose: req.purpose,
          provider: this.provider.id,
          model: spec.id,
          attempt,
          reservedMicroUsd: 0,
          inputTokens: recorded.inputTokens,
          outputTokens: recorded.outputTokens,
          costMicroUsd: 0,
          latencyMs: 0,
          recorded: true,
        }
        const answered = this.#answer(record, recorded, req.schema, calls, messages)
        if (answered) return answered
        continue
      }
      if (this.provider.replayOnly) {
        return failWith(
          'not_found',
          'there is no recording of this request; this server only replays recordings',
        )
      }
      if (!consented()) {
        return failWith(
          'unauthorized',
          `project has not consented to sending content to ${this.provider.id}`,
        )
      }

      // A recording answers for the configured model; a live call goes to its live model.
      const liveRequest: ChatRequest = {
        ...request,
        model: live.spec.id,
        reasoning: live.reasoning ?? request.reasoning,
        maxOutputTokens: live.maxOutputTokens ?? request.maxOutputTokens,
        ...(live.reasoningBudget === undefined ? {} : { reasoningBudget: live.reasoningBudget }),
      }
      const reserved = reservationMicroUsd(
        live.spec,
        liveRequest.messages,
        liveRequest.maxOutputTokens,
      )
      const base = {
        purpose: req.purpose,
        provider: this.provider.id,
        model: live.spec.id,
        attempt,
        reservedMicroUsd: reserved,
      }
      const reservation = this.ledger.reserve({
        provider: this.provider.id,
        model: live.spec.id,
        projectId: req.projectId,
        purpose: req.purpose,
        microUsd: reserved,
      })
      if (!reservation.ok) {
        calls.push({
          ...base,
          outcome: 'refused',
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: 0,
          latencyMs: 0,
          issues: [
            `needs up to ${reservation.neededMicroUsd} micro-USD; ${reservation.remainingMicroUsd} remain`,
          ],
        })
        return failWith('budget_exceeded', 'the budget cap does not cover this call')
      }

      const started = Date.now()
      let response: Awaited<ReturnType<Provider['complete']>>
      try {
        response = await this.provider.complete(liveRequest, AbortSignal.timeout(this.#timeoutMs))
      } catch (error) {
        const latencyMs = Date.now() - started
        const status = error instanceof ProviderError ? error.status : undefined
        // A 4xx answer means the provider refused before doing work; anything else may have run.
        const refusedEarly = status !== undefined && status >= 400 && status < 500
        if (refusedEarly) this.ledger.release(reservation.id, latencyMs)
        else this.ledger.markUnknown(reservation.id, latencyMs)
        const message = error instanceof ProviderError ? error.message : 'provider call failed'
        calls.push({
          ...base,
          outcome: refusedEarly ? 'failed' : 'unknown_outcome',
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: refusedEarly ? 0 : reserved,
          latencyMs,
          issues: [message],
        })
        return failWith('retryable', message)
      }

      const latencyMs = Date.now() - started
      const cost =
        response.inputTokens !== null && response.outputTokens !== null
          ? costMicroUsd(live.spec, response.inputTokens, response.outputTokens)
          : reserved
      this.ledger.settle(reservation.id, {
        costMicroUsd: cost,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs,
      })
      const record = {
        ...base,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costMicroUsd: cost,
        latencyMs,
      }
      const answered = this.#answer(record, response, req.schema, calls, messages)
      if (answered) return answered
    }
    return failWith(
      'invalid',
      `the model output did not match the schema${this.#maxCorrections > 0 ? ' after corrections' : ''}`,
    )
  }

  /**
   * Records a completed call and checks its answer. Returns the outcome, or undefined after a
   * schema failure, once the correction request has been added to `messages`.
   */
  #answer<T>(
    record: Omit<ModelCallRecord, 'outcome' | 'issues'>,
    response: ChatResponse,
    schema: z.ZodType<T>,
    calls: ModelCallRecord[],
    messages: ChatMessage[],
  ): GenerateOutcome<T> | undefined {
    if (response.refusal !== null) {
      calls.push({ ...record, outcome: 'failed', issues: [`model refused: ${response.refusal}`] })
      return {
        ok: false,
        error: { code: 'invalid', message: 'the model declined to answer', issues: [] },
        calls,
      }
    }
    const parsed = parseOutput(response.content, schema)
    if (parsed.ok) {
      calls.push({ ...record, outcome: 'ok', issues: [] })
      return { ok: true, value: parsed.value, calls }
    }
    calls.push({ ...record, outcome: 'schema_invalid', issues: parsed.issues })
    messages.push(
      { role: 'assistant', content: response.content.slice(0, 20_000) },
      {
        role: 'user',
        content: `That answer does not match the required JSON Schema:\n- ${parsed.issues.join(
          '\n- ',
        )}\nReply again with only one JSON object that matches the schema.`,
      },
    )
    return undefined
  }

  /** The first attempt's messages: the system prompt with the output schema, then the user's. */
  #messages(req: GenerateRequest<unknown>): ChatMessage[] {
    const schema = jsonSchemaOf(req.schema)
    return [
      {
        role: 'system',
        content: `${req.system}\n\nOutput JSON Schema:\n${JSON.stringify(schema)}`,
      },
      { role: 'user', content: req.user },
    ]
  }

  /** What answers live for `spec`: itself, or its live model if that is catalogued. */
  #live(spec: ModelSpec): (Omit<LiveModel, 'model'> & { spec: ModelSpec }) | undefined {
    const configured = this.#liveModels[spec.id]
    if (configured === undefined) return { spec }
    const live = findModel(configured.model, this.#catalog)
    if (!live || live.provider !== spec.provider) return undefined
    const { model: _model, ...settings } = configured
    return { ...settings, spec: live }
  }

  /** "replay:nebius" replays recordings priced as Nebius models. */
  #providerFamily(): string {
    return this.provider.id.replace(/^replay:/, '')
  }
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string[] }

/** Parses model output: strips a leading reasoning block or code fence, then validates. */
export function parseOutput<T>(content: string, schema: z.ZodType<T>): Parsed<T> {
  let text = content.trim()
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/, '')
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fence?.[1] !== undefined) text = fence[1]
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, issues: ['the answer is not valid JSON'] }
  }
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    issues: result.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`),
  }
}
