import { type Principal, type PrincipalKind, Scope } from '@kalyth/contracts'
import type { KalythServices } from './services/services.ts'

export const OWNER_SCOPES: readonly Scope[] = Scope.options
export const AGENT_SCOPES: readonly Scope[] = ['project.read', 'proposal.create']

/**
 * Returns the principal registered under `key`, creating it with global grants on first use.
 * Local mode only: the hosted mode will issue scoped, expiring grants instead.
 */
export function ensurePrincipal(
  services: KalythServices,
  key: string,
  kind: PrincipalKind,
  displayName: string,
  scopes: readonly Scope[],
): Principal {
  const metaKey = `principal:${key}`
  const existingId = services.store.getMeta(metaKey)
  const existing = existingId ? services.store.getPrincipal(existingId) : undefined
  if (existing) return existing
  return services.store.writeTransaction(() => {
    const principal = services.createPrincipal(kind, displayName)
    services.grant(principal.id, scopes)
    services.store.setMeta(metaKey, principal.id)
    return principal
  })
}

export const ensureLocalOwner = (services: KalythServices): Principal =>
  ensurePrincipal(services, 'local-owner', 'human', 'Local owner', OWNER_SCOPES)

export const ensureLocalAgent = (services: KalythServices, name = 'local-mcp-agent'): Principal =>
  ensurePrincipal(services, name, 'agent', name, AGENT_SCOPES)
