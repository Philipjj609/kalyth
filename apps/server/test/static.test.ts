import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLocalOwner, KalythServices, SqliteStore } from '@kalyth/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHttpApp } from '../src/http/app.ts'
import { registerWebUi, UI_CONTENT_SECURITY_POLICY } from '../src/http/static.ts'

const TOKEN = 'static-test-token-0123456789'
const HOST = '127.0.0.1:4317'
const INDEX = '<!doctype html><html><head><title>Kalyth</title></head><body></body></html>'

let dist: string
let parent: string
let app: FastifyInstance

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'kalyth-static-'))
  dist = join(parent, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), INDEX)
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log("ui")')
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dist, '.env'), 'NOT_SERVED=1')
  writeFileSync(join(parent, 'outside.txt'), 'outside the web root')

  const services = new KalythServices({ store: new SqliteStore(':memory:') })
  const owner = ensureLocalOwner(services)
  app = buildHttpApp(services, { token: TOKEN, principalId: owner.id, allowedHosts: [HOST] })
  registerWebUi(app, { root: dist })
})

afterEach(async () => {
  await app.close()
  rmSync(parent, { recursive: true, force: true })
})

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } })

describe('workbench UI serving', () => {
  it('serves the shell at / without a token, with a strict CSP', async () => {
    const res = await get('/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toBe(INDEX)
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toBe(UI_CONTENT_SECURITY_POLICY)
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  it('serves hashed assets as immutable and falls back to the shell for app paths', async () => {
    const asset = await get('/assets/index-abc123.js')
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('text/javascript')
    expect(asset.headers['cache-control']).toContain('immutable')

    const deepLink = await get('/projects/graph?view=graph&sel=obj_1')
    expect(deepLink.statusCode).toBe(200)
    expect(deepLink.body).toBe(INDEX)

    expect((await get('/assets/missing.js')).statusCode).toBe(404)
    const head = await app.inject({ method: 'HEAD', url: '/', headers: { host: HOST } })
    expect(head.statusCode).toBe(200)
  })

  it('refuses traversal and dotfiles', async () => {
    for (const url of [
      '/../outside.txt',
      '/%2e%2e/outside.txt',
      '/assets/..%2f..%2foutside.txt',
      '/..%5coutside.txt',
      '/.env',
      '/%00',
    ]) {
      const res = await get(url)
      expect(res.body, url).not.toContain('outside the web root')
      expect(res.body, url).not.toContain('NOT_SERVED')
      expect([400, 404], url).toContain(res.statusCode)
    }
  })

  it('still requires the token for the API, except health', async () => {
    const projects = await get('/api/v1/projects')
    expect(projects.statusCode).toBe(401)
    expect(projects.json().error.code).toBe('unauthenticated')

    const encoded = await get('/%61pi/v1/projects')
    expect(encoded.statusCode).not.toBe(200)

    const unknown = await get('/api/v1/nope')
    expect(unknown.statusCode).toBe(401)
    const unknownAuthed = await get('/api/v1/nope', { authorization: `Bearer ${TOKEN}` })
    expect(unknownAuthed.statusCode).toBe(404)
    expect(unknownAuthed.json().error.code).toBe('not_found')

    expect((await get('/api')).statusCode).toBe(401)
    expect((await get('/api/v1/health')).statusCode).toBe(200)
    const authed = await get('/api/v1/projects', { authorization: `Bearer ${TOKEN}` })
    expect(authed.statusCode).toBe(200)
    expect(authed.json()).toEqual({ projects: [] })
  })

  it('applies the Host and Origin checks to UI requests too', async () => {
    const rebound = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'attacker.example:4317' },
    })
    expect(rebound.statusCode).toBe(403)
    const crossOrigin = await get('/', { origin: 'https://attacker.example' })
    expect(crossOrigin.statusCode).toBe(403)
    const sameOrigin = await get('/', { origin: `http://${HOST}` })
    expect(sameOrigin.statusCode).toBe(200)
  })
})

describe('workbench UI not built', () => {
  it('explains how to build instead of failing silently', async () => {
    rmSync(join(dist, 'index.html'))
    const res = await get('/')
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('pnpm build')
  })
})
