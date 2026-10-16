import {
  type Caller,
  CommitProposalInput,
  canonicalJson,
  EvidenceQuery,
  FreshnessQuery,
  HistoryQuery,
  ImpactQuery,
  ObjectQuery,
  ProjectRef,
  ProposalListQuery,
  ProposeChangeInput,
  RelationQuery,
  type Result,
} from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import { z } from 'zod'

/**
 * MCP tool catalogue, version 1 (ADR 0007). Every tool calls a service method and nothing else,
 * so MCP requests get exactly the validation, authorisation and revision checks the UI gets.
 * There is deliberately no commit or accept tool: agents propose, people decide (D4).
 */
export interface ToolSpec {
  name: string
  title: string
  description: string
  input: z.ZodType
  readOnly: boolean
  run(services: KalythServices, caller: Caller, input: unknown): Result<unknown>
}

const noInput = z.object({})

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Lists the Kalyth projects this agent may read, with their head revisions.',
    input: noInput,
    readOnly: true,
    run: (s, c) => s.listProjects(c),
  },
  {
    name: 'get_project_overview',
    title: 'Project overview',
    description:
      'Counts of objects, relations and evidence at a revision (default: head), plus pending proposals.',
    input: ProjectRef,
    readOnly: true,
    run: (s, c, i) => s.getProjectOverview(c, i),
  },
  {
    name: 'describe_types',
    title: 'Describe types',
    description:
      'Object types with their attribute JSON Schemas, and relation types with allowed endpoints and impact rules.',
    input: noInput,
    readOnly: true,
    run: (s, c) => s.describeTypes(c),
  },
  {
    name: 'query_objects',
    title: 'Query objects',
    description:
      'Typed objects at a revision. Each carries its claim: basis (observed, inferred, stated, imported), evidence support groups and provenance. "observed" means a tool observed it in source, not that runtime behaviour was verified.',
    input: ObjectQuery,
    readOnly: true,
    run: (s, c, i) => s.queryObjects(c, i),
  },
  {
    name: 'query_relations',
    title: 'Query relations',
    description: 'Typed relations at a revision, filterable by type and endpoint.',
    input: RelationQuery,
    readOnly: true,
    run: (s, c, i) => s.queryRelations(c, i),
  },
  {
    name: 'get_evidence',
    title: 'Get evidence',
    description:
      'Evidence records: pinned source (commit, path, blob, line span), collector and excerpt text unless redacted.',
    input: EvidenceQuery,
    readOnly: true,
    run: (s, c, i) => s.getEvidence(c, i),
  },
  {
    name: 'get_history',
    title: 'Revision history',
    description: 'Committed change sets, newest first, with who proposed and who committed each.',
    input: HistoryQuery,
    readOnly: true,
    run: (s, c, i) => s.getHistory(c, i),
  },
  {
    name: 'assess_freshness',
    title: 'Assess freshness',
    description:
      'Freshness of every claim at a revision against the recorded source snapshots: current, weakened (some evidence stale but still supported), stale (needs review), derived-stale, unknown or not-applicable. Check this before relying on observed facts.',
    input: FreshnessQuery,
    readOnly: true,
    run: (s, c, i) => s.assessFreshness(c, i),
  },
  {
    name: 'analyze_impact',
    title: 'Analyze impact',
    description:
      'Elements a change to the seed elements may affect, each with a typed path (relation, direction, rule). Deterministic: it follows the impact rule declared by each relation type, plus "a module defines its endpoints and data entities". It is a dependency trace, not a prediction; check freshness of the relations it walks.',
    input: ImpactQuery,
    readOnly: true,
    run: (s, c, i) => s.analyzeImpact(c, i),
  },
  {
    name: 'propose_change',
    title: 'Propose a change',
    description:
      'Submits typed operations against a base revision. The proposal is validated and stored as pending (or invalid, with issues). It changes nothing until a person reviews and commits it in Kalyth. Use local refs like "$name" to link records created in the same proposal, and an idempotencyKey when retrying.',
    input: ProposeChangeInput,
    readOnly: false,
    run: (s, c, i) => s.proposeChange(c, i),
  },
  {
    name: 'get_proposal',
    title: 'Get proposal',
    description: 'A proposal with its status, issues and, once committed, the resulting revision.',
    input: CommitProposalInput,
    readOnly: true,
    run: (s, c, i) => s.getProposal(c, i),
  },
  {
    name: 'list_proposals',
    title: 'List proposals',
    description: 'Proposals for a project, optionally filtered by status.',
    input: ProposalListQuery,
    readOnly: true,
    run: (s, c, i) => s.listProposals(c, i),
  },
]

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
