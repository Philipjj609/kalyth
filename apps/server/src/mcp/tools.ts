import type { ContextCompiler } from '@kalyth/context'
import {
  type Caller,
  ClaimTaskInput,
  CommitProposalInput,
  CompileContextInput,
  ContextPackageListQuery,
  ContextPackageQuery,
  canonicalJson,
  DecisionsQuery,
  EvidenceQuery,
  FreshnessQuery,
  fail,
  HistoryQuery,
  ImpactQuery,
  type Issue,
  ObjectQuery,
  ProjectRef,
  ProposalListQuery,
  ProposeChangeInput,
  RelationQuery,
  ReleaseTaskInput,
  RenewLeaseInput,
  type Result,
  SituationQuery,
  SubmitReportInput,
  TaskListQuery,
  TaskQuery,
} from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import type { TaskCoordinator } from '@kalyth/tasks'
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

/**
 * MCP tool catalogue, version 1 (ADR 0007). Every tool calls a service method and nothing else,
 * so MCP requests get exactly the validation, authorisation and revision checks the UI gets.
 * There is deliberately no commit or accept tool: agents propose, people decide (D4). The task
 * tools change only a task's lifecycle records, through the coordinator's checks (ADR 0013).
 */
export interface ToolSpec {
  name: string
  title: string
  description: string
  input: z.ZodType
  readOnly: boolean
  run(deps: McpDeps, caller: Caller, input: unknown): Result<unknown>
}

/** What the tools call: the shared services, the context compiler (ADR 0011) and tasks (ADR 0013). */
export interface McpDeps {
  services: KalythServices
  context: ContextCompiler
  tasks: TaskCoordinator
}

