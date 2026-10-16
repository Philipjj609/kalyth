import { z } from 'zod'
import { Stance } from './claims.ts'

/** Object types are namespaced by pack: "core.Decision", "software.Component". */
export const TypeName = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]*$/, 'expected a type name like pack.Type')
export const RelationTypeName = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*$/, 'expected a relation type name like dependsOn')

/** How a change at one endpoint may affect the other (impact traversal, ADR 0005). */
export const ImpactRule = z.enum(['none', 'sourceToTarget', 'targetToSource', 'both'])
export type ImpactRule = z.infer<typeof ImpactRule>

export const ObjectTypeDescriptor = z.object({
  type: TypeName,
  version: z.int().min(1),
  pack: z.string(),
  description: z.string(),
  /** JSON Schema of the attributes, generated from the runtime schema. */
  attributesSchema: z.record(z.string(), z.unknown()),
  /** Attributes that only a dedicated operation may change (for example decision status). */
  reservedAttributes: z.array(z.string()),
})
export type ObjectTypeDescriptor = z.infer<typeof ObjectTypeDescriptor>

export const RelationTypeDescriptor = z.object({
  type: RelationTypeName,
  version: z.int().min(1),
  pack: z.string(),
  description: z.string(),
  /** Allowed endpoint types; "*" allows any registered object type. */
  from: z.array(z.string()).min(1),
  to: z.array(z.string()).min(1),
  fromStance: Stance.optional(),
  acyclic: z.boolean(),
  symmetric: z.boolean(),
  temporal: z.boolean(),
  maxOutgoingPerSource: z.int().min(1).optional(),
  maxIncomingPerTarget: z.int().min(1).optional(),
  impact: ImpactRule,
})
export type RelationTypeDescriptor = z.infer<typeof RelationTypeDescriptor>
