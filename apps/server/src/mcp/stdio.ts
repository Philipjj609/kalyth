import { ensureLocalAgent } from '@kalyth/core'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { openLocalServices } from '../runtime.ts'
import { createKalythMcpServer } from './server.ts'

// Local MCP over stdio. stdout carries protocol messages only; diagnostics go to stderr.
const services = openLocalServices()
const agent = ensureLocalAgent(services, process.env.KALYTH_AGENT_NAME ?? 'local-mcp-agent')
serveStdio(() => createKalythMcpServer(services, agent.id))
process.stderr.write(`kalyth mcp: serving as ${agent.displayName} (${agent.id})\n`)
