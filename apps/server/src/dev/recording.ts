import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { importProjectExport, SqliteStore } from '@kalyth/core'
import { cloneOrFetch } from '../cli/clone.ts'

// Prepares the demo video's agent hand-off (docs/demo/recording.md, KAL-20261023-045): a
// disposable folder with its own Kalyth database (the demo template, so the recorded Nemotron run
// replays), a clone of the template with no remote, a dedicated worktree and branch for the agent,
// and Claude Code settings that allow only what the task needs. Nothing in it is private, and its
// paths hold no user name.
//
//   pnpm demo:recording setup [--dir C:/kalyth-recording] [--force]
//   pnpm demo:recording connect [--dir ...] [--url http://127.0.0.1:4317/mcp]   (reads the token)
//   pnpm demo:recording teardown [--dir ...]
//
// The agent token is typed or piped in, never passed as an argument, and is written only to the
// MCP config outside the worktree, where the agent's file tools cannot read it.

const DEMO_REPO = 'https://github.com/fastapi/full-stack-fastapi-template'
const DEMO_START = '0.12.0'
const AGENT_BRANCH = 'agent/multi-tenancy'
const TOKEN = /^kalyth_at_[A-Za-z0-9_-]{43}$/

/**
 * What Claude Code may do in the recording, and what it may not, even read-only. File tools are
 * not allowed by name: an unscoped "Read" would let the agent read outside the worktree, the MCP
 * config with the token included. Inside the worktree, reading needs no rule and edits are
 * accepted; anything else asks the person.
 */
const CLAUDE_SETTINGS = {
  permissions: {
    defaultMode: 'acceptEdits',
    allow: ['mcp__kalyth', 'Bash(git:*)', 'Bash(python -m py_compile:*)'],
    // The token's file and these settings, by path relative to this settings file; then commands
    // that could show the machine, the environment or another project on camera, or reach the
    // network. Deny rules win over allow rules and over read-only defaults.
    deny: [
      'Read(/mcp.json)',
      'Edit(/mcp.json)',
      'Read(/claude-settings.json)',
      'Edit(/claude-settings.json)',
      'Bash(git push:*)',
      'Bash(git remote:*)',
      'Bash(git config:*)',
      'Bash(docker:*)',
      'Bash(env:*)',
      'Bash(printenv:*)',
      'Bash(set:*)',
      'Bash(ps:*)',
      'Bash(tasklist:*)',
      'Bash(whoami:*)',
      'Bash(curl:*)',
      'Bash(wget:*)',
      'Bash(ssh:*)',
      'WebFetch',
      'WebSearch',
    ],
  },
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    url: { type: 'string', default: 'http://127.0.0.1:4317/mcp' },
    force: { type: 'boolean', default: false },
  },
})
const stop = (message: string): never => {
  process.stderr.write(`demo:recording: ${message}\n`)
  process.exit(2)
}
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dir = resolve(
  values.dir ?? (process.platform === 'win32' ? 'C:/kalyth-recording' : '/tmp/kalyth-recording'),
)
const paths = {
  db: join(dir, 'kalyth.db'),
  ledger: join(dir, 'ledger.sqlite'),
  repo: join(dir, 'repo'),
  worktree: join(dir, 'worktree'),
  settings: join(dir, 'claude-settings.json'),
  mcp: join(dir, 'mcp.json'),
}
const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const fwd = (p: string) => p.replace(/\\/g, '/')

function setup() {
  if (existsSync(dir)) {
    if (!values.force) stop(`${dir} exists; pass --force to replace it`)
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })

  const store = new SqliteStore(paths.db)
  const imported = importProjectExport(
    store,
    JSON.parse(readFileSync(join(repoRoot, 'deploy/demo/template.json'), 'utf8')),
  )
  store.close()
  if (!imported.ok) stop(`the demo template does not import: ${imported.error.message}`)
  const project = (imported as Extract<typeof imported, { ok: true }>).value

  // Public code only: the template, from the local mirror (fetched over HTTPS when missing).
  const mirror = cloneOrFetch(DEMO_REPO, join(repoRoot, '.kalyth')).path
  git('clone', '--quiet', mirror, paths.repo)
  git('-C', paths.repo, 'remote', 'remove', 'origin')
  git('-C', paths.repo, 'checkout', '--quiet', '--detach', DEMO_START)
  git('-C', paths.repo, 'config', 'user.name', 'Kalyth demo')
  git('-C', paths.repo, 'config', 'user.email', 'demo@kalyth.invalid')
  const base = git('-C', paths.repo, 'rev-parse', `${DEMO_START}^{commit}`)
  git('-C', paths.repo, 'worktree', 'add', '--quiet', '-b', AGENT_BRANCH, paths.worktree, base)
  writeFileSync(paths.settings, `${JSON.stringify(CLAUDE_SETTINGS, null, 2)}\n`)

  process.stdout.write(
    [
      `demo:recording: ready in ${dir}`,
      `  project   ${project.name} (${project.projectId}), the demo template`,
      `  repo      ${fwd(paths.repo)}  (register this as the task repository)`,
      `  worktree  ${fwd(paths.worktree)}  on ${AGENT_BRANCH}, the agent works here`,
      `  base      ${base}  (the task's base commit)`,
      '',
      'Start the server (off camera; it prints the session link):',
      `  KALYTH_DB=${fwd(paths.db)} KALYTH_LEDGER=${fwd(paths.ledger)} KALYTH_PROVIDER=replay KALYTH_REPLAY_DIR=deploy/demo/recordings pnpm dev:server`,
      'Then follow docs/demo/recording.md.',
      '',
    ].join('\n'),
  )
}

async function readToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  process.stdout.write('Paste the agent token (it is not shown): ')
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() })
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true })
  const answer = await new Promise<string>((done) => rl.question('', done))
  rl.close()
  process.stdout.write('\n')
  return answer.trim()
}

async function connect() {
  if (!existsSync(paths.worktree)) stop(`no recording setup in ${dir}; run setup first`)
  const token = await readToken()
  if (!TOKEN.test(token)) stop('that is not a Kalyth agent token (kalyth_at_...)')
  const config = {
    mcpServers: {
      kalyth: { type: 'http', url: values.url, headers: { Authorization: `Bearer ${token}` } },
    },
  }
  writeFileSync(paths.mcp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(
    [
      `demo:recording: wrote ${fwd(paths.mcp)} (the token is in it; it is outside the worktree)`,
      'Start Claude Code in the worktree:',
      `  cd ${fwd(paths.worktree)}`,
      `  claude --mcp-config ${fwd(paths.mcp)} --strict-mcp-config --settings ${fwd(paths.settings)}`,
      '',
    ].join('\n'),
  )
}

function teardown() {
  rmSync(paths.mcp, { force: true })
  process.stdout.write(
    [
      `demo:recording: removed ${fwd(paths.mcp)}`,
      'Revoke the agent token in Agents and packages. Delete the folder once the footage is done:',
      `  ${fwd(dir)}`,
      '',
    ].join('\n'),
  )
}

const command = positionals[0]
if (command === 'setup') setup()
else if (command === 'connect') await connect()
else if (command === 'teardown') teardown()
else stop('usage: pnpm demo:recording setup|connect|teardown [--dir <folder>]')
