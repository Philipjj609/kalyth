import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureLocalOwner, importProjectExport, KalythServices, SqliteStore } from '@kalyth/core'

/**
 * A change request or summary offered as a button in the demo. Its input is fixed, with the
 * template's ids, so in an unchanged sandbox it is the same request that was recorded.
 */
export interface DemoPreset {
  id: string
  label: string
  input:
    | { kind: 'alternatives'; projectId: string; request: string; focus: string[] }
    | { kind: 'summarize'; projectId: string; elementId: string }
  /** A recording of this preset exists, so it runs at no cost. */
  recorded: boolean
}

type ByName = readonly [type: string, name: string]

/** The presets (ADR 0019). None of them is one of the evaluation's scenarios (docs/evaluation). */
const PRESETS: readonly (
  | { id: string; label: string; kind: 'alternatives'; request: string; focus: ByName[] }
  | { id: string; label: string; kind: 'summarize'; element: ByName }
)[] = [
  {
    id: 'multi-tenancy',
    label: 'Add multi-tenancy',
    kind: 'alternatives',
    request: 'Add multi-tenancy: every user and item belongs to an organisation.',
    focus: [
      ['software.DataEntity', 'User'],
      ['software.DataEntity', 'Item'],
    ],
  },
  {
    id: 'soft-delete',
    label: 'Soft-delete and restore items',
    kind: 'alternatives',
    request: 'Let users delete items softly and restore them within 30 days.',
    focus: [['software.DataEntity', 'Item']],
  },
  {
    id: 'audit-log',
    label: 'Audit log of changes',
    kind: 'alternatives',
    request: 'Keep an audit log of who created, changed or deleted each user and item, and when.',
    focus: [
      ['software.DataEntity', 'User'],
      ['software.DataEntity', 'Item'],
    ],
  },
  {
    id: 'summary-backend',
    label: 'Summarise the backend',
    kind: 'summarize',
    element: ['software.Container', 'backend'],
  },
]

export interface DemoTemplate {
  /** The template database every sandbox copies. */
  file: string
  projectId: string
  /** The person every visitor acts as, in their own copy. */
  ownerId: string
  presets: DemoPreset[]
}

/**
 * Builds the template database from the committed export (deploy/demo/template.json). Import keeps
 * the exported ids, and prompts include ids, so recordings made against this template keep
 * matching in every sandbox copied from it. A fresh analysis would get new ids and match none.
 */
export function buildTemplate(options: {
  exportFile: string
  dir: string
  /** Ids of the presets that have recordings (deploy/demo/recordings/presets.json). */
  recordedPresets?: ReadonlySet<string>
}): DemoTemplate {
  const file = join(options.dir, 'template.db')
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
  const store = new SqliteStore(file)
  try {
    const imported = importProjectExport(
      store,
      JSON.parse(readFileSync(options.exportFile, 'utf8')),
    )
    if (!imported.ok) {
      throw new Error(`the demo template does not import: ${imported.error.message}`)
    }
    const services = new KalythServices({ store })
    const owner = ensureLocalOwner(services)
    const caller = { principalId: owner.id, origin: 'human' as const }
    const projectId = imported.value.projectId
    const objects = services.queryObjects(caller, { projectId, limit: 1000 })
    if (!objects.ok) throw new Error(objects.error.message)
    const idOf = ([type, name]: ByName) => {
      const found = objects.value.objects.find((o) => o.type === type && o.attributes.name === name)
      if (!found) throw new Error(`the demo template has no ${type} named ${name}`)
      return found.id
    }
    const recorded = options.recordedPresets ?? new Set<string>()
    const presets: DemoPreset[] = PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      input:
        p.kind === 'alternatives'
          ? { kind: 'alternatives', projectId, request: p.request, focus: p.focus.map(idOf) }
          : { kind: 'summarize', projectId, elementId: idOf(p.element) },
      recorded: recorded.has(p.id),
    }))
    store.db.pragma('wal_checkpoint(TRUNCATE)')
    return { file, projectId, ownerId: owner.id, presets }
  } finally {
    store.close()
  }
}

/** Preset ids listed in a recordings directory's manifest, written by the recording session. */
export function recordedPresetIds(recordingsDir: string): Set<string> {
  const manifest = join(recordingsDir, 'presets.json')
  if (!existsSync(manifest)) return new Set()
  const entries = JSON.parse(readFileSync(manifest, 'utf8')) as { id: string }[]
  return new Set(entries.map((e) => e.id))
}
