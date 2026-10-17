import { ContextCompiler } from '@kalyth/context'
import { ensureLocalAgent } from '@kalyth/core'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { openLocalServices } from '../runtime.ts'
import { createKalythMcpServer } from './server.ts'

// Local MCP over stdio. stdout carries protocol messages only; diagnostics go to stderr.
const services = openLocalServices()
const agent = ensureLocalAgent(services, process.env.KALYTH_AGENT_NAME ?? 'local-mcp-agent')
const context = new ContextCompiler({ services })
serveStdio(() => createKalythMcpServer({ services, context }, agent.id))
process.stderr.write(`kalyth mcp: serving as ${agent.displayName} (${agent.id})\n`)
