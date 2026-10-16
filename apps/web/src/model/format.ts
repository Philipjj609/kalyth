/**
 * Display formatting. Ids are UUIDv7 bodies whose leading digits are a timestamp, so records made
 * together share a prefix; the short form keeps the type prefix and the distinctive tail.
 */
export function shortId(id: string): string {
  const underscore = id.indexOf('_')
  if (underscore < 0 || id.length <= underscore + 8) return id
  return `${id.slice(0, underscore)}…${id.slice(-6)}`
}

/** First 8 hex digits of a git sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

/** "software.Module" -> { pack: "software", name: "Module" }; tolerates unprefixed names. */
export function typeParts(type: string): { pack: string; name: string } {
  const dot = type.indexOf('.')
  return dot < 0
    ? { pack: '', name: type }
    : { pack: type.slice(0, dot), name: type.slice(dot + 1) }
}

/** "DataEntity" -> "Data entity", "dependsOn" -> "Depends on". */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en')} ${count === 1 ? singular : pluralForm}`
}

/** Plural label for an object type name, e.g. "Library" -> "libraries". */
export function typePlural(type: string, count: number): string {
  const word = humanize(typeParts(type).name).toLowerCase()
  const pluralWord = word.endsWith('y')
    ? `${word.slice(0, -1)}ies`
    : word.endsWith('s')
      ? `${word}es`
      : `${word}s`
  return `${count.toLocaleString('en')} ${count === 1 ? word : pluralWord}`
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  if (Number.isNaN(seconds)) return iso
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return Math.abs(seconds) < 10 ? 'just now' : RELATIVE.format(seconds, 'second')
}

const ABSOLUTE = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function absoluteTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : ABSOLUTE.format(date)
}
