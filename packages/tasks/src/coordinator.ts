import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ContextCompiler } from '@kalyth/context'
import {
  Caller,
  type ClaimResult,
  ClaimTaskInput,
  type CommitSuccess,
  fail,
  type KernelError,
  type ObjectVersion,
  type OperationInput,
  ok,
  type Principal,
  type RelationVersion,
  ReleaseTaskInput,
  RenewLeaseInput,
  type ReportResult,
  type Result,
  SubmitReportInput,
  type TaskLease,
  type TaskList,
  TaskListQuery,
  TaskQuery,
  TaskRepositoryInput,
  TaskRepositoryQuery,
  type TaskRepositoryView,
  type TaskStatus,
  type TaskView,
  type VerificationCheck,
} from '@kalyth/contracts'
import {
  Authorizer,
  elementLabel,
  ensurePrincipal,
  type KalythServices,
  uuidv7Hex,
} from '@kalyth/core'
import type { z } from 'zod'
import { TaskGit } from './git.ts'
import { TaskRepositories } from './repository.ts'
import { summarise, taskTrailer, VERIFIER, VERIFIER_COVERAGE, verifyReport } from './verifier.ts'

/** The coordinator's own principal: it commits task lifecycle records and nothing else (ADR 0013). */
export const ensureCoordinator = (services: KalythServices): Principal =>
  ensurePrincipal(services, 'task-coordinator', 'tool', 'Kalyth task coordinator', [
    'project.read',
    'proposal.create',
    'task.coordinate',
  ])

const parse = <S extends z.ZodType>(schema: S, input: unknown): Result<z.output<S>> => {
  const r = schema.safeParse(input)
  if (r.success) return ok(r.data)
  return fail('invalid', 'input does not match the contract', {
    issues: r.error.issues.map((i) => ({
      code: `schema.${i.code}`,
      message: i.message,
      path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
    })),
  })
}

const text = (o: ObjectVersion | undefined, key: string): string =>
  o && typeof o.attributes[key] === 'string' ? (o.attributes[key] as string) : ''

interface Located {
  projectId: string
  view: TaskView
  head: number
}

/**
 * Serves agents working on tasks (ADR 0013): claims with leases, renewals, releases and
 * execution reports checked against git. Every change is a proposal by the agent that the
 * coordinator commits after its own checks; completion stays with people.
 */
export class TaskCoordinator {
  readonly principal: Principal
  readonly #services: KalythServices
  readonly #context: ContextCompiler | undefined
  readonly #repos: TaskRepositories
  readonly #authz: Authorizer
  readonly #clock: () => string

  constructor(options: {
    services: KalythServices
    context?: ContextCompiler
    clock?: () => string
  }) {
    this.#services = options.services
    this.#context = options.context
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#repos = new TaskRepositories(options.services.store.db)
    this.#authz = new Authorizer(options.services.store, this.#clock)
    this.principal = ensureCoordinator(options.services)
  }

  // ---------- reads ----------

  listTasks(caller: unknown, input: unknown): Result<TaskList> {
    const q = parse(TaskListQuery, input)
    if (!q.ok) return q
    const read = this.#services.getProjectOverview(caller, { projectId: q.value.projectId })
    if (!read.ok) return read
    const views = this.#views(caller, q.value.projectId, read.value.revision)
    if (!views.ok) return views
    const tasks = views.value.filter(
      (t) => q.value.status === undefined || t.status === q.value.status,
    )
    return ok({ projectId: q.value.projectId, revision: read.value.revision, tasks })
  }

  getTask(caller: unknown, input: unknown): Result<TaskView> {
    const q = parse(TaskQuery, input)
    if (!q.ok) return q
    const found = this.#locate(caller, q.value.taskId)
    return found.ok ? ok(found.value.view) : found
  }

