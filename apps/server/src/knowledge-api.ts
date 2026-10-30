import {
  AssessInput,
  type Caller,
  GetAssessmentInput,
  GetKnowledgeInput,
  GetMethodRunInput,
  KnowledgeSearchInput,
  LibraryUsesInput,
  ListAssessmentsInput,
  ListMethodRunsInput,
  MethodRunInput,
  PinnedKnowledgeInput,
  PinStatusQuery,
  type Result,
} from '@kalyth/contracts'
import type { KalythServices } from '@kalyth/core'
import type { z } from 'zod'

/**
 * Access to engineering knowledge, assessments and method runs (K4, ADR 0031; K6a, ADR 0033).
 * One table drives both interfaces: each entry is an MCP tool of the same name and an HTTP route
 * `POST /api/v1/knowledge/<name>` with the same input as its JSON body, so the two can only
 * return the same thing. Every entry calls one service method, which validates and authorises.
 * All are read-only except run_method, which files a proposal, as propose_change does; nothing
 * here commits.
 */
export interface KnowledgeOperation {
  name: string
  title: string
  description: string
  input: z.ZodType
  readOnly: boolean
  run(services: KalythServices, caller: Caller, input: unknown): Result<unknown>
}

const NOT_ADVICE =
  'Results report declared conditions, evidence and review state; they are never engineering recommendations (readAs.recommendation is always false).'

export const KNOWLEDGE_OPERATIONS: readonly KnowledgeOperation[] = [
  {
    name: 'search_knowledge',
    title: 'Search knowledge',
    description: `Searches knowledge items by name, alias and text: in a library at its head, or in every library a project uses, at the revision it uses. Lists libraries it could not search. ${NOT_ADVICE}`,
    input: KnowledgeSearchInput,
    readOnly: true,
    run: (s, c, i) => s.searchKnowledge(c, i),
  },
  {
    name: 'get_knowledge',
    title: 'Get knowledge',
    description: `One knowledge item at a library revision: canonical content and hash, maturity (established means reviewed, not proven), dispute, support groups with review and source verification (a verified locator is not a matched quotation), sources with attribution, and relations, bounded. ${NOT_ADVICE}`,
    input: GetKnowledgeInput,
    readOnly: true,
    run: (s, c, i) => s.getKnowledge(c, i),
  },
  {
    name: 'get_method',
    title: 'Get method',
    description: `A knowledge.Method at a library revision, read like get_knowledge: purpose, steps, checks and what it uses. ${NOT_ADVICE}`,
    input: GetKnowledgeInput,
    readOnly: true,
    run: (s, c, i) => s.getMethod(c, i),
  },
  {
    name: 'list_library_uses',
    title: 'List library uses',
    description:
      'The libraries a project uses, at which revision, whether each is present, and how many revisions it has moved on since.',
    input: LibraryUsesInput,
    readOnly: true,
    run: (s, c, i) => s.listLibraryUses(c, i),
  },
  {
    name: 'get_pin_status',
    title: 'Pin status',
    description:
      'Every knowledge pin of a project: how it resolves (embedded copy, library, or unresolved with the reason) and its freshness against the library revision used, or a previewed one.',
    input: PinStatusQuery,
    readOnly: true,
    run: (s, c, i) => s.getPinStatus(c, i),
  },
  {
    name: 'get_pinned_knowledge',
    title: 'Pinned knowledge',
    description:
      'The exact knowledge versions a project pins, with the evidence records they cite, from the project’s own embedded copies. Needs knowledge.pinned.read on the project (ADR 0032); never reads the library, so it shows no later revision and nothing the project did not pin.',
    input: PinnedKnowledgeInput,
    readOnly: true,
    run: (s, c, i) => s.getPinnedKnowledge(c, i),
  },
  {
    name: 'assess_applicability',
    title: 'Assess applicability',
    description: `Evaluates whether the declared conditions of one pinned pattern or principle hold, for one scenario, optional element and an explicit parameter nature (current, expected, target or limit). Returns the verdict, the conditions evaluated with the parameters used and where they came from, missing values, disputes, library revisions, conflicts between libraries and any decision that settled one. conditionsMet only means the declared conditions hold; unknown covers missing, contradictory and underspecified cases. Read-only; nothing is recorded. ${NOT_ADVICE}`,
    input: AssessInput,
    readOnly: true,
    run: (s, c, i) => s.assessApplicability(c, i),
  },
  {
    name: 'list_assessments',
    title: 'List assessments',
    description: `The recorded assessments of a project, each with its verdict, nature, specification, conflict state and freshness (current or stale, with reasons and the verdict it would have now). ${NOT_ADVICE}`,
    input: ListAssessmentsInput,
    readOnly: true,
    run: (s, c, i) => s.listAssessments(c, i),
  },
  {
    name: 'get_assessment',
    title: 'Get assessment',
    description: `One recorded assessment with its full explanation, the inputs it read and its freshness. ${NOT_ADVICE}`,
    input: GetAssessmentInput,
    readOnly: true,
    run: (s, c, i) => s.getAssessment(c, i),
  },
  {
    name: 'run_method',
    title: 'Run a method',
    description: `Runs a pinned knowledge.Method deterministically, with no model call (ADR 0033): selects patterns and principles from the libraries the project uses, assesses each in every scenario, element and explicit nature given, asks for missing values and gaps, and compares the patterns as alternatives with their trade-offs and the assessments behind them. Files one proposal, which a person reviews and commits; it never commits or decides. Needs project read and proposal.create, and read on every library the project uses. ${NOT_ADVICE}`,
    input: MethodRunInput,
    readOnly: false,
    run: (s, c, i) => s.startMethodRun(c, i),
  },
  {
    name: 'get_method_run',
    title: 'Get method run',
    description: `One method run: its pinned inputs, selection with the source of every candidate, uncertainties, comparison, checks, its proposal and what became of it. ${NOT_ADVICE}`,
    input: GetMethodRunInput,
    readOnly: true,
    run: (s, c, i) => s.getMethodRun(c, i),
  },
  {
    name: 'list_method_runs',
    title: 'List method runs',
    description: 'The method runs of a project, newest first, with their status and proposal.',
    input: ListMethodRunsInput,
    readOnly: true,
    run: (s, c, i) => s.listMethodRuns(c, i),
  },
]
