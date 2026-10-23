import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  ANALYZER,
  type AnalysisResult,
  analyzeRepository,
  GitRepository,
  IngestError,
  ingestRepository,
} from '@kalyth/analyzer'
import type { ContextCompiler } from '@kalyth/context'
import {
  Caller,
  type ClaimResult,
  ClaimTaskInput,
  type CommitSuccess,
  FileReportInput,
  fail,
  type KernelError,
  type ObjectVersion,
  type OperationInput,
  ok,
  type Principal,
  type ReconciledElement,
  type ReconcileResult,
  ReconcileTaskInput,
  type RelationVersion,
  ReleaseTaskInput,
  RenewLeaseInput,
  type ReportResult,
  type Result,
  type Scope,
  SubmitReportInput,
  type TaskFinding,
  type TaskLease,
  type TaskList,
  TaskListQuery,
  TaskQuery,
  TaskRepositoryInput,
  TaskRepositoryQuery,
  type TaskRepositoryView,
  type TaskStatus,
  type TaskView,
  type TestRun,
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
import { SHA, TaskGit } from './git.ts'
import { agentPrompt } from './prompt.ts'
import {
  attributeChanges,
  ensureAnalyzer,
  ensureReconciler,
  keyOf,
  type ObservedChangeSet,
  observeChange,
  observedFor,
  RECONCILE_METHOD,
  type ReconcileModel,
  reconcileDecisions,
  summariseObserved,
} from './reconcile.ts'
import { TaskRepositories } from './repository.ts'
import {
  normaliseFiles,
  parseSummary,
  summarise,
  taskTrailer,
  VERIFIER,
  VERIFIER_COVERAGE,
  verifyReport,
} from './verifier.ts'

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

/** Why a task in this state takes no report or lease change, whoever asks. */
const NOT_WORKABLE: Record<TaskStatus, string> = {
  proposed: 'the task is proposed, not running: a person marks it ready before it can be claimed',
  ready: 'the task is ready, not running: no one holds a lease on it; claim it first',
  running: 'the task is running',
  review:
    'the task is in review: a verified report is waiting for a person, so the task takes no more reports and its lease has ended',
  unknown_outcome:
    'the lease expired before a report: the last holder can still report its work, but the lease cannot be renewed or released',
  blocked: 'the task is blocked by a person: it takes no reports until it is unblocked and claimed',
  failed:
    'the task has failed: it takes no more reports until a person marks it ready and it is claimed again',
  completed: 'the task is completed, which is final: it takes no more reports',
  cancelled: 'the task is cancelled, which is final: it takes no more reports',
}
const notWorkable = (status: TaskStatus): string =>
  NOT_WORKABLE[status] ?? `the task is ${status}, not running`

/** Why a person cannot file a report on a task in this state (ADR 0024). */
function notFileable(view: TaskView): string {
  switch (view.status) {
    case 'running':
      return `an agent holds the lease until ${view.lease?.expiresAt}: wait for its report, or for the lease to expire`
    case 'proposed':
      return 'the task is proposed: mark it ready before filing a report'
    case 'review':
      return 'the task is in review: a verified report is already waiting for a person'
    case 'blocked':
      return 'the task is blocked: mark it ready before filing a report'
    case 'failed':
      return 'the task has failed: mark it ready before filing a report'
    default:
      return `the task is ${view.status}, which is final: it takes no more reports`
  }
}

/** The scopes a person needs to change a task through a committed proposal. */
const PERSON_SCOPES: readonly Scope[] = ['proposal.create', 'proposal.commit']
/** A person's report taken from ready holds the task this long, until it moves on. */
const PERSON_LEASE_MINUTES = 15
/** Commits that carry the trailer, recorded on a task as its finding. */
const MAX_FOUND = 5
/** Commits between base and verified commit read to tell the task's apart from others. */
const RECONCILE_RANGE = 200

const short = (sha: string) => sha.slice(0, 12)
const sameCommits = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((c, i) => c === b[i])

/** The verdict on a report Kalyth cannot check; no verification is recorded for it. */
const NO_COMMIT: VerificationCheck = {
  name: 'commit',
  ok: false,
  detail: 'the report names no commit',
}
const NO_REPOSITORY: VerificationCheck = {
  name: 'repository',
  ok: false,
  detail: 'no task repository is registered for this project',
}

interface Located {
  projectId: string
  view: TaskView
  head: number
}

/** What is recorded about a report: the verifier's verdict, or why there is none. */
interface Verdict {
  outcome: 'pass' | 'fail' | 'inconclusive'
  checks: VerificationCheck[]
  /** The registered task repository, null when there is none. */
  repoPath: string | null
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
    const repo = this.#repos.get(projectId).path
    // What git shows is searched once, and recorded on the task for a person (ADR 0013,
    // amendment of 2026-10-20).
    let found: string[] | undefined
    const search = (path: string) => {
      found ??= new TaskGit(path).commitsMentioning(taskTrailer(view.id)).slice(0, MAX_FOUND)
      return found
    }
    if (view.status === 'running' && view.leaseExpired) {
      const commits = repo ? search(repo) : []
      const expired = this.#commit(agent, projectId, `Lease on ${view.id} expired`, [
        this.#status(
          view.id,
          'unknown_outcome',
          `lease ${view.lease?.id} expired at ${view.lease?.expiresAt}${commits[0] ? `; commit ${short(commits[0])} carries the task trailer` : ''}`,
          null,
          commits.length > 0 ? { commits } : undefined,
        ),
      ])
      if (!expired.ok) return expired
      view = this.#reread(caller, projectId, view.id) ?? view
    }
    if (view.status === 'unknown_outcome') {
      if (!repo) {
        return fail(
          'conflicting',
          'the previous holder may have finished, and no task repository is registered to check; a person can set the task ready',
        )
      }
      const commits = search(repo)
      const newest = commits[0]
      if (newest) {
        if (!sameCommits(view.finding?.commits, commits)) {
          const recorded = this.#commit(agent, projectId, `Git shows work on ${view.id}`, [
            this.#status(
              view.id,
              'unknown_outcome',
              `commit ${short(newest)} carries the task trailer: the previous holder may have finished; a person reviews it`,
              null,
              { commits },
            ),
          ])
          if (!recorded.ok && recorded.error.code !== 'stale') return recorded
        }
        return fail(
          'conflicting',
          `commit ${short(newest)} already references this task: the previous holder may have finished. Kalyth recorded it on the task for a person to review. Submit a report for it, or ask a person to settle the task.`,
          { changedRefs: commits },
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

    // A retry with the same key is answered with the original verdict, read back from the record.
    const previous = this.#previous(caller, located, report.idempotencyKey)
    if (previous) return ok(previous)
    const held = this.#held(caller, report.taskId, report.leaseId, ['running', 'unknown_outcome'])
    if (!held.ok) return held

    // Stored as git writes paths, so what people see is what was compared.
    const filesChanged = normaliseFiles(report.filesChanged)
    const verdict = this.#verify(located, report.commit, filesChanged)
    const ops = this.#reportOps(located.view.id, verdict, {
      ...report,
      filesChanged,
      by: { leaseId: report.leaseId },
    })
    if (report.outcome === 'failed') {
      ops.push(
        this.#status(
          located.view.id,
          'failed',
          `the agent reported failure: ${report.summary.slice(0, 300)}`,
        ),
      )
    } else if (verdict.outcome === 'pass') {
      ops.push(
        this.#status(
          located.view.id,
          'review',
          'the repository shows the reported work; a person reviews it',
        ),
      )
    }
    return this.#recordReport(
      caller,
      agent,
      located,
      `Execution report for ${located.view.id}`,
      ops,
      verdict,
    )
  }

  // ---------- people (ADR 0024) ----------

  /**
   * A person files a report themselves, typically for work done outside an agent session. The task
   * must be ready, running with an expired lease, or waiting on an unknown outcome. The report is
   * stated by that person and verified against git exactly like an agent's; a pass moves the task
   * to review. A failing verdict is recorded and changes no status.
   */
  fileReport(caller: unknown, input: unknown): Result<ReportResult> {
    const q = parse(FileReportInput, input)
    if (!q.ok) return q
    const report = q.value
    const found = this.#locate(caller, report.taskId)
    if (!found.ok) return found
    const located = found.value
    const who = this.#person(caller, located.projectId, 'files a report themselves')
    if (!who.ok) return who
    const person = who.value

    const previous = this.#previous(caller, located, report.idempotencyKey)
    if (previous) return ok(previous)
    const { view } = located
    const fileable =
      view.status === 'ready' ||
      view.status === 'unknown_outcome' ||
      (view.status === 'running' && view.leaseExpired)
    if (!fileable) return fail('conflicting', notFileable(view))

    const filesChanged = normaliseFiles(report.filesChanged)
    const verdict = this.#verify(located, report.commit, filesChanged)
    if (verdict.outcome === 'pass' && view.status === 'ready') {
      // The kernel moves a task to review from running or an unknown outcome, so the person takes
      // the task first, as an agent's claim would; review then ends that lease.
      const lease: TaskLease = {
        id: `lease_${uuidv7Hex()}`,
        holder: person.principalId,
        expiresAt: this.#expiry(PERSON_LEASE_MINUTES),
      }
      const taken = this.#commit(person, located.projectId, `Take ${view.id} to file a report`, [
        this.#status(
          view.id,
          'running',
          'a person files a report for work done outside an agent session',
          lease,
        ),
      ])
      if (!taken.ok) {
        return taken.error.code === 'stale'
          ? fail('conflicting', 'someone else changed this task first; read it again')
          : taken
      }
    }
    const ops = this.#reportOps(view.id, verdict, {
      ...report,
      filesChanged,
      by: { filedBy: person.principalId },
    })
    if (verdict.outcome === 'pass') {
      ops.push(
        this.#status(
          view.id,
          'review',
          'the repository shows the work a person reported; a person reviews it',
        ),
      )
    }
    return this.#recordReport(
      caller,
      person,
      located,
      `Execution report for ${view.id}, filed by a person`,
      ops,
      verdict,
    )
  }

  /**
   * Reconciles the model with a task's verified commit (ADR 0024). A person asks once the task is
   * in review or completed. The analyzer, as its own principal, re-analyses the task repository at
   * the commit of the latest report git verified, read-only, and its observed proposal is committed
   * as ingest commits it. Then, for each decision the task implements: which direct changes the
   * commit touched, and which proposed elements an observed element now matches. Each match gets
   * a pending `realizes` proposal for a person to commit; nothing else is decided here.
   */
  async reconcile(caller: unknown, input: unknown): Promise<Result<ReconcileResult>> {
    const q = parse(ReconcileTaskInput, input)
    if (!q.ok) return q
    const found = this.#locate(caller, q.value.taskId)
    if (!found.ok) return found
    const { projectId, view } = found.value
    const who = this.#person(caller, projectId, 'reconciles the model with a task')
    if (!who.ok) return who
    if (view.status !== 'review' && view.status !== 'completed') {
      return fail(
        'conflicting',
        `the task is ${view.status}: reconcile it once git has verified a report and the task is in review or completed`,
      )
    }
    const report = [...view.reports]
      .reverse()
      .find((r) => r.verification?.outcome === 'pass' && r.commit !== null)
    const commit = report?.commit
    if (!report || !commit || !SHA.test(commit)) {
      return fail('conflicting', 'the task has no report that git verified')
    }
    const repoPath = this.#repos.get(projectId).path
    if (!repoPath) {
      return fail('conflicting', 'no task repository is registered for this project')
    }
    const git = new TaskGit(repoPath)
    let at: { repo: string; skip: string | null }
    try {
      if (!git.findCommit(commit)) {
        return fail('conflicting', `commit ${short(commit)} is no longer in the task repository`)
      }
      const which = this.#modelRepository(projectId, repoPath, git, commit)
      if (!which.ok) return which
      at = which.value
    } catch {
      return fail('conflicting', 'git could not read the task repository; check that it is there')
    }

    // The base and the verified commit, read by the same analyzer, so the difference is the
    // commit's own and not a newer analyzer's (ADR 0024, amendment of 2026-10-20).
    const sourceRepo = new GitRepository(repoPath)
    let after: AnalysisResult | null = null
    let seen: ObservedChangeSet | null = null
    let note: string | null = null
    let base: string | null = null
    let mergeBase: string | null = null
    try {
      base = sourceRepo.resolveCommit(view.baseCommit ?? `${commit}^`)
      // As the verifier does: a commit that does not descend from the base is compared from
      // their merge base, so the base's own later changes are not read as the task's.
      if (!git.isAncestor(base, commit)) {
        mergeBase = git.mergeBase(base, commit)
        base = mergeBase
        if (!base) note = 'the verified commit shares no history with the base commit'
      }
    } catch {
      note = view.baseCommit
        ? `the base commit ${short(view.baseCommit)} is not in the task repository`
        : 'the task names no base commit and the verified commit has no parent'
    }
    // The commits between base and commit: the task's carry its trailer; any other (a merge
    // from the main line, someone else's work) is told apart, and so is what it changed.
    let commits: {
      task: number
      other: string[]
      otherCount: number
      mergeBase: string | null
    } | null = null
    const taskFiles = new Set<string>()
    const otherFiles = new Set<string>()
    if (base) {
      try {
        const range = git.commitsBetween(base, commit, RECONCILE_RANGE)
        const trailer = new RegExp(`^Kalyth-Task:\\s*${view.id}\\s*$`, 'm')
        const other: string[] = []
        for (const c of range) {
          const mine = trailer.test(git.commitMessage(c))
          if (!mine) other.push(c)
          for (const f of git.changedFiles(c)) (mine ? taskFiles : otherFiles).add(f)
        }
        commits = {
          task: range.length - other.length,
          other: other.slice(0, 20),
          otherCount: other.length,
          mergeBase,
        }
      } catch {
        note = 'git could not list the commits between the base and the verified commit'
      }
    }
    try {
      after = await analyzeRepository({ git: sourceRepo, repo: at.repo, ref: commit })
      if (base) {
        const before = await analyzeRepository({ git: sourceRepo, repo: at.repo, ref: base })
        seen = observeChange(before, after)
        attributeChanges(seen, taskFiles, otherFiles)
      }
    } catch {
      note = `the analyzer could not read ${base ? `${short(base)} and ` : ''}${short(commit)}`
    }

    let analysis: ReconcileResult['analysis']
    if (at.skip) {
      analysis = {
        repo: at.repo,
        commit,
        status: 'skipped',
        detail: at.skip,
        proposalId: null,
        created: 0,
        refreshed: 0,
        unchanged: 0,
      }
    } else {
      const analyzer = ensureAnalyzer(this.#services)
      const earlier = this.#analyzerVersions(projectId).filter((v) => v !== ANALYZER.toolVersion)
      try {
        const ingest = await ingestRepository({
          services: this.#services,
          caller: { principalId: analyzer.id, origin: 'tool' },
          projectId,
          git: sourceRepo,
          repo: at.repo,
          ref: commit,
          ...(after ? { analysis: after } : {}),
        })
        analysis = {
          repo: at.repo,
          commit,
          status: 'analysed',
          detail: `${
            ingest.proposalId
              ? `the analyzer's observations of ${short(commit)} were committed as r${ingest.revision}`
              : `the model already matched ${short(commit)}; nothing changed`
          }${
            earlier.length > 0 && ingest.proposalId
              ? `. The model had been analysed with kalyth-analyzer ${earlier.join(', ')}, so this also refreshed what ${ANALYZER.toolVersion} observes differently; the comparison below is the commit's own`
              : ''
          }`,
          proposalId: ingest.proposalId,
          created: ingest.stats.created,
          refreshed: ingest.stats.refreshed,
          unchanged: ingest.stats.unchanged,
        }
      } catch (error) {
        return fail(
          'conflicting',
          error instanceof IngestError
            ? `the analysis of ${short(commit)} was not committed: ${error.message}`
            : `the analyzer could not read ${short(commit)} in the task repository`,
        )
      }
    }

    const head = this.#services.store.getProject(projectId)?.headRevision ?? 0
    const model = this.#model(projectId, head)
    const drafts = reconcileDecisions(model, view.implements, report.filesChanged, seen)
    const link = this.#linker(projectId, head, view, commit, model)
    // What the decisions name: the targets of their direct changes and their proposed elements.
    const planned = new Set<string>()
    for (const d of drafts) {
      for (const id of [...d.changes.map((c) => c.target), ...d.proposed.map((p) => p.id)]) {
        const o = model.objects.get(id)
        const key = o ? keyOf(o) : undefined
        if (key) planned.add(key)
        const match = o && seen ? observedFor(seen, o) : undefined
        if (match) planned.add(match.key)
      }
    }
    return ok({
      taskId: view.id,
      projectId,
      report: { id: report.id, commit, filesChanged: report.filesChanged },
      analysis,
      revision: head,
      decisions: drafts.map((d) => ({
        ...d,
        proposed: d.proposed.map((p) => ({ ...p, link: p.match ? link(p, p.match) : null })),
      })),
      observed:
        seen && base
          ? {
              base,
              commit,
              analyzer: `${ANALYZER.tool} ${ANALYZER.toolVersion}`,
              ...summariseObserved(seen, planned),
              ...(commits ? { commits } : {}),
              note: null,
            }
          : note
            ? {
                base: base ?? commit,
                commit,
                analyzer: `${ANALYZER.tool} ${ANALYZER.toolVersion}`,
                elementsChanged: 0,
                modulesChanged: 0,
                unplanned: [],
                byOthers: [],
                note,
              }
            : null,
    })
  }

  // ---------- internals ----------

  #status(
    id: string,
    status: TaskStatus,
    rationale: string,
    lease: TaskLease | null = null,
    finding?: TaskFinding,
  ): OperationInput {
    return { op: 'setTaskStatus', id, status, rationale, lease, ...(finding ? { finding } : {}) }
  }

  /** The verifier's verdict on a reported commit, read-only, or why there is none. */
  #verify(located: Located, commit: string | undefined, filesChanged: string[]): Verdict {
    const repoPath = this.#repos.get(located.projectId).path
    if (!commit) return { outcome: 'inconclusive', checks: [NO_COMMIT], repoPath }
    if (!repoPath) return { outcome: 'inconclusive', checks: [NO_REPOSITORY], repoPath }
    try {
      const verdict = verifyReport(new TaskGit(repoPath), {
        taskId: located.view.id,
        commit,
        filesChanged,
        baseCommit: located.view.baseCommit,
      })
      return { outcome: verdict.outcome, checks: verdict.checks, repoPath }
    } catch {
      return {
        outcome: 'inconclusive',
        checks: [
          {
            name: 'repository',
            ok: false,
            detail: 'git could not read the task repository; check that it is still there',
          },
        ],
        repoPath,
      }
    }
  }

  /**
   * The report as stated, linked to the task, and, when git was read, the commit as evidence and
   * the verifier's observed verdict on it. `by` names the agent's lease or the person who filed it.
   */
  #reportOps(
    taskId: string,
    verdict: Verdict,
    report: {
      outcome: string
      summary: string
      commit?: string | undefined
      filesChanged: string[]
      tests: TestRun[]
      idempotencyKey: string
      by: { leaseId: string } | { filedBy: string }
    },
  ): OperationInput[] {
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
          ...report.by,
          idempotencyKey: report.idempotencyKey,
        },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'reports',
        from: '$report',
        to: taskId,
        stance: 'asIs',
        claim: { basis: 'stated' },
      },
    ]
    if (report.commit && verdict.repoPath) {
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
              uri: `git:${verdict.repoPath.replace(/\\/g, '/')}@${report.commit}`,
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
          attributes: {
            method: 'git commit check',
            outcome: verdict.outcome,
            summary: summarise(verdict.checks),
          },
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
    return ops
  }

  #recordReport(
    caller: unknown,
    proposer: Caller,
    located: Located,
    rationale: string,
    ops: OperationInput[],
    verdict: Verdict,
  ): Result<ReportResult> {
    const committed = this.#commit(proposer, located.projectId, rationale, ops)
    if (!committed.ok) return committed
    const { refs } = committed.value
    return ok({
      task: this.#reread(caller, located.projectId, located.view.id) ?? located.view,
      reportId: refs.$report ?? '',
      verification: {
        id: refs.$verification ?? null,
        outcome: verdict.outcome,
        checks: verdict.checks,
      },
      duplicate: false,
    })
  }

  /** A retry with a key already used on this task, answered with the original verdict. */
  #previous(caller: unknown, located: Located, key: string): ReportResult | undefined {
    const previous = this.#reportByKey(caller, located.projectId, located.view.id, key)
    if (!previous) return undefined
    return {
      task: located.view,
      reportId: previous.id,
      verification: previous.verification
        ? {
            id: previous.verification.id,
            outcome: previous.verification.outcome,
            checks: parseSummary(previous.verification.summary),
          }
        : {
            id: null,
            outcome: 'inconclusive',
            checks: [previous.commit ? NO_REPOSITORY : NO_COMMIT],
          },
      duplicate: true,
    }
  }

  /** A person acting directly, with the scopes to change a task through a committed proposal. */
  #person(caller: unknown, projectId: string, what: string): Result<Caller> {
    const c = Caller.safeParse(caller)
    const principal = c.success ? this.#services.store.getPrincipal(c.data.principalId) : undefined
    if (!c.success || !principal) return fail('unauthenticated', 'no valid caller')
    if (principal.kind !== 'human' || c.data.origin !== 'human') {
      return fail(
        'unauthorized',
        `a person, acting directly, ${what}; agents report with submit_execution_report`,
      )
    }
    const held = this.#authz.scopes(principal.id, projectId)
    const missing = PERSON_SCOPES.filter((s) => !held.has(s))
    if (missing.length > 0) {
      return fail('unauthorized', `a person who ${what} needs ${missing.join(' and ')}`, {
        requiredScopes: [...missing],
      })
    }
    return ok(c.data)
  }

  /**
   * Which repository of the model the task repository is: the source snapshot whose commit it
   * holds, or, on a model with no snapshot yet, a new one named after the folder. The analysis is
   * skipped when the model already reflects a later commit that contains the task's commit.
   */
  #modelRepository(
    projectId: string,
    repoPath: string,
    git: TaskGit,
    commit: string,
  ): Result<{ repo: string; skip: string | null }> {
    const project = this.#services.store.getProject(projectId)
    const snapshots = this.#services.store
      .objectsAt(projectId, project?.headRevision ?? 0, { types: ['core.SourceSnapshot'] })
      .filter((o) => o.lifecycle === 'active')
      .map((o) => ({ repo: text(o, 'repo'), commit: text(o, 'commit') }))
      .sort((a, b) => (a.repo < b.repo ? -1 : 1))
    if (snapshots.length === 0) return ok({ repo: basename(repoPath) || 'repository', skip: null })
    const held = snapshots.find((s) => SHA.test(s.commit) && git.findCommit(s.commit) !== null)
    if (!held) {
      return fail(
        'conflicting',
        `the model was analysed from ${snapshots.map((s) => `${s.repo} at ${short(s.commit)}`).join(', ')}, and the task repository holds none of those commits: register the repository the model was built from`,
      )
    }
    const later = held.commit !== commit && git.isAncestor(commit, held.commit)
    return ok({
      repo: held.repo,
      skip: later
        ? `the model already reflects ${short(held.commit)}, which contains ${short(commit)}`
        : null,
    })
  }

  /** The model at a revision, read once, with the source files each element's evidence cites. */
  /** The analyzer versions the project's source snapshots were observed with. */
  #analyzerVersions(projectId: string): string[] {
    const head = this.#services.store.getProject(projectId)?.headRevision ?? 0
    return [
      ...new Set(
        this.#services.store
          .objectsAt(projectId, head, { types: ['core.SourceSnapshot'] })
          .flatMap((o) => o.claim.observation?.toolVersion ?? []),
      ),
    ]
  }

  #model(projectId: string, revision: number): ReconcileModel {
    const store = this.#services.store
    const objects = store.objectsAt(projectId, revision, {})
    const relations = store.relationsAt(projectId, revision, {})
    const evidence = store.evidenceMapAt(projectId, revision)
    const byId = new Map(objects.map((o) => [o.id, o]))
    return {
      objects: byId,
      relations,
      pathsOf: (id) => {
        const o = byId.get(id)
        if (!o) return []
        return [
          ...new Set(
            o.claim.supports.flatMap((g) =>
              g.allOf.flatMap((e) => {
                const source = evidence.get(e)?.source
                return source?.kind === 'sourceSpan' ? [source.path] : []
              }),
            ),
          ),
        ]
      },
    }
  }

  /**
   * The `realizes` link for a matched proposed element: the committed relation when there is one,
   * otherwise the reconciler's earlier proposal when it is pending or a person rejected it,
   * otherwise a new pending proposal by the reconciler, inferred, for a person to commit.
   */
  #linker(projectId: string, head: number, task: TaskView, commit: string, model: ReconcileModel) {
    const reconciler = ensureReconciler(this.#services)
    const proposer: Caller = { principalId: reconciler.id, origin: 'tool' }
    const realized = model.relations.filter(
      (r) => r.type === 'realizes' && r.lifecycle === 'active',
    )
    const earlier = this.#services.store
      .listProposals(projectId, undefined, 100_000)
      .filter((p) => p.proposedBy === reconciler.id)
      .reverse()
    return (
      element: Omit<ReconciledElement, 'link'>,
      match: NonNullable<ReconciledElement['match']>,
    ): ReconciledElement['link'] => {
      const relation = realized.find((r) => r.from === match.id && r.to === element.id)
      if (relation) {
        return { state: 'committed', relationId: relation.id, proposalId: null, created: false }
      }
      const proposal = earlier.find(
        (p) =>
          (p.status === 'pending' || p.status === 'rejected') &&
          p.ops.some(
            (op) =>
              op.op === 'createRelation' &&
              op.type === 'realizes' &&
              op.from === match.id &&
              op.to === element.id,
          ),
      )
      if (proposal) {
        return {
          state: proposal.status === 'pending' ? 'pending' : 'rejected',
          relationId: null,
          proposalId: proposal.id,
          created: false,
        }
      }
      const why = match.inCommit
        ? `the commit changed the files its evidence cites`
        : `the commit did not change the files its evidence cites`
      const proposed = this.#services.proposeChange(proposer, {
        projectId,
        baseRevision: head,
        rationale: `Reconciling task "${task.title}" at ${short(commit)}: the observed ${match.label} realizes the proposed ${element.label}.`,
        ops: [
          {
            op: 'createRelation',
            type: 'realizes',
            from: match.id,
            to: element.id,
            stance: 'asIs',
            properties: {},
            claim: {
              basis: 'inferred',
              method: RECONCILE_METHOD,
              confidence: {
                level: match.inCommit ? 'high' : 'medium',
                rationale: `The analyzer observed ${match.label} at ${short(commit)}, with the same type and name as the proposed ${element.label}; ${why}.`,
              },
              derivedFrom: [match.id, element.id],
            },
          },
        ],
      })
      if (!proposed.ok || proposed.value.status !== 'pending') return null
      return {
        state: 'pending',
        relationId: null,
        proposalId: proposed.value.proposalId,
        created: true,
      }
    }
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
    // The state first: once a task has left running, no lease on it counts, whoever held it.
    if (!statuses.includes(view.status)) {
      return fail('conflicting', notWorkable(view.status))
    }
    const lease = view.lease
    if (!lease || lease.id !== leaseId || lease.holder !== who.value.caller.principalId) {
      return fail('unauthorized', 'you do not hold this lease on the task')
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
              // Stored normalised since 2026-10-19; earlier reports kept paths as typed.
              filesChanged: normaliseFiles((ra.filesChanged as string[] | undefined) ?? []),
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
              filedBy: typeof ra.filedBy === 'string' ? ra.filedBy : null,
            }
          })
          const acceptanceCriteria = (a.acceptanceCriteria as string[] | undefined) ?? []
          const contextPackageId = text(t, 'contextPackageId') || null
          const baseCommit = text(t, 'baseCommit') || null
          const title = text(t, 'title')
          return {
            id: t.id,
            projectId,
            title,
            description: text(t, 'description') || null,
            acceptanceCriteria,
            status,
            statusRationale: text(t, 'statusRationale') || null,
            lease,
            leaseExpired: status === 'running' && lease !== null && lease.expiresAt <= now,
            contextPackageId,
            baseCommit,
            // The kernel clears a finding when the task leaves unknown_outcome.
            finding: status === 'unknown_outcome' && a.finding ? (a.finding as TaskFinding) : null,
            agentPrompt: agentPrompt({
              id: t.id,
              title,
              acceptanceCriteria,
              baseCommit,
              contextPackageId,
            }),
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