  getRepository(caller: unknown, input: unknown): Result<TaskRepositoryView> {
    const q = parse(TaskRepositoryQuery, input)
    if (!q.ok) return q
    const read = this.#services.getProjectOverview(caller, { projectId: q.value.projectId })
    if (!read.ok) return read
    return ok(this.#repos.get(q.value.projectId))
  }

  /** A person registers the repository agents commit to; Kalyth only reads it. */
  setRepository(caller: unknown, input: unknown): Result<TaskRepositoryView> {
    const q = parse(TaskRepositoryInput, input)
    if (!q.ok) return q
    const c = Caller.safeParse(caller)
    const principal = c.success ? this.#services.store.getPrincipal(c.data.principalId) : undefined
    if (!c.success || !principal) return fail('unauthenticated', 'no valid caller')
    if (principal.kind !== 'human' || c.data.origin !== 'human') {
      return fail('unauthorized', 'a person, acting directly, registers the task repository')
    }
    if (!this.#authz.scopes(principal.id, q.value.projectId).has('grant.manage')) {
      return fail('unauthorized', 'registering the task repository requires grant.manage', {
        requiredScopes: ['grant.manage'],
      })
    }
    const path = resolve(q.value.path)
    if (!existsSync(path)) return fail('invalid', `${path} does not exist`)
    try {
      new TaskGit(path).resolveCommit('HEAD')
    } catch {
      return fail('invalid', `${path} is not a git repository with commits`)
    }
    this.#repos.set(q.value.projectId, path, principal.id, this.#clock())
    return ok(this.#repos.get(q.value.projectId))
  }

  // ---------- agent operations ----------

  claim(caller: unknown, input: unknown): Result<ClaimResult> {
    const q = parse(ClaimTaskInput, input)
    if (!q.ok) return q
    const who = this.#worker(caller, q.value.taskId)
    if (!who.ok) return who
    let { view, projectId } = who.value.located
    const agent = who.value.caller

    if (view.status === 'running' && !view.leaseExpired) {
      const mine = view.lease?.holder === agent.principalId
      return fail(
        'conflicting',
        mine
          ? 'you already hold this task; renew the lease with renew_task_lease'
          : `task is held until ${view.lease?.expiresAt}`,
      )
    }
    if (view.status === 'running' && view.leaseExpired) {
      const expired = this.#commit(agent, projectId, `Lease on ${view.id} expired`, [
        this.#status(
          view.id,
          'unknown_outcome',
          `lease ${view.lease?.id} expired at ${view.lease?.expiresAt}`,
        ),
      ])
      if (!expired.ok) return expired
      view = this.#reread(caller, projectId, view.id) ?? view
    }
    if (view.status === 'unknown_outcome') {
      const repo = this.#repos.get(projectId).path
      if (!repo) {
        return fail(
          'conflicting',
          'the previous holder may have finished, and no task repository is registered to check; a person can set the task ready',
        )
      }
      const commits = new TaskGit(repo).commitsMentioning(taskTrailer(view.id))
      if (commits.length > 0) {
        return fail(
          'conflicting',
          `commit ${commits[0]?.slice(0, 12)} already references this task: the previous holder may have finished. Submit a report for it, or ask a person to reset the task.`,
          { changedRefs: commits.slice(0, 5) },
        )
      }
      const reset = this.#commit(agent, projectId, `Resume ${view.id}`, [
        this.#status(view.id, 'ready', 'no commit in the task repository references this task'),
      ])
      if (!reset.ok) return reset
      view = this.#reread(caller, projectId, view.id) ?? view
    }
    if (view.status !== 'ready') return fail('conflicting', `task is ${view.status}, not ready`)
    const waiting = view.requires.filter((r) => !r.satisfied)
    if (waiting.length > 0) {
      return fail('conflicting', `waiting for ${waiting.map((r) => r.label).join(', ')}`, {
        changedRefs: waiting.map((r) => r.id),
      })
    }
    const lease: TaskLease = {
      id: `lease_${uuidv7Hex()}`,
      holder: agent.principalId,
      expiresAt: this.#expiry(q.value.leaseMinutes),
    }
    const claimed = this.#commit(agent, projectId, `Claim ${view.id}`, [
      this.#status(view.id, 'running', `claimed until ${lease.expiresAt}`, lease),
    ])
    if (!claimed.ok) {
      return claimed.error.code === 'stale'
        ? fail('conflicting', 'someone else changed this task first; list the tasks again')
        : claimed
    }
    const task = this.#reread(caller, projectId, view.id) ?? view
    return ok({
      task,
      lease,
      contextPackageId: this.#packageFor(caller, projectId, task),
      instructions: [
        `Commit on a branch of the task repository${task.baseCommit ? `, starting from the task base ${task.baseCommit}` : ''}. Put the trailer "${taskTrailer(task.id)}" on its own line in the message of the commit you report.`,
        `Your lease ends at ${lease.expiresAt}; extend it with renew_task_lease if you need longer.`,
        task.baseCommit
          ? 'When done, call submit_execution_report with your last commit sha, every file your commits changed since the task base, and the tests you ran.'
          : 'When done, call submit_execution_report with the commit sha, every file the commit changes and the tests you ran.',
        'Kalyth checks the work in the repository; a person completes the task.',
      ],
    })
  }

  renew(caller: unknown, input: unknown): Result<TaskView> {
    const q = parse(RenewLeaseInput, input)
    if (!q.ok) return q
    const held = this.#held(caller, q.value.taskId, q.value.leaseId, ['running'])
    if (!held.ok) return held
    const { located, caller: agent, lease } = held.value
    const renewed = { ...lease, expiresAt: this.#expiry(q.value.leaseMinutes) }
    const done = this.#commit(agent, located.projectId, `Renew lease on ${located.view.id}`, [
      this.#status(located.view.id, 'running', `lease renewed until ${renewed.expiresAt}`, renewed),
    ])
    if (!done.ok) return done
    return ok(this.#reread(caller, located.projectId, located.view.id) ?? located.view)
  }

  release(caller: unknown, input: unknown): Result<TaskView> {
    const q = parse(ReleaseTaskInput, input)
    if (!q.ok) return q
    const held = this.#held(caller, q.value.taskId, q.value.leaseId, ['running'])
    if (!held.ok) return held
    const { located, caller: agent } = held.value
    const done = this.#commit(agent, located.projectId, `Release ${located.view.id}`, [
      this.#status(located.view.id, 'ready', `released: ${q.value.reason}`),
    ])
    if (!done.ok) return done
    return ok(this.#reread(caller, located.projectId, located.view.id) ?? located.view)
  }

  submitReport(caller: unknown, input: unknown): Result<ReportResult> {
    const q = parse(SubmitReportInput, input)
    if (!q.ok) return q
    const report = q.value
    const who = this.#worker(caller, report.taskId)
    if (!who.ok) return who
    const { located } = who.value
    const agent = who.value.caller

    const previous = this.#reportByKey(
      caller,
      located.projectId,
      located.view.id,
      report.idempotencyKey,
    )
    if (previous) {
      return ok({
        task: located.view,
        reportId: previous.id,
        verification: {
          id: previous.verification?.id ?? null,
          outcome: previous.verification?.outcome ?? 'inconclusive',
          checks: [],
        },
        duplicate: true,
      })
    }
    const held = this.#held(caller, report.taskId, report.leaseId, ['running', 'unknown_outcome'])
    if (!held.ok) return held

    const repoPath = this.#repos.get(located.projectId).path
    let outcome: 'pass' | 'fail' | 'inconclusive' = 'inconclusive'
    let checks: VerificationCheck[] = []
    if (!report.commit) {
      checks = [{ name: 'commit', ok: false, detail: 'the report names no commit' }]
    } else if (!repoPath) {
      checks = [
        {
          name: 'repository',
          ok: false,
          detail: 'no task repository is registered for this project',
        },
      ]
    } else {
      try {
        const verdict = verifyReport(new TaskGit(repoPath), {
          taskId: located.view.id,
          commit: report.commit,
          filesChanged: report.filesChanged,
          baseCommit: located.view.baseCommit,
        })
        outcome = verdict.outcome
        checks = verdict.checks
      } catch {
        checks = [
          {
            name: 'repository',
            ok: false,
            detail: 'git could not read the task repository; check that it is still there',
          },
        ]
      }
    }

    const ops: OperationInput[] = [
      {
        op: 'createObject',
        ref: '$report',
        type: 'core.ExecutionReport',
        stance: 'asIs',
        attributes: {
          outcome: report.outcome,
          summary: report.summary,
          ...(report.commit ? { commit: report.commit } : {}),
          filesChanged: report.filesChanged,
          tests: report.tests.map((t) => ({
            command: t.command,
            passed: t.passed,
            failed: t.failed,
            ...(t.note ? { note: t.note } : {}),
          })),
          leaseId: report.leaseId,
          idempotencyKey: report.idempotencyKey,
        },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'reports',
        from: '$report',
        to: located.view.id,
        stance: 'asIs',
        claim: { basis: 'stated' },
      },
    ]
    if (report.commit && repoPath) {
      const observed = {
        basis: 'observed' as const,
        observation: { ...VERIFIER, coverage: VERIFIER_COVERAGE },
        supports: [{ allOf: ['$commit'] }],
      }
      ops.push(
        {
          op: 'recordEvidence',
          ref: '$commit',
          evidence: {
            source: {
              kind: 'document',
              uri: `git:${repoPath.replace(/\\/g, '/')}@${report.commit}`,
              version: report.commit,
              locator: 'commit',
            },
            collectedBy: VERIFIER,
          },
        },
        {
          op: 'createObject',
          ref: '$verification',
          type: 'core.Verification',
          stance: 'asIs',
          attributes: { method: 'git commit check', outcome, summary: summarise(checks) },
          claim: observed,
        },
        {
          op: 'createRelation',
          type: 'verifies',
          from: '$verification',
          to: '$report',
          stance: 'asIs',
          claim: observed,
        },
      )
    }
    if (report.outcome === 'failed') {
      ops.push(
        this.#status(
          located.view.id,
          'failed',
          `the agent reported failure: ${report.summary.slice(0, 300)}`,
        ),
      )
    } else if (outcome === 'pass') {
      ops.push(
        this.#status(
          located.view.id,
          'review',
          'the repository shows the reported work; a person reviews it',
        ),
      )
    }
    const committed = this.#commit(
      agent,
      located.projectId,
      `Execution report for ${located.view.id}`,
      ops,
    )
    if (!committed.ok) return committed
    const { refs } = committed.value
    return ok({
      task: this.#reread(caller, located.projectId, located.view.id) ?? located.view,
      reportId: refs.$report ?? '',
      verification: { id: refs.$verification ?? null, outcome, checks },
      duplicate: false,
    })
  }

  // ---------- internals ----------

  #status(
    id: string,
    status: TaskStatus,
    rationale: string,
    lease: TaskLease | null = null,
  ): OperationInput {
    return { op: 'setTaskStatus', id, status, rationale, lease }
  }

  #expiry(minutes: number): string {
    return new Date(Date.parse(this.#clock()) + minutes * 60_000).toISOString()
  }

  /** The agent proposes; the coordinator commits after the checks above. */
  #commit(
    agent: Caller,
    projectId: string,
    rationale: string,
    ops: OperationInput[],
  ): Result<CommitSuccess> {
    const overview = this.#services.getProjectOverview(agent, { projectId })
    if (!overview.ok) return overview
    const proposed = this.#services.proposeChange(agent, {
      projectId,
      baseRevision: overview.value.project.headRevision,
      rationale,
      ops,
    })
    if (!proposed.ok) return proposed
    if (proposed.value.status !== 'pending') {
      return fail('invalid', 'the task change was refused', { issues: proposed.value.issues })
    }
    return this.#services.commitProposal(
      { principalId: this.principal.id, origin: 'tool' },
      { proposalId: proposed.value.proposalId },
    )
  }

  /** A caller with task.work on the task's project. */
  #worker(caller: unknown, taskId: string): Result<{ caller: Caller; located: Located }> {
    const c = Caller.safeParse(caller)
    if (!c.success) return fail('unauthenticated', 'no valid caller')
    const located = this.#locate(caller, taskId)
    if (!located.ok) return located
    if (!this.#authz.scopes(c.data.principalId, located.value.projectId).has('task.work')) {
      return fail('unauthorized', 'working on tasks requires task.work', {
        requiredScopes: ['task.work'],
      })
    }
    return ok({ caller: c.data, located: located.value })
  }

  /** The caller holds the task's current lease and the task is in one of `statuses`. */
  #held(
    caller: unknown,
    taskId: string,
    leaseId: string,
    statuses: readonly TaskStatus[],
  ): Result<{ caller: Caller; located: Located; lease: TaskLease }> {
    const who = this.#worker(caller, taskId)
    if (!who.ok) return who
    const { view } = who.value.located
    const lease = view.lease
    if (!lease || lease.id !== leaseId || lease.holder !== who.value.caller.principalId) {
      return fail('unauthorized', 'you do not hold this lease on the task')
    }
    if (!statuses.includes(view.status)) {
      return fail('conflicting', `task is ${view.status}`)
    }
    if (view.status === 'running' && view.leaseExpired) {
      return fail('conflicting', `the lease expired at ${lease.expiresAt}; claim the task again`)
    }
    return ok({ ...who.value, lease })
  }

  #locate(caller: unknown, taskId: string): Result<Located> {
    const projects = this.#services.listProjects(caller)
    if (!projects.ok) return projects
    for (const project of projects.value.projects) {
      const found = this.#services.queryObjects(caller, {
        projectId: project.id,
        ids: [taskId],
        types: ['core.Task'],
      })
      if (found.ok && found.value.objects.length > 0) {
        const view = this.#reread(caller, project.id, taskId)
        if (view) return ok({ projectId: project.id, view, head: project.headRevision })
      }
    }
    return fail('not_found', `no task ${taskId} in a project you can read`)
  }

  #reread(caller: unknown, projectId: string, taskId: string): TaskView | undefined {
    const views = this.#views(caller, projectId, undefined, [taskId])
    return views.ok ? views.value[0] : undefined
  }

  #reportByKey(caller: unknown, projectId: string, taskId: string, key: string) {
    const objects = this.#services.queryObjects(caller, {
      projectId,
      types: ['core.ExecutionReport'],
      limit: 1000,
    })
    if (!objects.ok) return undefined
    const match = objects.value.objects.find((o) => o.attributes.idempotencyKey === key)
    if (!match) return undefined
    const view = this.#reread(caller, projectId, taskId)
    return view?.reports.find((r) => r.id === match.id)
  }

  #packageFor(caller: unknown, projectId: string, task: TaskView): string | null {
    if (task.contextPackageId) return task.contextPackageId
    if (!this.#context || task.implements.length === 0) return null
    const compiled = this.#context.compile(caller, {
      projectId,
      focus: task.implements.map((i) => i.id),
      task: { title: task.title, acceptanceCriteria: task.acceptanceCriteria },
    })
    return compiled.ok && compiled.value.package.status === 'ready'
      ? compiled.value.package.id
      : null
  }

  #views(
    caller: unknown,
    projectId: string,
    revision?: number,
    only?: string[],
  ): Result<TaskView[]> {
    const at = { projectId, ...(revision === undefined ? {} : { revision }) }
    const unwrap = <T>(r: Result<T>): T => {
      if (!r.ok) throw new ViewError(r.error)
      return r.value
    }
    try {
      const objects = unwrap(
        this.#services.queryObjects(caller, {
          ...at,
          types: [
            'core.Task',
            'core.ExecutionReport',
            'core.Verification',
            'core.Decision',
            'core.Alternative',
            'core.Requirement',
          ],
          limit: 1000,
        }),
      ).objects
      const relations: RelationVersion[] = unwrap(
        this.#services.queryRelations(caller, {
          ...at,
          types: ['implements', 'requires', 'reports', 'verifies'],
          limit: 1000,
        }),
      ).relations
      const byId = new Map(objects.map((o) => [o.id, o]))
      const now = this.#clock()
      const tasks = objects
        .filter((o) => o.type === 'core.Task' && (!only || only.includes(o.id)))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      const reportsOf = new Map(
        tasks.map((t) => [
          t.id,
          relations
            .filter((r) => r.type === 'reports' && r.to === t.id)
            .flatMap((r) => byId.get(r.from) ?? [])
            .sort((x, y) => x.revision - y.revision || (x.id < y.id ? -1 : 1)),
        ]),
      )
      const written = writtenAt(this.#services.store, projectId, [
        ...tasks,
        ...[...reportsOf.values()].flat(),
      ])
      return ok(
        tasks.map((t): TaskView => {
          const a = t.attributes as Record<string, unknown>
          const lease = (a.lease as TaskLease | null | undefined) ?? null
          const status = a.status as TaskStatus
          const linked = (type: string) =>
            relations.filter((r) => r.type === type && r.from === t.id)
          const reports = (reportsOf.get(t.id) ?? []).map((rep) => {
            const ra = rep.attributes as Record<string, unknown>
            const verification = relations
              .filter((r) => r.type === 'verifies' && r.to === rep.id)
              .flatMap((r) => byId.get(r.from) ?? [])[0]
            return {
              id: rep.id,
              outcome: ra.outcome as 'succeeded' | 'failed' | 'partial',
              summary: text(rep, 'summary'),
              commit: typeof ra.commit === 'string' ? ra.commit : null,
              filesChanged: (ra.filesChanged as string[] | undefined) ?? [],
              tests: (ra.tests as TaskView['reports'][number]['tests'] | undefined) ?? [],
              revision: rep.revision,
              reportedAt: written.created(rep),
              verification: verification
                ? {
                    id: verification.id,
                    outcome: text(verification, 'outcome') as 'pass' | 'fail' | 'inconclusive',
                    summary: text(verification, 'summary'),
                  }
                : null,
            }
          })
          return {
            id: t.id,
            projectId,
            title: text(t, 'title'),
            description: text(t, 'description') || null,
            acceptanceCriteria: (a.acceptanceCriteria as string[] | undefined) ?? [],
            status,
            statusRationale: text(t, 'statusRationale') || null,
            lease,
            leaseExpired: status === 'running' && lease !== null && lease.expiresAt <= now,
            contextPackageId: text(t, 'contextPackageId') || null,
            baseCommit: text(t, 'baseCommit') || null,
            implements: linked('implements').map((r) => {
              const target = byId.get(r.to)
              return {
                id: r.to,
                type: target?.type ?? 'unknown',
                label: target ? elementLabel(target) : r.to,
              }
            }),
            requires: linked('requires').map((r) => {
              const target = byId.get(r.to)
              const satisfied =
                target?.type === 'core.Task'
                  ? target.attributes.status === 'completed'
                  : target?.type === 'core.Decision'
                    ? target.attributes.status === 'accepted'
                    : false
              return {
                id: r.to,
                type: target?.type ?? 'unknown',
                label: target ? elementLabel(target) : r.to,
                satisfied,
              }
            }),
            reports,
            revision: t.revision,
            createdAt: written.created(t),
            updatedAt: written.updated(t),
          }
        }),
      )
    } catch (error) {
      if (error instanceof ViewError) return { ok: false, error: error.error }
      throw error
    }
  }
}

/**
 * Times from the project history: when each object's first version and its current version were
 * committed. Every revision after 0 has a change set, so a missing time means a broken store.
 */
function writtenAt(
  store: KalythServices['store'],
  projectId: string,
  objects: readonly ObjectVersion[],
) {
  const first = store.firstRevisions(
    projectId,
    objects.map((o) => o.id),
  )
  const times = store.commitTimes(projectId, [
    ...new Set([...first.values(), ...objects.map((o) => o.revision)]),
  ])
  const at = (revision: number): string => {
    const time = times.get(revision)
    if (time === undefined) throw new Error(`revision ${revision} has no change set`)
    return time
  }
  return {
    created: (o: ObjectVersion) => at(first.get(o.id) ?? o.revision),
    updated: (o: ObjectVersion) => at(o.revision),
  }
}

class ViewError extends Error {
  readonly error: KernelError
  constructor(error: KernelError) {
    super(error.message)
    this.error = error
  }
}
