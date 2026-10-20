import type { FileReportInput, ReconcileResult, ReportResult } from '@kalyth/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, type FetchLike, toApiErrorBody } from '../api/client.ts'
import { keys } from '../api/queries.ts'
import { session, UI_HEADER } from '../app/session.ts'

/**
 * A person's follow-up on a task (ADR 0024): filing a report for work done outside an agent
 * session, and reconciling the model with a task's verified commit. Both are HTTP only and act for
 * the person in this session; agents report over MCP. Requests are made as the shared client
 * makes them: the session token, or the demo's cookie, and the UI header on every change.
 */

/** Body of POST /tasks/:id/reports: the task is in the path. */
export type FileReportBody = Omit<FileReportInput, 'taskId'>

export function createTaskApi(getToken: () => string | null, fetchImpl?: FetchLike) {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init))

  async function post<T>(url: string, body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', [UI_HEADER]: '1' }
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        credentials: token ? 'omit' : 'same-origin',
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new ApiError(0, {
        code: 'retryable',
        message: 'Cannot reach the Kalyth server. Is it running?',
        issues: [],
      })
    }
    const text = await res.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }
    if (!res.ok) throw new ApiError(res.status, toApiErrorBody(res.status, payload))
    return payload as T
  }

  const task = (taskId: string) => `/api/v1/tasks/${encodeURIComponent(taskId)}`
  return {
    /** Files a report as this person; git verifies it like an agent's. Answers 201. */
    fileReport: (taskId: string, body: FileReportBody) =>
      post<ReportResult>(`${task(taskId)}/reports`, { ...body }),
    /** Re-analyses the verified commit and proposes the links it finds. */
    reconcile: (taskId: string) => post<ReconcileResult>(`${task(taskId)}/reconcile`),
  }
}

export const taskApi = createTaskApi(() => session.token())

/** Everything a report or a reconciliation may have changed: tasks, the model and its history. */
function useInvalidate(projectId: string) {
  const client = useQueryClient()
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.tasks(projectId) }),
      client.invalidateQueries({ queryKey: ['task'] }),
      client.invalidateQueries({ queryKey: ['overview', projectId] }),
      client.invalidateQueries({ queryKey: keys.proposals(projectId) }),
      client.invalidateQueries({ queryKey: keys.history(projectId) }),
      client.invalidateQueries({ queryKey: keys.situation(projectId) }),
      client.invalidateQueries({ queryKey: ['decisions', projectId] }),
    ])
}

export function useFileReport(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation<ReportResult, ApiError, { taskId: string; body: FileReportBody }>({
    mutationFn: ({ taskId, body }) => taskApi.fileReport(taskId, body),
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}

export function useReconcileTask(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation<ReconcileResult, ApiError, string>({
    mutationFn: (taskId) => taskApi.reconcile(taskId),
    onSettled: invalidate,
    onError: (error) => {
      if (error.status === 401) session.reject()
    },
  })
}
