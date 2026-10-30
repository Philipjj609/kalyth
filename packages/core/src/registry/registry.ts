import type { ObjectTypeDescriptor, RelationTypeDescriptor } from '@kalyth/contracts'
import { z } from 'zod'
import { knowledgePack, knowledgeRelations } from './knowledge.ts'
import { corePack, relationTypes, softwarePack } from './packs.ts'
import type { ObjectTypeDef, RelationTypeDef } from './types.ts'

export class TypeRegistry {
  readonly #objects = new Map<string, ObjectTypeDef>()
  readonly #relations = new Map<string, RelationTypeDef>()

  constructor(objectTypes: readonly ObjectTypeDef[], relations: readonly RelationTypeDef[]) {
    for (const def of objectTypes) {
      if (this.#objects.has(def.type)) throw new Error(`duplicate object type ${def.type}`)
      this.#objects.set(def.type, def)
    }
    for (const def of relations) {
      if (this.#relations.has(def.type)) throw new Error(`duplicate relation type ${def.type}`)
      for (const endpoint of [...def.from, ...def.to]) {
        if (endpoint !== '*' && !this.#objects.has(endpoint)) {
          throw new Error(`relation ${def.type} references unknown type ${endpoint}`)
        }
      }
      this.#relations.set(def.type, def)
    }
  }

  objectType(type: string): ObjectTypeDef | undefined {
    return this.#objects.get(type)
  }

  relationType(type: string): RelationTypeDef | undefined {
    return this.#relations.get(type)
  }

  allowsEndpoint(def: RelationTypeDef, side: 'from' | 'to', objectType: string): boolean {
    const allowed = side === 'from' ? def.from : def.to
    return allowed.includes('*') || allowed.includes(objectType)
  }

  describe(): { objectTypes: ObjectTypeDescriptor[]; relationTypes: RelationTypeDescriptor[] } {
    return {
      objectTypes: [...this.#objects.values()].map((def) => ({
        type: def.type,
        version: def.version,
        pack: def.pack,
        description: def.description,
        attributesSchema: z.toJSONSchema(def.attributes, { io: 'input' }) as Record<
          string,
          unknown
        >,
        reservedAttributes: Object.keys(def.reserved ?? {}),
      })),
      relationTypes: [...this.#relations.values()],
    }
  }
}

export const defaultRegistry = new TypeRegistry(
  [...corePack, ...softwarePack, ...knowledgePack],
  [...relationTypes, ...knowledgeRelations],
)
