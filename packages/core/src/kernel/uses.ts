import type { Issue, ObjectVersion, ProjectKind } from '@kalyth/contracts'
import type { StateView } from './state.ts'

/** What apply needs to know about the libraries a project may use, from outside its own state. */
export type LibraryLookup = (id: string) => { kind: ProjectKind; headRevision: number } | undefined

export interface PinRules {
  /** The project written to, which never uses itself. */
  projectId?: string
  libraries?: LibraryLookup
  /** Whether the project's embedded copy of a pinned version verifies against its hash. */
  pinVerified?: (versionSha256: string) => boolean
}

const usesOf = (state: StateView, library: string) =>
  state.listObjects({ types: ['core.LibraryUse'], attributeEquals: { library } })

/**
 * Rules on pins and LibraryUse, checked on the state the whole proposal produces (ADR 0027 §3,
 * §4, ADR 0030 §3, §4): a pin is resolved and embedded, its copy verifies at the head, and its
 * revision is no later than its project's LibraryUse (I4). A LibraryUse names a present library,
 * other than its own project, at an existing revision; there is one per library, it never changes
 * library, and it never moves back, so no pin can become later than its use.
 */
export function checkPinsAndUses(
  overlay: StateView,
  before: StateView,
  written: ReadonlyMap<string, number>,
  rules: PinRules,
): Issue[] {
  const issues: Issue[] = []
  const add = (id: string, code: string, message: string) => {
    const op = written.get(id)
    issues.push(op === undefined ? { code, message } : { code, message, op })
  }
  for (const id of written.keys()) {
    const evidence = overlay.getEvidence(id)
    if (evidence?.source.kind === 'knowledge') {
      const pin = evidence.source
      if (!pin.versionSha256 || pin.versionHash !== 'v1') {
        add(id, 'pin.unresolved', 'a pin is resolved and hashed by the kernel when it is proposed')
        continue
      }
      if (evidence.excerpt)
        add(id, 'pin.excerpt_not_allowed', 'a pin embeds the pinned version, not an excerpt')
      if (rules.pinVerified && !rules.pinVerified(pin.versionSha256))
        add(
          id,
          'pin.hash_mismatch',
          `the embedded copy of ${pin.id} does not verify (ADR 0027 §5a)`,
        )
      const [use, ...more] = usesOf(overlay, pin.library)
      if (!use || more.length > 0)
        add(id, 'pin.no_library_use', `the project declares no single LibraryUse of ${pin.library}`)
      else if (pin.revision > Number(use.attributes.revision))
        add(
          id,
          'pin.after_library_use',
          `the pin is at revision ${pin.revision}, after the LibraryUse's ${use.attributes.revision} (ADR 0027 I4)`,
        )
      continue
    }
    const object = overlay.getObject(id)
    if (object?.type === 'core.LibraryUse' && object.lifecycle === 'active')
      checkUse(object, before.getObject(id), overlay, rules, (code, message) =>
        add(id, code, message),
      )
  }
  return issues
}

function checkUse(
  use: ObjectVersion,
  previous: ObjectVersion | undefined,
  overlay: StateView,
  rules: PinRules,
  add: (code: string, message: string) => void,
): void {
  const library = String(use.attributes.library)
  const revision = Number(use.attributes.revision)
  if (library === rules.projectId) add('library_use.self', 'a project does not use itself')
  if (rules.libraries) {
    const found = rules.libraries(library)
    if (!found) add('library.not_present', `library ${library} is not present in this store`)
    else if (found.kind !== 'library')
      add('library_use.not_a_library', `${library} is not a library`)
    else if (revision > found.headRevision)
      add('library_use.revision_ahead', `${library} is at revision ${found.headRevision}`)
  }
  if (usesOf(overlay, library).length > 1)
    add('library_use.duplicate', `the project already uses ${library}`)
  if (previous?.type === 'core.LibraryUse') {
    if (previous.attributes.library !== library)
      add('library_use.library_fixed', 'a LibraryUse keeps its library; retire it and add another')
    if (revision < Number(previous.attributes.revision))
      add('library_use.backwards', 'a LibraryUse never moves to an earlier revision (ADR 0027 I4)')
  }
}
