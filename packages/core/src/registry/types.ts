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
}

export type RelationTypeDef = RelationTypeDescriptor
