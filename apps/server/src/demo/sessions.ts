import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
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
}

export interface SessionOptions<T extends OpenSandbox> {
  /** The template database every sandbox starts as a copy of. */
  template: string
  /** Where sandbox files live; ephemeral in the hosted demo. */
  dir: string
  /** Opens a sandbox file. */
  openSandbox(file: string): T
  maxSessions?: number
  /** Sandboxes open at once; the least recently used is closed (not deleted) past this. */
  maxOpen?: number
  idleMs?: number
  clock?: () => number
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Anonymous visitor sessions, each with its own copy of the template project (ADR 0019). The
 * cookie holds 32 random bytes; only their hash is kept. Sessions expire after a day without use,
 * and past the limit the least recently used one is removed, sandbox and all.
 */
export class DemoSessions<T extends OpenSandbox> {
  readonly #options: Required<Omit<SessionOptions<T>, 'openSandbox'>> &
    Pick<SessionOptions<T>, 'openSandbox'>
  readonly #sessions = new Map<string, DemoSession<T>>()

  constructor(options: SessionOptions<T>) {
    this.#options = {
      maxSessions: 200,
      maxOpen: 32,
      idleMs: 24 * 60 * 60 * 1000,
      clock: Date.now,
      ...options,
    }
    mkdirSync(this.#options.dir, { recursive: true })
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
      if (!oldest) throw new Error('every sandbox is busy')
      this.remove(oldest)
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
    const open = [...this.#sessions.values()].filter((s) => s.open && s !== session)
    if (open.length >= this.#options.maxOpen) {
      const idle = open.filter((s) => !s.running).sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (idle) this.#close(idle)
    }
    session.open = this.#options.openSandbox(session.file)
    return session.open
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

  #close(session: DemoSession<T>): void {
    session.open?.close()
    session.open = undefined
  }
}
