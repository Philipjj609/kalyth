/**
 * Session token handling. The server prints http://127.0.0.1:<port>/#token=<token>; the fragment
 * never reaches the server or a Referer header. On load the UI moves the token into
 * sessionStorage (scoped to this tab) and removes it from the address bar and history.
 */
export const TOKEN_STORAGE_KEY = 'kalyth.sessionToken'

type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface TokenEnvironment {
  location: { hash: string; pathname: string; search: string }
  storage: TokenStorage | null
  /** Replaces the current history entry, e.g. history.replaceState(null, '', url). */
  replaceUrl: (url: string) => void
}

const plausible = (token: string | null): token is string =>
  token !== null && /^[A-Za-z0-9._~+/=-]{8,512}$/.test(token)

export function bootstrapToken(env: TokenEnvironment): string | null {
  const hash = env.location.hash.replace(/^#/, '')
  const params = new URLSearchParams(hash)
  if (params.has('token')) {
    const fromUrl = params.get('token')
    params.delete('token')
    const rest = params.toString()
    env.replaceUrl(`${env.location.pathname}${env.location.search}${rest ? `#${rest}` : ''}`)
    if (plausible(fromUrl)) {
      safely(() => env.storage?.setItem(TOKEN_STORAGE_KEY, fromUrl))
      return fromUrl
    }
  }
  const stored = safely(() => env.storage?.getItem(TOKEN_STORAGE_KEY) ?? null) ?? null
  return plausible(stored) ? stored : null
}

export function forgetToken(storage: TokenStorage | null): void {
  safely(() => storage?.removeItem(TOKEN_STORAGE_KEY))
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