const noInput = z.object({})

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Lists the Kalyth projects this agent may read, with their head revisions.',
    input: noInput,
    readOnly: true,
    run: (d, c) => d.services.listProjects(c),
  },
  {
    name: 'get_project_overview',
    title: 'Project overview',
    description:
      'Counts of objects, relations and evidence at a revision (default: head), plus pending proposals.',
    input: ProjectRef,
    readOnly: true,
    run: (d, c, i) => d.services.getProjectOverview(c, i),
  },
  {
    name: 'describe_types',
    title: 'Describe types',
    description:
      'Object types with their attribute JSON Schemas, and relation types with allowed endpoints and impact rules.',
    input: noInput,
    readOnly: true,
    run: (d, c) => d.services.describeTypes(c),
  },
  {
    name: 'query_objects',
    title: 'Query objects',
    description:
      'Typed objects at a revision. Each carries its claim: basis (observed, inferred, stated, imported), evidence support groups and provenance. "observed" means a tool observed it in source, not that runtime behaviour was verified.',
    input: ObjectQuery,
    readOnly: true,
    run: (d, c, i) => d.services.queryObjects(c, i),
  },
  {
    name: 'query_relations',
    title: 'Query relations',
    description: 'Typed relations at a revision, filterable by type and endpoint.',
    input: RelationQuery,
    readOnly: true,
    run: (d, c, i) => d.services.queryRelations(c, i),
  },
  {
    name: 'get_evidence',
    title: 'Get evidence',
    description:
      'Evidence records: pinned source (commit, path, blob, line span), collector and excerpt text unless redacted.',
    input: EvidenceQuery,
    readOnly: true,
    run: (d, c, i) => d.services.getEvidence(c, i),
  },
  {
    name: 'get_history',
    title: 'Revision history',
    description: 'Committed change sets, newest first, with who proposed and who committed each.',
    input: HistoryQuery,
    readOnly: true,
    run: (d, c, i) => d.services.getHistory(c, i),
  },
  {
    name: 'assess_freshness',
    title: 'Assess freshness',
    description:
      'Freshness of every claim at a revision against the recorded source snapshots: current, weakened (some evidence stale but still supported), stale (needs review), derived-stale, unknown or not-applicable. Check this before relying on observed facts.',
    input: FreshnessQuery,
    readOnly: true,
    run: (d, c, i) => d.services.assessFreshness(c, i),
  },
  {
    name: 'get_situation',
    title: 'Project situation',
    description:
      'What needs attention: open decisions with their alternatives, open questions, pending proposals and stale claims. Read this first to see what people are deciding before proposing changes.',
    input: SituationQuery,
    readOnly: true,
    run: (d, c, i) => d.services.getSituation(c, i),
  },
  {
    name: 'analyze_impact',
    title: 'Analyze impact',
    description:
      'Elements a change to the seed elements may affect, each with a typed path (relation, direction, rule). Deterministic: it follows the impact rule declared by each relation type, plus "a module defines its endpoints and data entities". It is a dependency trace, not a prediction; check freshness of the relations it walks.',
    input: ImpactQuery,
    readOnly: true,
    run: (d, c, i) => d.services.analyzeImpact(c, i),
  },
  {
    name: 'list_decisions',
    title: 'List decisions',
    description:
      'Decisions with their status, alternatives and the elements each alternative changes directly. Filter by status "accepted" to find work that people have decided and that can be handed off.',
    input: DecisionsQuery,
    readOnly: true,
    run: (d, c, i) => d.services.listDecisions(c, i),
  },
  {
    name: 'compile_context_package',
    title: 'Compile a context package',
    description:
      'Builds the context for a task: focus elements, or an accepted decision, which expands to the elements its accepted alternative changes. The mandatory part (invariants, constraints, accepted decisions, acceptance criteria, agent policy) is never truncated; optional items are ranked by typed distance and cut at maxChars with an omissions list and retrieval calls. The result is content-addressed and pinned to one revision: propose against that revision.',
    input: CompileContextInput,
    readOnly: true,
    run: (d, c, i) => d.context.compile(c, i),
  },
  {
    name: 'list_context_packages',
    title: 'List context packages',
    description:
      'Context packages compiled for a project, newest first, with their revision, focus, task and size. Read one with get_context_package.',
    input: ContextPackageListQuery,
    readOnly: true,
    run: (d, c, i) => d.context.list(c, i),
  },
  {
    name: 'get_context_package',
    title: 'Get a context package',
    description:
      'Reads a context package by id (ctx_...), for example one a person prepared for you in Kalyth. Also available as the resource kalyth://context/{packageId}.',
    input: ContextPackageQuery,
    readOnly: true,
    run: (d, c, i) => d.context.get(c, i),
  },
  {
    name: 'propose_change',
    title: 'Propose a change',
    description:
      'Submits typed operations against a base revision. The proposal is validated and stored as pending (or invalid, with issues). It changes nothing until a person reviews and commits it in Kalyth. Use local refs like "$name" to link records created in the same proposal, an idempotencyKey when retrying, and contextPackageId when the work answers a context package.',
    input: ProposeChangeInput,
    readOnly: false,
    run: (d, c, i) => {
      const checked = d.context.checkProvenance(c, i)
      return checked.ok ? d.services.proposeChange(c, i) : checked
    },
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'Tasks in a project with their status, lease, what they implement, what they wait for and their execution reports. Filter by status, for example "ready" for work you can claim.',
    input: TaskListQuery,
    readOnly: true,
    run: (d, c, i) => d.tasks.listTasks(c, i),
  },
  {
    name: 'get_task',
    title: 'Get a task',
    description:
      'One task: description, acceptance criteria, links, lease and every execution report with its verification.',
    input: TaskQuery,
    readOnly: true,
    run: (d, c, i) => d.tasks.getTask(c, i),
  },
  {
    name: 'claim_task',
    title: 'Claim a task',
    description:
      'Takes a ready task with a lease (default 60 minutes) and returns the context package to read first and the commit trailer to use. Refused while another agent holds the task, while its requirements are unmet, or when an expired holder may already have committed. Renew the lease with renew_task_lease if the work runs longer.',
    input: ClaimTaskInput,
    readOnly: false,
    run: (d, c, i) => d.tasks.claim(c, i),
  },
  {
    name: 'renew_task_lease',
    title: 'Renew a task lease',
    description: 'Extends the lease you hold on a running task.',
    input: RenewLeaseInput,
    readOnly: false,
    run: (d, c, i) => d.tasks.renew(c, i),
  },
  {
    name: 'release_task',
    title: 'Release a task',
    description:
      'Gives up a task you hold without reporting work, with a reason; it goes back to ready for others.',
    input: ReleaseTaskInput,
    readOnly: false,
    run: (d, c, i) => d.tasks.release(c, i),
  },
  {
    name: 'submit_execution_report',
    title: 'Submit an execution report',
    description:
      'Reports the work on a task you hold: outcome, summary, the sha of your last commit, every file your work changed (since the task base, when the task has one) and the tests you ran. Kalyth checks the work in the task repository: the commit exists on a branch or tag, its message carries the Kalyth-Task trailer, it descends from the task base, and the files changed from the base to it are exactly those reported; the verdict lists the commits in that range. That check is recorded as an observed verification. A passing report moves the task to review; a person completes it. Tests are recorded as reported, not run. Reuse the idempotencyKey when retrying: a retry returns the original verdict.',
    input: SubmitReportInput,
    readOnly: false,
    run: (d, c, i) => d.tasks.submitReport(c, i),
  },
  {
    name: 'get_proposal',
    title: 'Get proposal',
    description: 'A proposal with its status, issues and, once committed, the resulting revision.',
    input: CommitProposalInput,
    readOnly: true,
    run: (d, c, i) => d.services.getProposal(c, i),
  },
  {
    name: 'list_proposals',
    title: 'List proposals',
    description: 'Proposals for a project, optionally filtered by status.',
    input: ProposalListQuery,
    readOnly: true,
    run: (d, c, i) => d.services.listProposals(c, i),
  },
]

