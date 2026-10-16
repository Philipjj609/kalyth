import {
  Caller,
  ConsentInput,
  fail,
  type KernelError,
  type NavigatorRun,
  NavigatorRunListQuery,
  NavigatorRunQuery,
  type NavigatorStatus,
  ok,
  type Principal,
  type Result,
  StartNavigatorRunInput,
} from '@kalyth/contracts'
import { Authorizer, ensurePrincipal, type KalythServices, uuidv7Hex } from '@kalyth/core'
import type { ProviderGateway } from '@kalyth/gateway'
import type { z } from 'zod'
import {
  alternativesContext,
  type ModelContext,
  NavigatorError,
  ProjectReader,
  renderContext,
  summarizeContext,
} from './context.ts'
import { type Mapped, mapAlternatives, mapSummary } from './operations.ts'
import {
  ALTERNATIVES_SYSTEM,
  alternativesUser,
  SUMMARIZE_SYSTEM,
  summarizeUser,
} from './prompts.ts'
import { RunStore } from './runs.ts'
import { AlternativesOutput, SummaryOutput } from './schemas.ts'

export interface NavigatorOptions {
  services: KalythServices
  gateway: ProviderGateway
  clock?: () => string
}

/** The Navigator's own principal: it reads and proposes, and can do nothing else (ADR 0010). */
export const ensureNavigatorPrincipal = (services: KalythServices): Principal =>
  ensurePrincipal(services, 'navigator', 'model', 'Kalyth Navigator', [
    'project.read',
    'proposal.create',
  ])

/**
 * Runs Navigator operations. People start runs; each run reads the project as the Navigator,
 * calls the model through the gateway, validates citations, and turns what survives into one
 * pending proposal for a person to review.
 */
export class Navigator {
  readonly principal: Principal
  readonly #services: KalythServices
  readonly #gateway: ProviderGateway
  readonly #runs: RunStore
  readonly #authz: Authorizer
  readonly #clock: () => string

  constructor(options: NavigatorOptions) {
    this.#services = options.services
    this.#gateway = options.gateway
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#runs = new RunStore(options.services.store.db)
    this.#authz = new Authorizer(options.services.store, this.#clock)
    this.principal = ensureNavigatorPrincipal(options.services)
    this.#runs.failInterrupted(this.#clock())
  }

