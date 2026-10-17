import { ContextCompiler } from '@kalyth/context'
import { ensureLocalAgent } from '@kalyth/core'
import { TaskCoordinator } from '@kalyth/tasks'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { openLocalServices } from '../runtime.ts'
import { createKalythMcpServer } from './server.ts'

// Local MCP over stdio. stdout carries protocol messages only; diagnostics go to stderr.
const services = openLocalServices()
const agent = ensureLocalAgent(services, process.env.KALYTH_AGENT_NAME ?? 'local-mcp-agent')
const context = new ContextCompiler({ services })
const tasks = new TaskCoordinator({ services, context })
serveStdio(() => createKalythMcpServer({ services, context, tasks }, agent.id))
process.stderr.write(`kalyth mcp: serving as ${agent.displayName} (${agent.id})\n`)
