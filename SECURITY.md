# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (security
advisories) on this repository rather than in a public issue.

## Current posture (honest summary)

Kalyth is pre-release software. What is enforced today:

- Authorisation is checked in the service layer for every read and write, independent of any model
  output. Agents connected over MCP can read and propose; they cannot commit or accept decisions.
- The local HTTP API binds to 127.0.0.1, requires a per-launch session token and rejects foreign
  Host and Origin headers.
- Events, change sets and evidence are append-only at the database level.
- Evidence excerpts that match common secret patterns are stored as hashes only.
- Kalyth does not execute code from analysed repositories.

The threat model for local mode, with each surface, its controls and the remaining risks, is in
[docs/security/threat-model.md](docs/security/threat-model.md).

What is not claimed: a hardened multi-user deployment, a sandbox for untrusted code, complete secret
detection, or compliance with any certification. The hosted demo (when it exists) will document its
own limits.
