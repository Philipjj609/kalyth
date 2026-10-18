import { describe, expect, it } from 'vitest'
import { ApiError, createApi, type FetchLike } from './client.ts'

const PROJECT = `prj_${'1'.repeat(32)}`

describe('project export (ADR 0014)', () => {
  it('fetches the bundle with the session token and names the file after project and revision', async () => {
    const served = `{"format":"kalyth.project-export","project":{"id":"${PROJECT}","headRevision":7},"events":[{"b":1,"a":2}]}`
    const seen: { url: string; auth: string | undefined }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
      return new Response(served, { status: 200 })
    }
    const result = await createApi(() => 'session-token-123', fetchImpl).exportProject(PROJECT)
    expect(seen).toEqual([
      { url: `/api/v1/projects/${PROJECT}/export`, auth: 'Bearer session-token-123' },
    ])
    expect(result.fileName).toBe(`kalyth-${PROJECT}-r7.json`)
    // Saved as served: key order inside the events is kept.
    expect(result.text).toBe(`${served}\n`)
  })

  it('surfaces a refusal as an API error', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'a person exports', issues: [] },
        }),
        { status: 403 },
      )
    await expect(createApi(() => 't', fetchImpl).exportProject(PROJECT)).rejects.toBeInstanceOf(
      ApiError,
    )
  })
})