/** Schema issues returned for one call at most; the message counts the rest. */
const MAX_ISSUES = 20

/**
 * The input schema a tool advertises: its own zod schema, converted to JSON Schema for
 * tools/list, with validation left to {@link callTool}. Given the zod schema itself, the SDK would
 * refuse invalid input before Kalyth sees it, as plain "Input validation error" text; callTool
 * validates against the same schema and answers in the shared error envelope. Nothing reaches a
 * service unparsed, so validation is not weakened.
 */
export function advertisedSchema(schema: z.ZodType): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'kalyth',
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema['~standard'].jsonSchema,
    },
  }
}

/**
 * Runs a tool on its parsed input. Input that does not match the tool's schema is refused with
 * code `invalid` and the zod issues, like every other Kalyth failure (ADR 0013, amendment).
 */
export function callTool(
  tool: ToolSpec,
  deps: McpDeps,
  caller: Caller,
  input: unknown,
): Result<unknown> {
  const parsed = tool.input.safeParse(input ?? {})
  if (parsed.success) return tool.run(deps, caller, parsed.data)
  const all = parsed.error.issues
  const issues: Issue[] = all.slice(0, MAX_ISSUES).map((i) => ({
    code: `schema.${i.code}`,
    message: i.message,
    path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
  }))
  const named = issues
    .slice(0, 3)
    .map((i) => (i.path?.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
  const more = all.length > 3 ? ` (and ${all.length - 3} more)` : ''
  return fail('invalid', `input does not match the ${tool.name} input schema: ${named}${more}`, {
    issues,
  })
}

export interface ToolCallOutput {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  structuredContent: Record<string, unknown>
  isError?: boolean
}

/** Success returns the service value; failure returns the shared error envelope with isError. */
export function toToolResult(result: Result<unknown>): ToolCallOutput {
  if (result.ok) {
    const value = result.value as Record<string, unknown>
    return { content: [{ type: 'text', text: canonicalJson(value) }], structuredContent: value }
  }
  const body = { error: result.error }
  return {
    content: [{ type: 'text', text: canonicalJson(body) }],
    structuredContent: body,
    isError: true,
  }
}
