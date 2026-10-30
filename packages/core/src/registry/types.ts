import type { JsonValue, RelationTypeDescriptor } from '@kalyth/contracts'
import type { z } from 'zod'

/** Runtime definition of an object type. The attribute schema is strict: unknown keys are invalid. */
export interface ObjectTypeDef {
  readonly type: string
  readonly version: number
  readonly pack: string
  readonly description: string
  readonly attributes: z.ZodType<Record<string, unknown>>
  /** Attributes only a dedicated operation may change, with the value they must start with. */
  readonly reserved?: Readonly<Record<string, JsonValue>>
  /** Values a reserved attribute may start with instead, when there is more than one. */
  readonly initial?: Readonly<Record<string, readonly JsonValue[]>>
  /** The operation that changes the reserved attributes, named in refusals. */
  readonly reservedBy?: string
  /** Top-level attributes holding an object id, which a local ref may name when created. */
  readonly references?: readonly string[]
}

export type RelationTypeDef = RelationTypeDescriptor
