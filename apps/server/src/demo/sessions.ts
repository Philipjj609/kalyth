import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { utcDay } from './limits.ts'

/** What a sandbox needs open: released when the sandbox is evicted or closes for being idle. */
export interface OpenSandbox {
  close(): void
}

export interface DemoSession<T extends OpenSandbox> {
  /** SHA-256 of the cookie value; the value itself is never stored. */
  readonly key: string
  readonly file: string
  readonly createdAt: number
  lastSeen: number
  judge: boolean
  /** Live (not recorded) Navigator runs on one UTC day. */
  live: { day: string; runs: number }
  /** A Navigator run is in progress in this sandbox. */
  running: boolean
  open: T | undefined
  /** What the sandbox's files held when last measured, in bytes. */
  bytes: number
}

export interface SessionOptions<T extends OpenSandbox> {
  /** The template database every sandbox starts as a copy of. */
  template: string
  /** Where sandbox files live; nothing else may be kept there. */
  dir: string
  /** Opens a sandbox file. */
  openSandbox(file: string): T
  maxSessions?: number
  /** Sandboxes open at once; the least recently used is closed (not deleted) past this. */
  maxOpen?: number
  idleMs?: number
  /** The most one sandbox's files may hold; a sandbox this large takes no more changes. */
  maxSandboxBytes?: number
  /** The most all sandboxes together may hold; past it, others are removed to make room. */
  maxTotalBytes?: number
  clock?: () => number
}

/** Whether a sandbox can take a change, or why not. */
export type ChangeRoom = 'ok' | 'sandbox_full' | 'no_room'

/** No session can start: every sandbox is busy, or there is no room for another copy. */
export class DemoFullError extends Error {}

/** Room one change may need, beyond what its sandbox already holds. */
const CHANGE_BYTES = 1_000_000
/** Sandbox files: 16 random bytes in hex, with SQLite's write-ahead log and its index. */
const SANDBOX_FILE = /^[0-9a-f]{32}\.db(-wal|-shm)?$/

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Anonymous visitor sessions, each with its own copy of the template project (ADR 0019). The
 * cookie holds 32 random bytes; only their hash is kept. Sessions expire after a day without use,
 * and past the limit the least recently used one is removed, sandbox and all.
 *
 * Sandboxes are bounded in size, one by one and all together. When all of them together need
 * room, sandboxes more than half full go first, largest first, then the least recently used, so a
 * visitor who fills copies cannot push out everyone else's.
 */
export class DemoSessions<T extends OpenSandbox> {
  readonly #options: Required<Omit<SessionOptions<T>, 'openSandbox'>> &
    Pick<SessionOptions<T>, 'openSandbox'>
  readonly #sessions = new Map<string, DemoSession<T>>()
  readonly #templateBytes: number

