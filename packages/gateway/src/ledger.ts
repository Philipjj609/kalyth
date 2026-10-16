import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BudgetStatus, ProviderConsent } from '@kalyth/contracts'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_caps (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cap_micro_usd INTEGER NOT NULL CHECK (cap_micro_usd >= 0),
  note TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  project_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'unknown_outcome')),
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd >= 0),
  cost_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS ledger_consent (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  principal_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ledger_caps_append_only BEFORE UPDATE ON ledger_caps
  BEGIN SELECT RAISE(ABORT, 'ledger caps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_caps_no_delete BEFORE DELETE ON ledger_caps
  BEGIN SELECT RAISE(ABORT, 'ledger caps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_calls_no_delete BEFORE DELETE ON ledger_calls
  BEGIN SELECT RAISE(ABORT, 'ledger calls cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS ledger_consent_no_delete BEFORE DELETE ON ledger_consent
  BEGIN SELECT RAISE(ABORT, 'consent history cannot be deleted'); END;
`

export const ADVISORY_THRESHOLDS = [0.5, 0.8] as const

export type Reservation =
  | { ok: true; id: number }
  | { ok: false; remainingMicroUsd: number; neededMicroUsd: number }

export interface Usage {
  costMicroUsd: number
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number
}

/** Default location: one ledger per user, shared by every project database on the machine. */
export function defaultLedgerPath(): string {
  return process.env.KALYTH_LEDGER ?? join(homedir(), '.kalyth', 'ledger.sqlite')
}

/**
 * Persistent spend ledger (ADR 0010). Without a cap the limit is zero. Reservations are made in
 * immediate transactions, so concurrent processes sharing the file cannot overspend together.
 */
export class BudgetLedger {
  readonly #db: Database.Database
  readonly #clock: () => string

  constructor(path: string, clock: () => string = () => new Date().toISOString()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new Database(path)
    if (path !== ':memory:') this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('busy_timeout = 5000')
    this.#db.exec(SCHEMA)
    this.#clock = clock
  }

  close(): void {
    this.#db.close()
  }

  setCap(capMicroUsd: number, note: string): void {
    if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 0) {
      throw new Error('the cap must be a non-negative whole number of micro-dollars')
    }
    if (note.trim().length === 0) throw new Error('a cap needs a note, such as its approval entry')
    this.#db
      .prepare('INSERT INTO ledger_caps (cap_micro_usd, note, set_at) VALUES (?, ?, ?)')
      .run(capMicroUsd, note.trim(), this.#clock())
  }

  status(): BudgetStatus {
    const cap = this.#db
      .prepare('SELECT cap_micro_usd, note, set_at FROM ledger_caps ORDER BY seq DESC LIMIT 1')
      .get() as { cap_micro_usd: number; note: string; set_at: string } | undefined
    const totals = this.#totals()
    const capMicroUsd = cap?.cap_micro_usd ?? 0
    const used = totals.spent + totals.reserved
    return {
      capMicroUsd,
      capNote: cap?.note ?? null,
      capSetAt: cap?.set_at ?? null,
      spentMicroUsd: totals.spent,
      reservedMicroUsd: totals.reserved,
      remainingMicroUsd: capMicroUsd - used,
      calls: totals.calls,
      thresholds: ADVISORY_THRESHOLDS.map((fraction) => ({
        fraction,
        reached: capMicroUsd > 0 && used >= capMicroUsd * fraction,
      })),
    }
  }

  reserve(call: {
    provider: string
    model: string
    projectId: string
    purpose: string
    microUsd: number
  }): Reservation {
    const run = this.#db.transaction((): Reservation => {
      const remaining = this.status().remainingMicroUsd
      if (call.microUsd > remaining) {
        return { ok: false, remainingMicroUsd: remaining, neededMicroUsd: call.microUsd }
      }
      const info = this.#db
        .prepare(
          `INSERT INTO ledger_calls (at, provider, model, project_id, purpose, status, reserved_micro_usd)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
        )
        .run(this.#clock(), call.provider, call.model, call.projectId, call.purpose, call.microUsd)
      return { ok: true, id: Number(info.lastInsertRowid) }
    })
    return run.immediate()
  }

  /** Records the actual cost. Without reported usage the caller passes the reservation. */
  settle(id: number, usage: Usage): void {
    this.#close(id, 'settled', usage)
  }

  /** The provider refused the request before doing work; nothing is charged. */
  release(id: number, latencyMs: number): void {
    this.#close(id, 'released', {
      costMicroUsd: 0,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
    })
  }

  /** The request may have been processed; the reservation stays charged. */
  markUnknown(id: number, latencyMs: number): void {
    this.#close(id, 'unknown_outcome', {
      costMicroUsd: 0,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
    })
  }

  consent(projectId: string, provider: string): Omit<ProviderConsent, 'required'> {
    const row = this.#db
      .prepare(
        `SELECT granted, principal_id, at FROM ledger_consent
         WHERE project_id = ? AND provider = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(projectId, provider) as { granted: number; principal_id: string; at: string } | undefined
    return row?.granted === 1
      ? { granted: true, grantedBy: row.principal_id, grantedAt: row.at }
      : { granted: false, grantedBy: null, grantedAt: null }
  }

  setConsent(projectId: string, provider: string, granted: boolean, principalId: string): void {
    this.#db
      .prepare(
        'INSERT INTO ledger_consent (project_id, provider, granted, principal_id, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(projectId, provider, granted ? 1 : 0, principalId, this.#clock())
  }

  #totals(): { spent: number; reserved: number; calls: number } {
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'settled' THEN cost_micro_usd ELSE 0 END), 0) AS spent,
           COALESCE(SUM(CASE WHEN status IN ('reserved', 'unknown_outcome')
             THEN reserved_micro_usd ELSE 0 END), 0) AS reserved,
           COUNT(*) AS calls
         FROM ledger_calls`,
      )
      .get() as { spent: number; reserved: number; calls: number }
    return row
  }

  #close(id: number, status: 'settled' | 'released' | 'unknown_outcome', usage: Usage): void {
    const info = this.#db
      .prepare(
        `UPDATE ledger_calls SET status = ?, cost_micro_usd = ?, input_tokens = ?, output_tokens = ?,
           latency_ms = ?, closed_at = ? WHERE id = ? AND status = 'reserved'`,
      )
      .run(
        status,
        usage.costMicroUsd,
        usage.inputTokens,
        usage.outputTokens,
        usage.latencyMs,
        this.#clock(),
        id,
      )
    if (info.changes !== 1) throw new Error(`ledger call ${id} is not open`)
  }
}
