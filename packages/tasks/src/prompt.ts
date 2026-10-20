import type { TaskView } from '@kalyth/contracts'
import { findSecretRule } from '@kalyth/core'
import { oneLine, taskTrailer } from './verifier.ts'

/** Longest title or criterion quoted in a prompt; the task itself holds the full text. */
const MAX_QUOTED = 1000

/**
 * Text a person wrote, made safe to quote: on one line, with control and bidirectional characters
 * escaped, so it cannot add instructions on lines of its own; bounded; and withheld when it looks
 * like a credential, since the prompt is pasted into another tool.
 */
function quoted(text: string): string {
  const rule = findSecretRule(text)
  if (rule) return `[withheld: this text looks like a secret (${rule}); read it in Kalyth]`
  const line = oneLine(text.trim())
  return line.length <= MAX_QUOTED ? line : `${line.slice(0, MAX_QUOTED - 1)}…`
}

/**
 * What a person pastes into a coding agent, such as Claude Code or Codex, to start a task
 * (ADR 0024). It is computed from the task alone, so the same task always gives the same text. It
 * names Kalyth's MCP tools and the commit trailer, and never holds a token or other secret: the
 * agent connects to Kalyth with its own credential.
 */
export function agentPrompt(
  task: Pick<TaskView, 'id' | 'title' | 'acceptanceCriteria' | 'baseCommit' | 'contextPackageId'>,
): string {
  const criteria =
    task.acceptanceCriteria.length === 0
      ? [
          '3. The task states no acceptance criteria: change only what its title asks for, and ask the person before going further.',
        ]
      : [
          '3. Change only what these acceptance criteria allow:',
          ...task.acceptanceCriteria.map((c) => `   - ${quoted(c)}`),
        ]
  return [
    `Work on Kalyth task ${task.id}: "${quoted(task.title)}". Use the Kalyth MCP tools for every Kalyth step.`,
    '',
    `1. Call claim_task with taskId "${task.id}". It gives you a lease and the context package for the task${task.contextPackageId ? ` (${task.contextPackageId})` : ''}. Read the package with get_context_package before you change anything.`,
    task.baseCommit
      ? `2. In the task repository, create a branch from the task base commit ${task.baseCommit}.`
      : '2. The task has no base commit: in the task repository, create a branch from the commit it is on now, and do the work in one commit.',
    ...criteria,
    '4. End every commit message for this task with this trailer, on a line of its own:',
    `   ${taskTrailer(task.id)}`,
    `5. When done, call submit_execution_report with the lease id from claim_task, the sha of your last commit, every file your commits changed${task.baseCommit ? ' since the base commit' : ''}, and each test command you ran with its passed and failed counts. Say plainly in the summary which tests and checks you did not run.`,
    '',
    'Kalyth checks the report against the task repository, and a person reviews and completes the task. Do not mark the task complete yourself. Propose changes to the Kalyth model with propose_change only when a person asks you to.',
  ].join('\n')
}