  status(caller: unknown, input: unknown): Result<NavigatorStatus> {
    const read = this.#services.getProjectOverview(caller, input)
    if (!read.ok) return read
    return ok(this.#gateway.status(read.value.project.id))
  }

  /** Consent to send this project's content to the external provider: a person, directly. */
  setConsent(caller: unknown, input: unknown): Result<NavigatorStatus> {
    const who = this.#person(caller)
    if (!who.ok) return who
    const parsed = ConsentInput.safeParse(input)
    if (!parsed.success) return fail('invalid', 'input does not match the contract')
    const read = this.#services.getProjectOverview(caller, { projectId: parsed.data.projectId })
    if (!read.ok) return read
    if (!this.#authz.scopes(who.value.id, parsed.data.projectId).has('grant.manage')) {
      return fail('unauthorized', 'provider consent requires grant.manage', {
        requiredScopes: ['grant.manage'],
      })
    }
    if (this.#gateway.provider.external) {
      this.#gateway.ledger.setConsent(
        parsed.data.projectId,
        this.#gateway.provider.id,
        parsed.data.granted,
        who.value.id,
      )
    }
    return ok(this.#gateway.status(parsed.data.projectId))
  }

  /** Starts a run. `done` settles when it finishes; HTTP callers poll the run instead. */
  start(
    caller: unknown,
    input: unknown,
  ): Result<{ run: NavigatorRun; done: Promise<NavigatorRun> }> {
    const who = this.#person(caller)
    if (!who.ok) return who
    const parsed = StartNavigatorRunInput.safeParse(input)
    if (!parsed.success) {
      return fail('invalid', 'input does not match the contract', {
        issues: parsed.error.issues.map((i) => ({
          code: `schema.${i.code}`,
          message: i.message,
          path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
        })),
      })
    }
    const request = parsed.data
    const read = this.#services.getProjectOverview(caller, { projectId: request.projectId })
    if (!read.ok) return read
    if (!this.#authz.scopes(who.value.id, request.projectId).has('proposal.create')) {
      return fail('unauthorized', 'starting a Navigator run requires proposal.create', {
        requiredScopes: ['proposal.create'],
      })
    }
    const busy = this.#runs.running(request.projectId)
    if (busy) {
      return fail('conflicting', `Navigator run ${busy.id} is still in progress for this project`)
    }
    const run: NavigatorRun = {
      id: `nav_${uuidv7Hex()}`,
      projectId: request.projectId,
      input: request,
      status: 'running',
      requestedBy: who.value.id,
      baseRevision: read.value.project.headRevision,
      startedAt: this.#clock(),
      finishedAt: null,
      calls: [],
      costMicroUsd: 0,
      grounding: null,
      output: null,
      proposalId: null,
      error: null,
    }
    this.#runs.insert(run)
    return ok({ run, done: this.#execute(run) })
  }

  getRun(caller: unknown, input: unknown): Result<NavigatorRun> {
    const parsed = NavigatorRunQuery.safeParse(input)
    if (!parsed.success) return fail('invalid', 'input does not match the contract')
    const run = this.#runs.get(parsed.data.runId)
    if (!run) return fail('not_found', `run ${parsed.data.runId} does not exist`)
    const read = this.#services.getProjectOverview(caller, { projectId: run.projectId })
    if (!read.ok)
      return read.error.code === 'unauthorized' ? read : fail('not_found', 'no such run')
    return ok(run)
  }

  listRuns(caller: unknown, input: unknown): Result<{ runs: NavigatorRun[] }> {
    const parsed = NavigatorRunListQuery.safeParse(input)
    if (!parsed.success) return fail('invalid', 'input does not match the contract')
    const read = this.#services.getProjectOverview(caller, { projectId: parsed.data.projectId })
    if (!read.ok) return read
    return ok({ runs: this.#runs.list(parsed.data.projectId, parsed.data.limit) })
  }

  /** Model spend is started by people only: a human principal acting directly. */
  #person(caller: unknown): Result<Principal> {
    const parsed = Caller.safeParse(caller)
    if (!parsed.success) return fail('unauthenticated', 'no valid caller')
    const principal = this.#services.store.getPrincipal(parsed.data.principalId)
    if (!principal) return fail('unauthenticated', 'unknown principal')
    if (principal.kind !== 'human' || parsed.data.origin !== 'human') {
      return fail('unauthorized', 'Navigator runs and provider consent are started by a person')
    }
    return ok(principal)
  }

  async #execute(run: NavigatorRun): Promise<NavigatorRun> {
    const caller = { principalId: this.principal.id, origin: 'model' as const }
    const input = run.input
    let current = run
    const finish = (patch: Partial<NavigatorRun>): NavigatorRun => {
      const calls = patch.calls ?? current.calls
      current = {
        ...current,
        ...patch,
        calls,
        costMicroUsd: calls.reduce((n, c) => n + c.costMicroUsd, 0),
        finishedAt: this.#clock(),
      }
      this.#runs.update(current)
      return current
    }
    const failed = (error: KernelError, patch: Partial<NavigatorRun> = {}) =>
      finish({ ...patch, status: 'failed', error })

    try {
      const reader = new ProjectReader(this.#services, caller, run.projectId, run.baseRevision)
      let context: ModelContext
      let generated: Awaited<ReturnType<ProviderGateway['generate']>>
      let map: (value: unknown, model: { provider: string; model: string }) => Mapped
      if (input.kind === 'summarize') {
        context = summarizeContext(reader, input.elementId)
        if (context.evidence.length === 0) {
          return failed({
            code: 'invalid',
            message: 'this element has no verifiable source excerpts to cite',
            issues: [],
          })
        }
        const focus = context.elements.find((e) => e.id === input.elementId)?.handle ?? 'N1'
        generated = await this.#gateway.generate({
          projectId: run.projectId,
          purpose: 'navigator.summarize',
          model: this.#gateway.modelFor('summarize'),
          system: SUMMARIZE_SYSTEM,
          user: summarizeUser(renderContext(context, 1500), focus),
          schema: SummaryOutput as z.ZodType<unknown>,
          schemaName: 'kalyth_summary',
          maxOutputTokens: 2000,
          reasoning: false,
        })
        map = (value, model) => mapSummary(value as SummaryOutput, context, input.elementId, model)
      } else {
        context = alternativesContext(reader, input.focus ?? [])
        const focus = (input.focus ?? [])
          .map((id) => context.elements.find((e) => e.id === id)?.handle)
          .filter((h): h is string => h !== undefined)
        generated = await this.#gateway.generate({
          projectId: run.projectId,
          purpose: 'navigator.alternatives',
          model: this.#gateway.modelFor('alternatives'),
          system: ALTERNATIVES_SYSTEM,
          user: alternativesUser(input.request, renderContext(context, 700), focus),
          schema: AlternativesOutput as z.ZodType<unknown>,
          schemaName: 'kalyth_alternatives',
          maxOutputTokens: 8000,
          reasoning: true,
        })
        map = (value, model) => mapAlternatives(value as AlternativesOutput, context, model)
      }

      if (!generated.ok) return failed(generated.error, { calls: generated.calls })
      const model = {
        provider: this.#gateway.provider.id,
        model: generated.calls.at(-1)?.model ?? 'unknown',
      }
      const mapped = map(generated.value, model)
      const base = { calls: generated.calls, grounding: mapped.grounding, output: mapped.output }
      if (mapped.ops.length === 0) return finish({ ...base, status: 'completed' })

      const mock = this.#gateway.provider.id === 'mock' ? ' Mock output, not a model.' : ''
      const what =
        input.kind === 'summarize'
          ? `Navigator summary of ${context.elements.find((e) => e.id === input.elementId)?.label}`
          : `Navigator alternatives for: ${input.request.slice(0, 300)}`
      const proposed = this.#services.proposeChange(caller, {
        projectId: run.projectId,
        baseRevision: run.baseRevision,
        ops: mapped.ops,
        rationale: `${what} (run ${run.id}).${mock}`,
        idempotencyKey: `navigator:${run.id}`,
      })
      if (!proposed.ok) return failed(proposed.error, base)
      if (proposed.value.status === 'invalid') {
        return failed(
          {
            code: 'invalid',
            message: 'the kernel rejected the proposal built from the model output',
            issues: proposed.value.issues,
          },
          { ...base, proposalId: proposed.value.proposalId },
        )
      }
      return finish({ ...base, status: 'completed', proposalId: proposed.value.proposalId })
    } catch (error) {
      if (error instanceof NavigatorError) return failed(error.error)
      return failed({
        code: 'retryable',
        message: `run failed: ${(error as Error).message ?? 'unknown error'}`,
        issues: [],
      })
    }
  }
}
