import type { Basis, Claim, ObjectVersion, RelationVersion } from '@kalyth/contracts'

/** Test factories for revisioned records, with valid-looking ids. */
let counter = 0
const nextHex = () => (++counter).toString(16).padStart(32, '0')

export function resetIds() {
  counter = 0
}

export function claim(basis: Basis = 'observed', extra: Partial<Claim> = {}): Claim {
  return { basis, supports: [], contradictedBy: [], derivedFrom: [], ...extra }
}

export function obj(
  type: string,
  attributes: Record<string, string> = {},
  extra: Partial<ObjectVersion> = {},
): ObjectVersion {
  return {
    id: `obj_${nextHex()}`,
    type,
    typeVersion: 1,
    stance: 'asIs',
    lifecycle: 'active',
    attributes,
    claim: claim(),
    revision: 1,
    retiredReason: null,
    ...extra,
  }
}

export function rel(
  type: string,
  from: ObjectVersion,
  to: ObjectVersion,
  basis: Basis = 'observed',
  extra: Partial<RelationVersion> = {},
): RelationVersion {
  return {
    id: `rel_${nextHex()}`,
    type,
    typeVersion: 1,
    from: from.id,
    to: to.id,
    stance: 'asIs',
    lifecycle: 'active',
    properties: {},
    claim: claim(basis),
    revision: 1,
    retiredReason: null,
    ...extra,
  }
}

/**
 * A synthetic model at the demo repository's scale (~250 objects, ~500 relations): one system,
 * two containers with 160 modules and 30 endpoints, data entities and 45 libraries.
 */
export function demoScaleModel() {
  const objects: ObjectVersion[] = []
  const relations: RelationVersion[] = []
  const add = (o: ObjectVersion) => {
    objects.push(o)
    return o
  }
  const system = add(obj('software.System', { name: 'demo' }))
  const backend = add(obj('software.Container', { name: 'backend' }))
  const frontend = add(obj('software.Container', { name: 'frontend' }))
  relations.push(rel('contains', system, backend), rel('contains', system, frontend))

  const backendModules = Array.from({ length: 100 }, (_, i) =>
    add(obj('software.Module', { path: `backend/app/m${i}.py` })),
  )
  const frontendModules = Array.from({ length: 60 }, (_, i) =>
    add(obj('software.Module', { path: `frontend/src/m${i}.tsx` })),
  )
  for (const m of backendModules) relations.push(rel('contains', backend, m))
  for (const m of frontendModules) relations.push(rel('contains', frontend, m))
  for (const [i, m] of backendModules.entries()) {
    const a = backendModules[(i * 7 + 3) % 100] as ObjectVersion
    if (a !== m) relations.push(rel('dependsOn', m, a))
    const b = backendModules[(i * 13 + 5) % 100] as ObjectVersion
    if (b !== m && b !== a)
      relations.push(rel('dependsOn', m, b, i % 5 === 0 ? 'inferred' : 'observed'))
  }
  for (const [i, m] of frontendModules.entries()) {
    const a = frontendModules[(i * 11 + 1) % 60] as ObjectVersion
    if (a !== m) relations.push(rel('dependsOn', m, a))
  }
  const endpoints = Array.from({ length: 30 }, (_, i) =>
    add(obj('software.Endpoint', { method: 'GET', path: `/api/r${i}` })),
  )
  for (const [i, e] of endpoints.entries()) {
    relations.push(rel('contains', backend, e))
    relations.push(rel('exposes', backendModules[i] as ObjectVersion, e))
  }
  const entities = Array.from({ length: 8 }, (_, i) =>
    add(obj('software.DataEntity', { name: `Entity${i}` })),
  )
  for (const [i, e] of endpoints.entries()) {
    relations.push(rel(i % 2 ? 'reads' : 'writes', e, entities[i % 8] as ObjectVersion, 'inferred'))
  }
  const libraries = Array.from({ length: 45 }, (_, i) =>
    add(obj('software.Library', { name: `lib${i}` })),
  )
  for (const [i, l] of libraries.entries()) {
    relations.push(rel('dependsOn', i < 25 ? backend : frontend, l))
    relations.push(
      rel('dependsOn', (i < 25 ? backendModules : frontendModules)[i] as ObjectVersion, l),
    )
  }
  const decision = add(obj('core.Decision', { title: 'Which auth?' }, { stance: 'toBe' }))
  for (const t of ['A', 'B']) {
    const alt = add(obj('core.Alternative', { title: t }, { stance: 'toBe' }))
    relations.push(rel('alternativeOf', alt, decision, 'stated'))
  }
  relations.push(rel('decides', decision, frontend, 'stated'))
  return { objects, relations, system, backend, frontend, backendModules, libraries, entities }
}
