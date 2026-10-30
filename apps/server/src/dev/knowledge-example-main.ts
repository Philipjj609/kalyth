import { ensureLocalAgent, ensureLocalOwner } from '@kalyth/core'
import { openLocalServices } from '../runtime.ts'
import { buildKnowledgeExample } from './knowledge-example.ts'

// Writes the K3 multi-game example into the store at KALYTH_DB, for trying the K4 read tools
// (`pnpm mcp:stdio` against the same KALYTH_DB). No model is called.
const services = openLocalServices()
const owner = ensureLocalOwner(services)
const agent = ensureLocalAgent(services)
const x = buildKnowledgeExample(
  services,
  { principalId: owner.id, origin: 'human' },
  { principalId: agent.id, origin: 'agent' },
)
process.stdout.write(
  `${JSON.stringify(
    {
      library: x.library.id,
      project: x.project.id,
      pins: {
        lockstep: x.P.$lockstep,
        deadReckoning: x.P.$deadReckoning,
        authServer: x.P.$authServer,
      },
      scenarios: { launch: x.P.$launch, expansion: x.P.$expansion },
      elements: { rts: x.P.$rts, shooter: x.P.$shooter },
      assessments: x.assessments,
    },
    null,
    2,
  )}\n`,
)
