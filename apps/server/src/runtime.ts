import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { KalythServices, SqliteStore } from '@kalyth/core'
import {
  BudgetLedger,
  DEFAULT_ROLE_MODELS,
  defaultLedgerPath,
  MockProvider,
  NebiusProvider,
  OpenRouterProvider,
  type Provider,
  ProviderGateway,
  RecordingProvider,
  ReplayProvider,
} from '@kalyth/gateway'
import { Navigator, navigatorMockResponder } from '@kalyth/navigator'

/** Loads a git-ignored .env from the working directory, if there is one. Never committed. */
export function loadLocalEnv(): void {
  const path = resolve('.env')
  if (existsSync(path)) process.loadEnvFile(path)
}

/** Opens the local store. KALYTH_DB overrides the default .kalyth/kalyth.db in the working directory. */
export function openLocalServices(): KalythServices {
  const path = resolve(process.env.KALYTH_DB ?? join(process.cwd(), '.kalyth', 'kalyth.db'))
  mkdirSync(dirname(path), { recursive: true })
  return new KalythServices({ store: new SqliteStore(path) })
}

/**
 * The provider the Navigator uses (ADR 0010). The mock is the default. Nebius needs
 * KALYTH_PROVIDER=nebius and KALYTH_NEBIUS_API_KEY, and still spends nothing until a cap is set
 * in the ledger. OpenRouter's free endpoints (ADR 0016) need KALYTH_PROVIDER=openrouter and
 * KALYTH_OPENROUTER_API_KEY, for public and synthetic tests only. KALYTH_RECORD_DIR records real
 * exchanges; KALYTH_PROVIDER=replay replays them.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  provider: Provider
  family: string
} {
  const kind = env.KALYTH_PROVIDER ?? 'mock'
  switch (kind) {
    case 'mock':
      return { provider: new MockProvider(navigatorMockResponder), family: 'mock' }
    case 'nebius': {
      const apiKey = env.KALYTH_NEBIUS_API_KEY
      if (!apiKey) throw new Error('KALYTH_PROVIDER=nebius needs KALYTH_NEBIUS_API_KEY')
      const nebius = new NebiusProvider({
        apiKey,
        ...(env.KALYTH_NEBIUS_BASE_URL ? { baseUrl: env.KALYTH_NEBIUS_BASE_URL } : {}),
      })
      const provider = env.KALYTH_RECORD_DIR
        ? new RecordingProvider(nebius, resolve(env.KALYTH_RECORD_DIR))
        : nebius
      return { provider, family: 'nebius' }
    }
    case 'openrouter': {
      const apiKey = env.KALYTH_OPENROUTER_API_KEY
      if (!apiKey) throw new Error('KALYTH_PROVIDER=openrouter needs KALYTH_OPENROUTER_API_KEY')
      const openrouter = new OpenRouterProvider({ apiKey })
      const provider = env.KALYTH_RECORD_DIR
        ? new RecordingProvider(openrouter, resolve(env.KALYTH_RECORD_DIR))
        : openrouter
      return { provider, family: 'openrouter' }
    }
    case 'replay': {
      const dir = env.KALYTH_REPLAY_DIR
      if (!dir) throw new Error('KALYTH_PROVIDER=replay needs KALYTH_REPLAY_DIR')
      const source = env.KALYTH_REPLAY_SOURCE ?? 'nebius'
      return { provider: ReplayProvider.fromDirectory(source, resolve(dir)), family: source }
    }
    default:
      throw new Error(`unknown KALYTH_PROVIDER ${kind}; use mock, nebius, openrouter or replay`)
  }
}

export function openNavigator(services: KalythServices, env: NodeJS.ProcessEnv = process.env) {
  const { provider, family } = providerFromEnv(env)
  const roleModels = {
    ...(DEFAULT_ROLE_MODELS[family] ?? {}),
    ...(env.KALYTH_MODEL_SUMMARIZE ? { summarize: env.KALYTH_MODEL_SUMMARIZE } : {}),
    ...(env.KALYTH_MODEL_ALTERNATIVES ? { alternatives: env.KALYTH_MODEL_ALTERNATIVES } : {}),
  }
  const gateway = new ProviderGateway({
    provider,
    ledger: new BudgetLedger(defaultLedgerPath()),
    roleModels,
  })
  return { navigator: new Navigator({ services, gateway }), gateway }
}
