import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Content-Security-Policy for the workbench UI. Scripts, styles, fonts and API calls are
 * same-origin only and there is no inline script, so injected markup cannot run code or exfiltrate
 * the session token. `data:` images cover small inline SVG icons in CSS.
 */
export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': UI_CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export interface WebUiOptions {
  /** Directory holding the built UI (apps/web/dist). */
  root: string
}

/**
 * Serves the built workbench UI at `/` with an SPA fallback: extensionless paths get index.html so
 * client-side URLs survive a reload. Paths under /api/ never fall back to the UI; unknown API paths
 * answer with the API error envelope. Access control (Host, Origin, token for /api/) stays in the
 * app's onRequest hook, which runs for these routes too.
 */
export function registerWebUi(app: FastifyInstance, options: WebUiOptions): void {
  const root = resolve(options.root)
  const indexFile = join(root, 'index.html')

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(req.url)
    if (path === undefined) return notFound(reply)
    const segments = path.split(/[/\\]/).filter(Boolean)
    // Dotfiles and traversal segments are never served, not even as the SPA fallback.
    if (segments.some((s) => s.startsWith('.'))) return notFound(reply)
    if (path === '/api' || path.startsWith('/api/')) {
      return reply.code(404).send({
        error: { code: 'not_found', message: `no API route ${path}`, issues: [] },
      })
    }
    const file = path.endsWith('/') ? undefined : await fileInside(root, segments)
    if (file) return sendFile(reply, file, path.startsWith('/assets/'))
    if (extname(path) !== '') return notFound(reply)
    if (!(await isFile(indexFile))) {
      return reply
        .code(404)
        .headers(SECURITY_HEADERS)
        .type('text/plain; charset=utf-8')
        .send('The Kalyth UI is not built. Run `pnpm build` and restart the server.\n')
    }
    return sendFile(reply, indexFile, false)
  }

  app.get('/', handler)
  app.get('/*', handler)
}

/** The decoded path without query string, or undefined when it cannot be decoded safely. */
function requestPath(url: string): string | undefined {
  const raw = url.split('?', 1)[0] ?? '/'
  try {
    const decoded = decodeURIComponent(raw)
    return decoded.includes('\0') ? undefined : decoded
  } catch {
    return undefined
  }
}

/** Resolves path segments to a regular file inside root, or undefined. */
async function fileInside(root: string, segments: string[]): Promise<string | undefined> {
  if (segments.length === 0) return undefined
  const full = resolve(root, ...segments)
  if (!full.startsWith(root + sep)) return undefined
  return (await isFile(full)) ? full : undefined
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function sendFile(reply: FastifyReply, file: string, immutable: boolean) {
  const body = await readFile(file)
  return reply
    .code(200)
    .headers(SECURITY_HEADERS)
    .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    .type(MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    .send(body)
}

function notFound(reply: FastifyReply) {
  return reply
    .code(404)
    .headers(SECURITY_HEADERS)
    .type('text/plain; charset=utf-8')
    .send('Not found\n')
}
