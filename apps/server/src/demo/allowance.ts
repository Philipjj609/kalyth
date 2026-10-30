import type { BudgetLedger } from '@kalyth/gateway'
import { utcDay } from './limits.ts'

export type Pool = 'public' | 'judges'

export interface AllowancePeriod {
  /** When the period starts, as an ISO instant in UTC. */
  from: string
  /** Allowance per UTC day, in micro-USD. */
  daily: Record<Pool, number>
}

export interface AllowanceSchedule {
  periods: readonly AllowancePeriod[]
  /** Hard total per pool over the whole demo, in micro-USD. */
  totals: Record<Pool, number>
}

/**
 * The approved allowance (ADR 0019, amendment 4; judges' pool raised on 30 October 2026). The
 * official Judging Period runs from 9 December 2026 at 09:00 PT to 23 December at 12:00 PT. The
 * public gets 0.07 USD a day before it and 0.15 USD a day during it; judges share 0.30 USD a day
 * from now until it ends, within 8.00 USD in total. Nothing is spent after it ends. The totals
 * bound everything each pool's ledger has ever spent: 12.49 USD for both.
 */
export const DEMO_ALLOWANCE: AllowanceSchedule = {
  periods: [
    { from: '2026-10-01T00:00:00Z', daily: { public: 70_000, judges: 300_000 } },
    { from: '2026-12-09T17:00:00Z', daily: { public: 150_000, judges: 300_000 } },
    { from: '2026-12-23T20:00:00Z', daily: { public: 0, judges: 0 } },
  ],
  totals: { public: 4_490_000, judges: 8_000_000 },
}

// Part of each day's cap note: a new schedule sets new caps on its first refresh, even on a day
// whose caps the previous schedule already set.
const NOTE = 'hosted demo daily allowance (ADR 0019, schedule 2)'

/**
 * Daily caps on top of the budget ledger, one ledger per pool. Once per UTC day (and when a new
 * period starts), each pool's cap becomes what it has used so far plus the day's allowance,
 * within its total. The ledger then refuses any call whose worst case does not fit, exactly as in
 * local mode, and unused allowance does not carry over. Caps are append-only, so the history of
 * every day's allowance stays in the ledger.
 */
export class DemoAllowance {
  readonly #ledgers: Record<Pool, BudgetLedger>
  readonly #schedule: AllowanceSchedule
  readonly #clock: () => Date

  constructor(options: {
    ledgers: Record<Pool, BudgetLedger>
    schedule?: AllowanceSchedule
    clock?: () => Date
  }) {
    this.#ledgers = options.ledgers
    this.#schedule = options.schedule ?? DEMO_ALLOWANCE
    this.#clock = options.clock ?? (() => new Date())
  }

  /** Sets today's caps if they are not set yet. Cheap; call it before any use of a pool. */
  refresh(): void {
    const now = this.#clock()
    const index = this.#periodIndex(now)
    const marker = `${NOTE}: ${utcDay(now)}, period ${index}`
    for (const pool of ['public', 'judges'] as const) {
      const ledger = this.#ledgers[pool]
      const status = ledger.status()
      if (status.capNote === marker) continue
      const used = status.spentMicroUsd + status.reservedMicroUsd
      const daily = index < 0 ? 0 : (this.#schedule.periods[index]?.daily[pool] ?? 0)
      ledger.setCap(Math.max(0, Math.min(used + daily, this.#schedule.totals[pool])), marker)
    }
  }

  /** What a pool can still spend today, in micro-USD. */
  remainingToday(pool: Pool): number {
    this.refresh()
    return Math.max(0, this.#ledgers[pool].status().remainingMicroUsd)
  }

  #periodIndex(now: Date): number {
    let index = -1
    this.#schedule.periods.forEach((p, i) => {
      if (Date.parse(p.from) <= now.getTime()) index = i
    })
    return index
  }
}
