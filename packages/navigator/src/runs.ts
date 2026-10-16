import { NavigatorRun } from '@kalyth/contracts'
import type { SqliteStore } from '@kalyth/core'

type Db = SqliteStore['db']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS navigator_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS navigator_runs_by_project ON navigator_runs (project_id, started_at);
`

/**
 * Run records: operational data beside the kernel tables, outside the replayable event log
 * (ADR 0010). What a run produced lives in its proposal, which the kernel keeps.
 */
export class RunStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
    this.#db.exec(SCHEMA)
  }

  insert(run: NavigatorRun): void {
    this.#db
      .prepare(
        'INSERT INTO navigator_runs (id, project_id, started_at, status, data) VALUES (?, ?, ?, ?, ?)',
      )
      .run(run.id, run.projectId, run.startedAt, run.status, JSON.stringify(run))
  }

  update(run: NavigatorRun): void {
    this.#db
      .prepare('UPDATE navigator_runs SET status = ?, data = ? WHERE id = ?')
      .run(run.status, JSON.stringify(run), run.id)
  }

  get(id: string): NavigatorRun | undefined {
    const row = this.#db.prepare('SELECT data FROM navigator_runs WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    return row ? NavigatorRun.parse(JSON.parse(row.data)) : undefined
  }

  list(projectId: string, limit: number): NavigatorRun[] {
    const rows = this.#db
      .prepare(
        'SELECT data FROM navigator_runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
      )
      .all(projectId, limit) as { data: string }[]
    return rows.map((r) => NavigatorRun.parse(JSON.parse(r.data)))
  }

  running(projectId: string): NavigatorRun | undefined {
    const row = this.#db
      .prepare(
        "SELECT data FROM navigator_runs WHERE project_id = ? AND status = 'running' LIMIT 1",
      )
      .get(projectId) as { data: string } | undefined
    return row ? NavigatorRun.parse(JSON.parse(row.data)) : undefined
  }

  /** Runs left running by a previous process cannot finish; they are marked failed at startup. */
  failInterrupted(now: string): void {
    const rows = this.#db
      .prepare("SELECT data FROM navigator_runs WHERE status = 'running'")
      .all() as { data: string }[]
    for (const row of rows) {
      const run = NavigatorRun.parse(JSON.parse(row.data))
      this.update({
        ...run,
        status: 'failed',
        finishedAt: now,
        error: {
          code: 'retryable',
          message: 'the server stopped while this run was in progress',
          issues: [],
        },
      })
    }
  }
}
