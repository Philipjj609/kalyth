import { describe, expect, it } from 'vitest'
import { providerFromEnv } from '../src/runtime.ts'

const KEY = ['test', 'key', 'not', 'real', '0123456789'].join('-')

describe('provider selection from the environment', () => {
  it('uses the mock by default and needs the named key for each external provider', () => {
    expect(providerFromEnv({}).family).toBe('mock')
    expect(() => providerFromEnv({ KALYTH_PROVIDER: 'nebius' })).toThrow(/KALYTH_NEBIUS_API_KEY/)
    expect(() => providerFromEnv({ KALYTH_PROVIDER: 'openrouter' })).toThrow(
      /KALYTH_OPENROUTER_API_KEY/,
    )
    // A key under any other name is not read.
    expect(() => providerFromEnv({ KALYTH_PROVIDER: 'openrouter', OPENROUTER: KEY })).toThrow(
      /KALYTH_OPENROUTER_API_KEY/,
    )
    expect(
      providerFromEnv({ KALYTH_PROVIDER: 'openrouter', KALYTH_OPENROUTER_API_KEY: KEY }),
    ).toMatchObject({
      family: 'openrouter',
      provider: { id: 'openrouter', external: true, paid: false },
    })
    expect(
      providerFromEnv({ KALYTH_PROVIDER: 'nebius', KALYTH_NEBIUS_API_KEY: KEY }),
    ).toMatchObject({ family: 'nebius', provider: { id: 'nebius', external: true, paid: true } })
    expect(() => providerFromEnv({ KALYTH_PROVIDER: 'other' })).toThrow(
      /mock, nebius, openrouter or replay/,
    )
  })
})
