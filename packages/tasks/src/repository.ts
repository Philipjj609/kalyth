import type { TaskRepositoryView } from '@kalyth/contracts'
import type { SqliteStore } from '@kalyth/core'

type Db = SqliteStore['db']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_repositories (
  project_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
`

/**
 * Where agents commit their work, per project, registered by a person (ADR 0013). Operational
 * configuration beside the kernel tables; Kalyth only ever reads the repository.
 */
export class TaskRepositories {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
    this.#db.exec(SCHEMA)
  }

  get(projectId: string): TaskRepositoryView {
    const row = this.#db
      .prepare('SELECT path, set_by, set_at FROM task_repositories WHERE project_id = ?')
      .get(projectId) as { path: string; set_by: string; set_at: string } | undefined
    return {
      projectId,
      path: row?.path ?? null,
      setBy: row?.set_by ?? null,
      setAt: row?.set_at ?? null,
    }
  }

  set(projectId: string, path: string, by: string, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO task_repositories (project_id, path, set_by, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET path = excluded.path, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(projectId, path, by, at)
  }
}
