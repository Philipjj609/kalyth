/**
 * Secret-pattern screening for evidence excerpts before they reach the content store (ADR 0003).
 * A match stores only the hash, with a redaction marker. This is a guard against accidental
 * capture of committed credentials, not a complete secret scanner.
 */
const RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'api-key-prefix', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
  {
    id: 'assigned-secret',
    pattern:
      /(?:api[_-]?key|secret|passwd|password|token|auth)[A-Za-z0-9_]*\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
]

export function findSecretRule(text: string): string | undefined {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.id
  }
  return undefined
}
