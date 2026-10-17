import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  request: z.string().min(3).max(2000),
  impacted: z
    .array(z.object({ path: z.string().min(1).max(1000), lines: z.string().optional() }))
    .min(1),
  newFiles: z.array(z.string()).default([]),
})
export type Scenario = z.infer<typeof Scenario>

export const GroundTruth = z.object({
  status: z.enum(['draft', 'frozen']),
  repository: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  source: z.string(),
  unit: z.string(),
  reviewedBy: z.string().nullable(),
  frozenAt: z.string().nullable(),
  scenarios: z.array(Scenario).min(1),
})
export type GroundTruth = z.infer<typeof GroundTruth>

/** What a dry run may see: the requests, never the answers. */
export type ScenarioRequest = Pick<Scenario, 'id' | 'request'>

export class TruthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TruthError'
  }
}

export interface LoadedTruth {
  truth: GroundTruth
  sha256: string
}

/**
 * Loads a ground-truth file for scoring (ADR 0012). It must be frozen, name its reviewer and freeze
 * date, and hash to the value recorded when it was frozen; anything else is refused.
 */
export function loadFrozenTruth(path: string, expectedSha256: string): LoadedTruth {
  const raw = readFileSync(path)
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const truth = GroundTruth.parse(JSON.parse(raw.toString('utf8')))
  if (truth.status !== 'frozen' || !truth.reviewedBy || !truth.frozenAt) {
    throw new TruthError(
      `${path} is not frozen: a reviewer other than the implementer must review and freeze it first (docs/evaluation/README.md)`,
    )
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || sha256 !== expectedSha256) {
    throw new TruthError(
      `${path} hashes to ${sha256}, not the recorded ${expectedSha256 || '(none given)'}; refusing to score`,
    )
  }
  return { truth, sha256 }
}

/** Loads only the scenario requests and the commit, for a dry run that scores nothing. */
export function loadRequestsOnly(path: string): {
  repository: string
  commit: string
  scenarios: ScenarioRequest[]
} {
  const truth = GroundTruth.parse(JSON.parse(readFileSync(path, 'utf8')))
  return {
    repository: truth.repository,
    commit: truth.commit,
    scenarios: truth.scenarios.map((s) => ({ id: s.id, request: s.request })),
  }
}
