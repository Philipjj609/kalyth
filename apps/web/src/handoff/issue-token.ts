import type { IssuedAgentToken } from '@kalyth/contracts'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Api, type IssueAgentTokenBody, isApiError } from '../api/client.ts'
import { api, keys, upsertTokenSummary } from '../api/queries.ts'
import { session } from '../app/session.ts'

/**
 * Issues an agent token (ADR 0011). The secret is returned to the caller only: the query cache
 * gets the summary, and nothing is written to storage, the URL or the mutation cache. The caller
 * holds the secret in component state, so it is gone once the person leaves the panel.
 */
export async function issueAgentToken(
  source: Pick<Api, 'issueAgentToken'>,
  client: QueryClient,
  projectId: string,
  input: IssueAgentTokenBody,
): Promise<IssuedAgentToken> {
  const issued = await source.issueAgentToken(projectId, input)
  upsertTokenSummary(client, issued.summary)
  void client.invalidateQueries({ queryKey: keys.agentTokens(projectId) })
  return issued
}

/**
 * The newly issued token, shown once. Deliberately not a react-query mutation, which would keep
 * the secret in the mutation cache after the panel unmounts. A response that arrives after the
 * panel is gone is dropped.
 */
export function useAgentTokenIssuer(projectId: string) {
  const client = useQueryClient()
  const [issued, setIssued] = useState<IssuedAgentToken | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const issue = useCallback(
    async (input: IssueAgentTokenBody) => {
      setPending(true)
      setError(null)
      setIssued(null)
      try {
        const result = await issueAgentToken(api, client, projectId, input)
        if (mounted.current) setIssued(result)
      } catch (e) {
        if (isApiError(e) && e.status === 401) session.reject()
        if (mounted.current) setError(e)
      } finally {
        if (mounted.current) setPending(false)
      }
    },
    [client, projectId],
  )
  const clear = useCallback(() => setIssued(null), [])
  return { issued, pending, error, issue, clear }
}
