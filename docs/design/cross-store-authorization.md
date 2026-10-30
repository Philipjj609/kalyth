# Requirements: authorization across stores (for K6)

Status: requirements, not yet a contract. Written on 30 October 2026 beside
[ADR 0030](../adr/0030-knowledge-operation-contracts.md). They become an ADR before K6. Nothing in
K1 to K5 writes across projects, so this does not delay those slices.

## The situation

A method run in project P may file a hypothesis to library L (ADR 0029 §4.5). P and L may be in the
same store, in different stores on one machine, or L may be held only as a read-only snapshot or,
later, by a remote publisher. Principals and grants are local to a store (ADR 0006), and a project
proposal and a library proposal are separate (ADR 0029 I4).

## Requirements

**R1. Two proposals, two authorities.** P's proposal needs `proposal.create` on P. L's proposal
needs `proposal.create` on L, granted by L's administrators, never inferred from rights on P. Each
is committed or rejected only by principals authorised in its own project. L's maturity changes
also need `knowledge.curate` on L.

**R2. Same store.** The running principal is recognised directly. An agent may file to L only with
its own grant on L. The run records which principal filed, and with which grant.

**R3. Different store, or remote.** The two stores do not share principals.

- Filing needs a credential issued by L's store: a library-scoped, proposal-only token, like the
  agent tokens of ADR 0011, with an expiry and revocation.
- The token is never written to events, proposals, exports or logs. It is held as a secret
  outside project data and referenced by name.
- L records the filer as L's own principal for that token, with "filed from an external project"
  as provenance. It never names P's principals as its own.

**R4. Read-only snapshots cannot receive proposals.** Filing fails with "hypothesis not filed:
library is a read-only snapshot". This is the specified failure of ADR 0029, not an error.

**R5. Data leaving a store needs a person's approval.** A hypothesis carries a case document that
describes P's need. When L is in another store, that is project information leaving the store.

- A person on P approves each filing, after seeing the exact content. This is like the consent
  before a model call (ADR 0010).
- Agents and models can prepare a filing but never send it.
- The case document never contains project source (ADR 0026 I1).

**R6. Independent approvals and lifecycles.**

- P may commit, reject or supersede its proposal whatever happens to L's, and the reverse.
- The link between them is informational: `links` on both, and the `unbacked` mark on P's
  alternative. It is never a dependency of a commit.

**R7. Failure handling.**

| Failure | Behaviour |
|---|---|
| L unreachable, credential missing or expired, grant revoked | P's proposal is created. Its alternative shows "hypothesis not filed: …" with the reason. A retry is offered, not automatic |
| L reachable, but the filing is refused (validation, permission) | The same, with L's refusal message |
| A retry after a lost response | Uses the same idempotency key, so L never holds two copies |
| L's status cannot be read later | Shown as "status unknown since …", never as rejected or committed |
| L rejects or deprecates the hypothesis | P shows "hypothesis rejected", with no change to P's history |

**R8. Audit on both sides.** P's history records the filing, its approver, the target and the
outcome. L's history records the proposal and its external provenance. Neither copies the other's
records.

## Acceptance criteria for the K6 ADR

1. Without a grant on L, filing fails with that reason and P's proposal exists.
2. An agent cannot send a cross-store filing. A person's approval, shown with the exact content,
   is required, and it is recorded.
3. No credential appears in any event, proposal, export or log; this is checked by a scan in tests.
4. A filing retried after a timeout creates one library proposal.
5. Rejecting in L leaves P's committed history untouched, and P shows the new status.
6. A snapshot library refuses filing with the specified reason.
