/**
 * SQLite schema, version 1 (ADR 0003). Objects and relations are revision-stamped version rows:
 * a version is current at revision R when rev_from <= R and (rev_to IS NULL OR rev_to > R).
 * Triggers make events, change sets and evidence append-only, and allow a version row only to be
 * closed (rev_to set once). Content rows may only lose their body (redaction).
 */
export const SCHEMA_VERSION = 2

export const SCHEMA_V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'model', 'tool')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  project_id TEXT,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  granted_by TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX grants_principal ON grants(principal_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  head_revision INTEGER NOT NULL CHECK (head_revision >= 0)
) STRICT;

CREATE TABLE object_versions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  rev_from INTEGER NOT NULL,
  rev_to INTEGER,
  type TEXT NOT NULL,
  type_version INTEGER NOT NULL,
  stance TEXT NOT NULL CHECK (stance IN ('asIs', 'toBe')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
  attributes TEXT NOT NULL,
  claim TEXT NOT NULL,
  retired_reason TEXT,
  PRIMARY KEY (project_id, id, rev_from),
  CHECK (rev_to IS NULL OR rev_to > rev_from)
) STRICT;
CREATE INDEX ov_current ON object_versions(project_id, id, rev_to);
CREATE INDEX ov_type ON object_versions(project_id, type, rev_to);
CREATE INDEX ov_rev ON object_versions(project_id, rev_from);

CREATE TABLE relation_versions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  rev_from INTEGER NOT NULL,
  rev_to INTEGER,
  type TEXT NOT NULL,
  type_version INTEGER NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  stance TEXT NOT NULL CHECK (stance IN ('asIs', 'toBe')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
  properties TEXT NOT NULL,
  claim TEXT NOT NULL,
  retired_reason TEXT,
  PRIMARY KEY (project_id, id, rev_from),
  CHECK (rev_to IS NULL OR rev_to > rev_from)
) STRICT;
CREATE INDEX rv_current ON relation_versions(project_id, id, rev_to);
CREATE INDEX rv_from ON relation_versions(project_id, from_id, rev_to);
CREATE INDEX rv_to ON relation_versions(project_id, to_id, rev_to);
CREATE INDEX rv_rev ON relation_versions(project_id, rev_from);

CREATE TABLE evidence (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  excerpt_content_id TEXT,
  excerpt_sha256 TEXT,
  collected_by TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
) STRICT;
CREATE INDEX evidence_rev ON evidence(project_id, revision);

CREATE TABLE content (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  body TEXT,
  redacted_at TEXT,
  redaction_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
) STRICT;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision INTEGER NOT NULL,
  proposed_by TEXT NOT NULL REFERENCES principals(id),
  origin TEXT NOT NULL,
  ops TEXT NOT NULL,
  ops_hash TEXT NOT NULL,
  rationale TEXT NOT NULL,
  read_set TEXT NOT NULL,
  write_set TEXT NOT NULL,
  predicates TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  issues TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
) STRICT;
CREATE UNIQUE INDEX proposals_idempotency ON proposals(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX proposals_status ON proposals(project_id, status);

CREATE TABLE change_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  proposal_id TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  committed_by TEXT NOT NULL,
  origin TEXT NOT NULL,
  proposal_base_revision INTEGER NOT NULL,
  applied_on_revision INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  write_count INTEGER NOT NULL,
  UNIQUE (project_id, revision)
) STRICT;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  origin TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX events_project ON events(project_id, seq);

CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;

CREATE TRIGGER change_sets_immutable_update BEFORE UPDATE ON change_sets
BEGIN SELECT RAISE(ABORT, 'change sets are immutable'); END;
CREATE TRIGGER change_sets_immutable_delete BEFORE DELETE ON change_sets
BEGIN SELECT RAISE(ABORT, 'change sets are immutable'); END;

CREATE TRIGGER evidence_immutable_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
CREATE TRIGGER evidence_immutable_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;

CREATE TRIGGER object_versions_close_only BEFORE UPDATE ON object_versions
WHEN OLD.rev_to IS NOT NULL OR NEW.rev_to IS NULL
  OR NEW.project_id IS NOT OLD.project_id OR NEW.id IS NOT OLD.id OR NEW.rev_from IS NOT OLD.rev_from
  OR NEW.type IS NOT OLD.type OR NEW.type_version IS NOT OLD.type_version
  OR NEW.stance IS NOT OLD.stance OR NEW.lifecycle IS NOT OLD.lifecycle
  OR NEW.attributes IS NOT OLD.attributes OR NEW.claim IS NOT OLD.claim
  OR NEW.retired_reason IS NOT OLD.retired_reason
BEGIN SELECT RAISE(ABORT, 'version rows can only be closed'); END;
CREATE TRIGGER object_versions_no_delete BEFORE DELETE ON object_versions
BEGIN SELECT RAISE(ABORT, 'version rows are never deleted'); END;

CREATE TRIGGER relation_versions_close_only BEFORE UPDATE ON relation_versions
WHEN OLD.rev_to IS NOT NULL OR NEW.rev_to IS NULL
  OR NEW.project_id IS NOT OLD.project_id OR NEW.id IS NOT OLD.id OR NEW.rev_from IS NOT OLD.rev_from
  OR NEW.type IS NOT OLD.type OR NEW.type_version IS NOT OLD.type_version
  OR NEW.from_id IS NOT OLD.from_id OR NEW.to_id IS NOT OLD.to_id
  OR NEW.stance IS NOT OLD.stance OR NEW.lifecycle IS NOT OLD.lifecycle
  OR NEW.properties IS NOT OLD.properties OR NEW.claim IS NOT OLD.claim
  OR NEW.retired_reason IS NOT OLD.retired_reason
BEGIN SELECT RAISE(ABORT, 'version rows can only be closed'); END;
CREATE TRIGGER relation_versions_no_delete BEFORE DELETE ON relation_versions
BEGIN SELECT RAISE(ABORT, 'version rows are never deleted'); END;

CREATE TRIGGER content_redaction_only BEFORE UPDATE ON content
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.id IS NOT OLD.id OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.media_type IS NOT OLD.media_type OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.body IS NOT NULL AND NEW.body IS NOT OLD.body)
BEGIN SELECT RAISE(ABORT, 'content can only be redacted'); END;
`

/**
 * Version 2: agent tokens (ADR 0011). Only the SHA-256 of a token is stored. A row can be revoked
 * once and never deleted, so the record of who could act, and until when, stays complete.
 */
export const SCHEMA_V2 = `
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_sha256 TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX agent_tokens_project ON agent_tokens(project_id);

CREATE TRIGGER agent_tokens_no_delete BEFORE DELETE ON agent_tokens
BEGIN SELECT RAISE(ABORT, 'agent tokens are revoked, never deleted'); END;

CREATE TRIGGER agent_tokens_revoke_only BEFORE UPDATE ON agent_tokens
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.principal_id IS NOT OLD.principal_id OR NEW.token_sha256 IS NOT OLD.token_sha256
  OR NEW.label IS NOT OLD.label OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'an agent token can only be revoked, once'); END;
`