  constructor(options: SessionOptions<T>) {
    this.#options = {
      maxSessions: 200,
      maxOpen: 32,
      idleMs: 24 * 60 * 60 * 1000,
      maxSandboxBytes: 24_000_000,
      maxTotalBytes: 640_000_000,
      clock: Date.now,
      ...options,
    }
    mkdirSync(this.#options.dir, { recursive: true })
    // Sessions live in memory, so sandbox files an earlier process left behind belong to no one.
    for (const name of readdirSync(this.#options.dir)) {
      if (SANDBOX_FILE.test(name)) {
        rmSync(join(this.#options.dir, name), { force: true, maxRetries: 3 })
      }
    }
    this.#templateBytes = statSync(this.#options.template).size
  }

  get size(): number {
    return this.#sessions.size
  }

  /** Starts a session and its sandbox. Returns the cookie value, which is shown only here. */
  create(): { cookie: string; session: DemoSession<T> } {
    this.sweep()
    while (this.#sessions.size >= this.#options.maxSessions) {
      const oldest = [...this.#sessions.values()]
        .filter((s) => !s.running)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (!oldest) throw new DemoFullError('every sandbox is busy')
      this.remove(oldest)
    }
    if (!this.#makeRoom(this.#templateBytes)) {
      throw new DemoFullError('there is no room for another sandbox')
    }
    const cookie = randomBytes(32).toString('base64url')
    const key = hash(cookie)
    const file = join(this.#options.dir, `${randomBytes(16).toString('hex')}.db`)
    copyFileSync(this.#options.template, file)
    const now = this.#options.clock()
    const session: DemoSession<T> = {
      key,
      file,
      createdAt: now,
      lastSeen: now,
      judge: false,
      live: { day: '', runs: 0 },
      running: false,
      open: undefined,
      bytes: this.#templateBytes,
    }
    this.#sessions.set(key, session)
    return { cookie, session }
  }

  /** The session a cookie value belongs to, if it is current. */
  find(cookie: string | undefined): DemoSession<T> | undefined {
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return undefined
    const session = this.#sessions.get(hash(cookie))
    if (!session) return undefined
    if (this.#options.clock() - session.lastSeen > this.#options.idleMs && !session.running) {
      this.remove(session)
      return undefined
    }
    session.lastSeen = this.#options.clock()
    return session
  }

  /** The session's sandbox, opened if needed; past the limit, the least recently used closes. */
  sandbox(session: DemoSession<T>): T {
    if (session.open) return session.open
    // A request can outlive its session's removal; opening the file again would recreate it.
    if (this.#sessions.get(session.key) !== session) {
      throw new Error('this copy of the demo was removed; reload the page to start a new one')
    }
    const open = [...this.#sessions.values()].filter((s) => s.open && s !== session)
    if (open.length >= this.#options.maxOpen) {
      const idle = open.filter((s) => !s.running).sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (idle) this.#close(idle)
    }
    session.open = this.#options.openSandbox(session.file)
    return session.open
  }

  /**
   * Whether the session's sandbox can take a change: it is under its own limit, and all
   * sandboxes together have room for one more change, once others are removed if need be.
   */
  roomForChange(session: DemoSession<T>): ChangeRoom {
    if (this.#measure(session) >= this.#options.maxSandboxBytes) return 'sandbox_full'
    return this.#makeRoom(CHANGE_BYTES, session) ? 'ok' : 'no_room'
  }

  /** Live runs the session has made today. */
  liveRunsToday(session: DemoSession<T>): number {
    const today = utcDay(new Date(this.#options.clock()))
    return session.live.day === today ? session.live.runs : 0
  }

  countLiveRun(session: DemoSession<T>): void {
    const today = utcDay(new Date(this.#options.clock()))
    session.live = { day: today, runs: (session.live.day === today ? session.live.runs : 0) + 1 }
  }

  /** Removes sessions idle for longer than the limit, with their sandboxes. */
  sweep(): void {
    const now = this.#options.clock()
    for (const session of this.#sessions.values()) {
      if (now - session.lastSeen > this.#options.idleMs && !session.running) this.remove(session)
    }
  }

  remove(session: DemoSession<T>): void {
    this.#close(session)
    this.#sessions.delete(session.key)
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${session.file}${suffix}`, { force: true, maxRetries: 3 })
    }
  }

  /** Closes every sandbox and deletes every sandbox file. */
  closeAll(): void {
    for (const session of [...this.#sessions.values()]) this.remove(session)
  }

  /**
   * Removes sessions other than `keep` until `bytes` more fit within the total: first sandboxes
   * more than half full, largest first, then the least recently used. None with a run in
   * progress. False when that cannot make enough room.
   */
  #makeRoom(bytes: number, keep?: DemoSession<T>): boolean {
    let total = 0
    for (const session of this.#sessions.values()) total += this.#measure(session)
    while (total + bytes > this.#options.maxTotalBytes) {
      const others = [...this.#sessions.values()].filter((s) => !s.running && s !== keep)
      const victim =
        others
          .filter((s) => s.bytes > this.#options.maxSandboxBytes / 2)
          .sort((a, b) => b.bytes - a.bytes)[0] ?? others.sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (!victim) return false
      total -= victim.bytes
      this.remove(victim)
    }
    return true
  }

  /** What the sandbox's files hold now: the database, its write-ahead log and the log's index. */
  #measure(session: DemoSession<T>): number {
    session.bytes = ['', '-wal', '-shm'].reduce(
      (n, suffix) =>
        n + (statSync(`${session.file}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
      0,
    )
    return session.bytes
  }

  #close(session: DemoSession<T>): void {
    session.open?.close()
    session.open = undefined
  }
}
