import { ContextPackage, type ContextPackageSummary } from '@kalyth/contracts'
import type { SqliteStore } from '@kalyth/core'

type Db = SqliteStore['db']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS context_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  first_compiled_at TEXT NOT NULL,
  first_compiled_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_packages_by_project ON context_packages (project_id, revision);
CREATE TRIGGER IF NOT EXISTS context_packages_immutable BEFORE UPDATE ON context_packages
  BEGIN SELECT RAISE(ABORT, 'context packages are immutable'); END;
`

/**
 * Packages are content-addressed and immutable: storing one twice keeps the first record. They are
 * operational data beside the kernel tables, outside the event log (ADR 0011).
 */
export class PackageStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
    this.#db.exec(SCHEMA)
  }

  put(pkg: ContextPackage, compiledBy: string, at: string): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO context_packages (id, project_id, revision, body, first_compiled_at, first_compiled_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(pkg.id, pkg.projectId, pkg.revision, JSON.stringify(pkg), at, compiledBy)
  }

  list(projectId: string, limit: number): ContextPackageSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT body, first_compiled_at FROM context_packages WHERE project_id = ?
         ORDER BY first_compiled_at DESC, id DESC LIMIT ?`,
      )
      .all(projectId, limit) as { body: string; first_compiled_at: string }[]
    return rows.map((r) => {
      const p = ContextPackage.parse(JSON.parse(r.body))
      return {
        id: p.id,
        revision: p.revision,
        status: p.status,
        focus: p.focus,
        taskTitle: p.task?.title ?? null,
        items: p.items.length,
        chars: p.size.chars,
        firstCompiledAt: r.first_compiled_at,
      }
    })
  }

  get(id: string): ContextPackage | undefined {
    const row = this.#db.prepare('SELECT body FROM context_packages WHERE id = ?').get(id) as
      | { body: string }
      | undefined
    return row ? ContextPackage.parse(JSON.parse(row.body)) : undefined
  }
}
