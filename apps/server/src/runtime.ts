import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { KalythServices, SqliteStore } from '@kalyth/core'

/** Opens the local store. KALYTH_DB overrides the default .kalyth/kalyth.db in the working directory. */
export function openLocalServices(): KalythServices {
  const path = resolve(process.env.KALYTH_DB ?? join(process.cwd(), '.kalyth', 'kalyth.db'))
  mkdirSync(dirname(path), { recursive: true })
  return new KalythServices({ store: new SqliteStore(path) })
}
