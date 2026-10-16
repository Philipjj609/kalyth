import type {
  EvidenceRecord,
  JsonValue,
  ObjectVersion,
  RelationVersion,
  ResolvedWrite,
} from '@kalyth/contracts'

export interface ObjectFilter {
  types?: readonly string[] | undefined
  attributeEquals?: Readonly<Record<string, JsonValue>> | undefined
}

export interface RelationFilter {
  types?: readonly string[] | undefined
  from?: string | undefined
  to?: string | undefined
}

/**
 * Read access to the kernel state at one revision. Get-by-id returns the version current at that
 * revision whatever its lifecycle; the list methods return active records only.
 */
export interface StateView {
  readonly revision: number
  getObject(id: string): ObjectVersion | undefined
  getRelation(id: string): RelationVersion | undefined
  getEvidence(id: string): EvidenceRecord | undefined
  listObjects(filter: ObjectFilter): ObjectVersion[]
  listRelations(filter: RelationFilter): RelationVersion[]
}

export function matchesObject(o: ObjectVersion, f: ObjectFilter): boolean {
  if (o.lifecycle !== 'active') return false
  if (f.types && !f.types.includes(o.type)) return false
  if (f.attributeEquals) {
    for (const [key, value] of Object.entries(f.attributeEquals)) {
      if (JSON.stringify(o.attributes[key] ?? null) !== JSON.stringify(value)) return false
    }
  }
  return true
}

export function matchesRelation(r: RelationVersion, f: RelationFilter): boolean {
  if (r.lifecycle !== 'active') return false
  if (f.types && !f.types.includes(r.type)) return false
  if (f.from !== undefined && r.from !== f.from) return false
  if (f.to !== undefined && r.to !== f.to) return false
  return true
}

/** A base view plus the writes of a proposal being applied. Later writes shadow earlier ones. */
export class OverlayState implements StateView {
  readonly #objects = new Map<string, ObjectVersion>()
  readonly #relations = new Map<string, RelationVersion>()
  readonly #evidence = new Map<string, EvidenceRecord>()
  private readonly base: StateView
  readonly revision: number

  constructor(base: StateView, revision: number) {
    this.base = base
    this.revision = revision
  }

  apply(write: ResolvedWrite): void {
    if (write.kind === 'object') this.#objects.set(write.version.id, write.version)
    else if (write.kind === 'relation') this.#relations.set(write.version.id, write.version)
    else this.#evidence.set(write.record.id, write.record)
  }

  getObject(id: string): ObjectVersion | undefined {
    return this.#objects.get(id) ?? this.base.getObject(id)
  }

  getRelation(id: string): RelationVersion | undefined {
    return this.#relations.get(id) ?? this.base.getRelation(id)
  }

  getEvidence(id: string): EvidenceRecord | undefined {
    return this.#evidence.get(id) ?? this.base.getEvidence(id)
  }

  listObjects(filter: ObjectFilter): ObjectVersion[] {
    const fromBase = this.base.listObjects(filter).filter((o) => !this.#objects.has(o.id))
    const fromOverlay = [...this.#objects.values()].filter((o) => matchesObject(o, filter))
    return [...fromBase, ...fromOverlay]
  }

  listRelations(filter: RelationFilter): RelationVersion[] {
    const fromBase = this.base.listRelations(filter).filter((r) => !this.#relations.has(r.id))
    const fromOverlay = [...this.#relations.values()].filter((r) => matchesRelation(r, filter))
    return [...fromBase, ...fromOverlay]
  }
}
