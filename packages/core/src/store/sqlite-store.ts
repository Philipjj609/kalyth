import type {
  AgentTokenSummary,
  ChangeSetSummary,
  ContentRef,
  EvidenceRecord,
  EvidenceView,
  Grant,
  InstructionOrigin,
  Issue,
  KalythEvent,
  ObjectVersion,
  Principal,
  ProjectSummary,
  Proposal,
  ProposalStatus,
  RelationVersion,
  ResolvedWrite,
} from '@kalyth/contracts'
import Database from 'better-sqlite3'
import {
  matchesObject,
  type ObjectFilter,
  type RelationFilter,
  type StateView,
} from '../kernel/state.ts'
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_VERSION } from './schema.ts'

type Row = Record<string, unknown>
const str = (v: unknown): string => v as string
const num = (v: unknown): number => v as number
const nstr = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string))
const json = <T>(v: unknown): T => JSON.parse(v as string) as T

const CURRENT_AT = 'rev_from <= @rev AND (rev_to IS NULL OR rev_to > @rev)'

export class SqliteStore {
  readonly db: Database.Database
  readonly #statements = new Map<string, Database.Statement>()

  constructor(path = ':memory:') {
    this.db = new Database(path)
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.#migrate()
  }

  close(): void {
    this.db.close()
  }

  #migrate(): void {
    const hasMeta = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get()
    const version = hasMeta ? Number(this.getMeta('schema_version') ?? 0) : 0
    if (version > SCHEMA_VERSION) {
      throw new Error(`database schema ${version} is newer than this build (${SCHEMA_VERSION})`)
    }
    if (version < SCHEMA_VERSION) {
      this.db.transaction(() => {
        if (version < 1) this.db.exec(SCHEMA_V1)
        if (version < 2) this.db.exec(SCHEMA_V2)
        this.setMeta('schema_version', String(SCHEMA_VERSION))
      })()
    }
  }

  #stmt(sql: string): Database.Statement {
    let statement = this.#statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  /** Runs fn in a write transaction (BEGIN IMMEDIATE). Any throw rolls everything back. */
  writeTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  // ---------- meta ----------

  getMeta(key: string): string | undefined {
    const row = this.#stmt('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row ? str(row.value) : undefined
  }

  setMeta(key: string, value: string): void {
    this.#stmt(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  // ---------- principals and grants ----------

  insertPrincipal(p: Principal): void {
    this.#stmt(
      'INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
    ).run(p.id, p.kind, p.displayName, p.createdAt)
  }

  getPrincipal(id: string): Principal | undefined {
    const row = this.#stmt('SELECT * FROM principals WHERE id = ?').get(id) as Row | undefined
    return row
      ? {
          id: str(row.id),
          kind: row.kind as Principal['kind'],
          displayName: str(row.display_name),
          createdAt: str(row.created_at),
        }
      : undefined
  }

  insertGrant(g: Grant): void {
    this.#stmt(
      'INSERT INTO grants (id, principal_id, project_id, scopes, expires_at, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      g.id,
      g.principalId,
      g.projectId,
      JSON.stringify(g.scopes),
      g.expiresAt,
      g.grantedBy,
      g.createdAt,
    )
  }

  // ---------- agent tokens (ADR 0011) ----------

  insertAgentToken(t: AgentTokenSummary, tokenSha256: string): void {
    this.#stmt(
      `INSERT INTO agent_tokens (id, project_id, principal_id, token_sha256, label, created_by, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      t.id,
      t.projectId,
      t.principalId,
      tokenSha256,
      t.label,
      t.createdBy,
      t.createdAt,
      t.expiresAt,
    )
  }

  agentTokenByHash(tokenSha256: string): Omit<AgentTokenSummary, 'scopes'> | undefined {
    const row = this.#stmt('SELECT * FROM agent_tokens WHERE token_sha256 = ?').get(tokenSha256) as
      | Row
      | undefined
    return row ? toAgentToken(row) : undefined
  }

  agentToken(id: string): Omit<AgentTokenSummary, 'scopes'> | undefined {
    const row = this.#stmt('SELECT * FROM agent_tokens WHERE id = ?').get(id) as Row | undefined
    return row ? toAgentToken(row) : undefined
  }

  agentTokens(projectId: string): Omit<AgentTokenSummary, 'scopes'>[] {
    const rows = this.#stmt(
      'SELECT * FROM agent_tokens WHERE project_id = ? ORDER BY created_at DESC, id DESC',
    ).all(projectId) as Row[]
    return rows.map(toAgentToken)
  }

  revokeAgentToken(id: string, at: string): boolean {
    return (
      this.#stmt('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
        at,
        id,
      ).changes === 1
    )
  }

  grantsFor(principalId: string): Grant[] {
    const rows = this.#stmt('SELECT * FROM grants WHERE principal_id = ?').all(principalId) as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      principalId: str(r.principal_id),
      projectId: nstr(r.project_id),
      scopes: json(r.scopes),
      expiresAt: nstr(r.expires_at),
      grantedBy: nstr(r.granted_by),
      createdAt: str(r.created_at),
    }))
  }

  // ---------- projects ----------

  insertProject(p: Omit<ProjectSummary, 'headRevision'>): void {
    this.#stmt(
      'INSERT INTO projects (id, name, description, created_at, created_by, head_revision) VALUES (?, ?, ?, ?, ?, 0)',
    ).run(p.id, p.name, p.description, p.createdAt, p.createdBy)
  }

  getProject(id: string): ProjectSummary | undefined {
    const row = this.#stmt('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? toProject(row) : undefined
  }

  listProjects(): ProjectSummary[] {
    return (this.#stmt('SELECT * FROM projects ORDER BY created_at, id').all() as Row[]).map(
      toProject,
    )
  }

  setHead(projectId: string, expected: number, next: number): void {
    const info = this.#stmt(
      'UPDATE projects SET head_revision = ? WHERE id = ? AND head_revision = ?',
    ).run(next, projectId, expected)
    if (info.changes !== 1) throw new Error('head revision moved during commit')
  }

  // ---------- state views ----------

  view(projectId: string, revision: number): StateView {
    return new SqliteStateView(this, projectId, revision)
  }

  getObjectAt(projectId: string, id: string, rev: number): ObjectVersion | undefined {
    const row = this.#stmt(
      `SELECT * FROM object_versions WHERE project_id = @p AND id = @id AND ${CURRENT_AT}`,
    ).get({
      p: projectId,
      id,
      rev,
    }) as Row | undefined
    return row ? toObject(row) : undefined
  }

  getRelationAt(projectId: string, id: string, rev: number): RelationVersion | undefined {
    const row = this.#stmt(
      `SELECT * FROM relation_versions WHERE project_id = @p AND id = @id AND ${CURRENT_AT}`,
    ).get({
      p: projectId,
      id,
      rev,
    }) as Row | undefined
    return row ? toRelation(row) : undefined
  }

  getEvidenceAt(projectId: string, id: string, rev: number): EvidenceRecord | undefined {
    const row = this.#stmt(
      'SELECT * FROM evidence WHERE project_id = ? AND id = ? AND revision <= ?',
    ).get(projectId, id, rev) as Row | undefined
    return row ? toEvidence(row) : undefined
  }

  objectsAt(
    projectId: string,
    rev: number,
    opts: {
      types?: readonly string[] | undefined
      ids?: readonly string[] | undefined
      includeRetired?: boolean
      limit?: number
    },
  ): ObjectVersion[] {
    const where = [`project_id = @p`, CURRENT_AT]
    const params: Record<string, unknown> = { p: projectId, rev }
    if (!opts.includeRetired) where.push(`lifecycle = 'active'`)
    if (opts.types) where.push(`type IN (${placeholders('t', opts.types, params)})`)
    if (opts.ids) where.push(`id IN (${placeholders('i', opts.ids, params)})`)
    const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''
    const sql = `SELECT * FROM object_versions WHERE ${where.join(' AND ')} ORDER BY id${limit}`
    return (this.db.prepare(sql).all(params) as Row[]).map(toObject)
  }

  relationsAt(
    projectId: string,
    rev: number,
    opts: {
      types?: readonly string[] | undefined
      ids?: readonly string[] | undefined
      from?: string | undefined
      to?: string | undefined
      includeRetired?: boolean
      limit?: number
    },
  ): RelationVersion[] {
    const where = [`project_id = @p`, CURRENT_AT]
    const params: Record<string, unknown> = { p: projectId, rev }
    if (!opts.includeRetired) where.push(`lifecycle = 'active'`)
    if (opts.types) where.push(`type IN (${placeholders('t', opts.types, params)})`)
    if (opts.ids) where.push(`id IN (${placeholders('i', opts.ids, params)})`)
    if (opts.from !== undefined) {
      where.push('from_id = @from')
      params.from = opts.from
    }
    if (opts.to !== undefined) {
      where.push('to_id = @to')
      params.to = opts.to
    }
    const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''
    const sql = `SELECT * FROM relation_versions WHERE ${where.join(' AND ')} ORDER BY id${limit}`
    return (this.db.prepare(sql).all(params) as Row[]).map(toRelation)
  }

  /** Ids of objects, relations and evidence written after `base` up to and including `head`. */
  changedIdsSince(projectId: string, base: number, head: number): Set<string> {
    const rows = this.#stmt(
      `SELECT id FROM object_versions WHERE project_id = @p AND rev_from > @base AND rev_from <= @head
       UNION SELECT id FROM relation_versions WHERE project_id = @p AND rev_from > @base AND rev_from <= @head
       UNION SELECT id FROM evidence WHERE project_id = @p AND revision > @base AND revision <= @head`,
    ).all({ p: projectId, base, head }) as Row[]
    return new Set(rows.map((r) => str(r.id)))
  }

  // ---------- writes ----------

  applyWrites(projectId: string, revision: number, writes: readonly ResolvedWrite[]): void {
    for (const w of writes) {
      if (w.kind === 'object') {
        const v = w.version
        this.#stmt(
          'UPDATE object_versions SET rev_to = ? WHERE project_id = ? AND id = ? AND rev_to IS NULL',
        ).run(revision, projectId, v.id)
        this.#stmt(
          `INSERT INTO object_versions (project_id, id, rev_from, rev_to, type, type_version, stance, lifecycle, attributes, claim, retired_reason)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          projectId,
          v.id,
          revision,
          v.type,
          v.typeVersion,
          v.stance,
          v.lifecycle,
          JSON.stringify(v.attributes),
          JSON.stringify(v.claim),
          v.retiredReason,
        )
      } else if (w.kind === 'relation') {
        const v = w.version
        this.#stmt(
          'UPDATE relation_versions SET rev_to = ? WHERE project_id = ? AND id = ? AND rev_to IS NULL',
        ).run(revision, projectId, v.id)
        this.#stmt(
          `INSERT INTO relation_versions (project_id, id, rev_from, rev_to, type, type_version, from_id, to_id, stance, lifecycle, properties, claim, retired_reason)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          projectId,
          v.id,
          revision,
          v.type,
          v.typeVersion,
          v.from,
          v.to,
          v.stance,
          v.lifecycle,
          JSON.stringify(v.properties),
          JSON.stringify(v.claim),
          v.retiredReason,
        )
      } else {
        const e = w.record
        this.#stmt(
          `INSERT INTO evidence (project_id, id, revision, source, excerpt_content_id, excerpt_sha256, collected_by, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          projectId,
          e.id,
          revision,
          JSON.stringify(e.source),
          e.excerpt?.contentId ?? null,
          e.excerpt?.sha256 ?? null,
          JSON.stringify(e.collectedBy),
          e.collectedAt,
        )
      }
    }
  }

  insertChangeSet(cs: {
    id: string
    projectId: string
    revision: number
    proposalId: string
    proposedBy: string
    committedBy: string
    origin: InstructionOrigin
    proposalBaseRevision: number
    appliedOnRevision: number
    committedAt: string
    writeCount: number
  }): void {
    this.#stmt(
      `INSERT INTO change_sets (id, project_id, revision, proposal_id, proposed_by, committed_by, origin, proposal_base_revision, applied_on_revision, committed_at, write_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cs.id,
      cs.projectId,
      cs.revision,
      cs.proposalId,
      cs.proposedBy,
      cs.committedBy,
      cs.origin,
      cs.proposalBaseRevision,
      cs.appliedOnRevision,
      cs.committedAt,
      cs.writeCount,
    )
  }

  insertEvent(e: Omit<KalythEvent, 'seq'>): number {
    const info = this.#stmt(
      `INSERT INTO events (id, project_id, revision, type, schema_version, actor, origin, occurred_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.projectId,
      e.revision,
      e.type,
      e.schemaVersion,
      e.actor,
      e.origin,
      e.occurredAt,
      JSON.stringify(e.payload),
    )
    return Number(info.lastInsertRowid)
  }

  listEvents(projectId?: string): KalythEvent[] {
    const rows = (
      projectId
        ? this.#stmt('SELECT * FROM events WHERE project_id = ? ORDER BY seq').all(projectId)
        : this.#stmt('SELECT * FROM events ORDER BY seq').all()
    ) as Row[]
    return rows.map(
      (r) =>
        ({
          id: str(r.id),
          seq: num(r.seq),
          projectId: str(r.project_id),
          revision: num(r.revision),
          type: str(r.type),
          schemaVersion: num(r.schema_version),
          actor: str(r.actor),
          origin: str(r.origin),
          occurredAt: str(r.occurred_at),
          payload: json(r.payload),
        }) as KalythEvent,
    )
  }

  // ---------- content ----------

  putContent(
    projectId: string,
    c: {
      id: string
      sha256: string
      mediaType: string
      body: string | null
      redactionReason: string | null
      createdAt: string
    },
  ): ContentRef {
    this.#stmt(
      `INSERT INTO content (project_id, id, sha256, media_type, body, redacted_at, redaction_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO NOTHING`,
    ).run(
      projectId,
      c.id,
      c.sha256,
      c.mediaType,
      c.body,
      c.body === null ? c.createdAt : null,
      c.redactionReason,
      c.createdAt,
    )
    return { contentId: c.id, sha256: c.sha256 }
  }

  getContent(
    projectId: string,
    id: string,
  ): { body: string | null; redacted: boolean } | undefined {
    const row = this.#stmt(
      'SELECT body, redacted_at FROM content WHERE project_id = ? AND id = ?',
    ).get(projectId, id) as Row | undefined
    return row ? { body: nstr(row.body), redacted: row.redacted_at !== null } : undefined
  }

  redactContent(projectId: string, id: string, reason: string, at: string): boolean {
    const info = this.#stmt(
      'UPDATE content SET body = NULL, redacted_at = ?, redaction_reason = ? WHERE project_id = ? AND id = ? AND redacted_at IS NULL',
    ).run(at, reason, projectId, id)
    return info.changes === 1
  }

  /** Every evidence record recorded at or before a revision, keyed by id. */
  evidenceMapAt(projectId: string, rev: number): Map<string, EvidenceRecord> {
    const rows = this.#stmt('SELECT * FROM evidence WHERE project_id = ? AND revision <= ?').all(
      projectId,
      rev,
    ) as Row[]
    return new Map(rows.map((r) => [str(r.id), toEvidence(r)]))
  }

  evidenceViews(projectId: string, ids: readonly string[]): EvidenceView[] {
    const params: Record<string, unknown> = { p: projectId }
    const sql = `SELECT e.*, c.body AS excerpt_body, c.redacted_at AS excerpt_redacted_at
      FROM evidence e LEFT JOIN content c ON c.project_id = e.project_id AND c.id = e.excerpt_content_id
      WHERE e.project_id = @p AND e.id IN (${placeholders('i', ids, params)}) ORDER BY e.id`
    return (this.db.prepare(sql).all(params) as Row[]).map((r) => ({
      ...toEvidence(r),
      revision: num(r.revision),
      excerptText: nstr(r.excerpt_body),
      excerptRedacted: r.excerpt_redacted_at !== null && r.excerpt_redacted_at !== undefined,
    }))
  }

  // ---------- proposals ----------

  insertProposal(p: Proposal, opsHash: string): void {
    this.#stmt(
      `INSERT INTO proposals (id, project_id, base_revision, proposed_by, origin, ops, ops_hash, rationale, read_set, write_set, predicates,
         idempotency_key, status, issues, result, created_at, decided_at, decided_by, decision_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.projectId,
      p.baseRevision,
      p.proposedBy,
      p.origin,
      JSON.stringify(p.ops),
      opsHash,
      p.rationale,
      JSON.stringify(p.readSet),
      JSON.stringify(p.writeSet),
      JSON.stringify(p.predicates),
      p.idempotencyKey,
      p.status,
      JSON.stringify(p.issues),
      p.result ? JSON.stringify(p.result) : null,
      p.createdAt,
      p.decidedAt,
      p.decidedBy,
      p.decisionNote,
    )
  }

  getProposal(id: string): Proposal | undefined {
    const row = this.#stmt('SELECT * FROM proposals WHERE id = ?').get(id) as Row | undefined
    return row ? toProposal(row) : undefined
  }

  findProposalByKey(
    projectId: string,
    key: string,
  ): { proposal: Proposal; opsHash: string } | undefined {
    const row = this.#stmt(
      'SELECT * FROM proposals WHERE project_id = ? AND idempotency_key = ?',
    ).get(projectId, key) as Row | undefined
    return row ? { proposal: toProposal(row), opsHash: str(row.ops_hash) } : undefined
  }

  listProposals(projectId: string, status: ProposalStatus | undefined, limit: number): Proposal[] {
    const rows = (
      status
        ? this.#stmt(
            'SELECT * FROM proposals WHERE project_id = ? AND status = ? ORDER BY created_at, id LIMIT ?',
          ).all(projectId, status, limit)
        : this.#stmt(
            'SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at, id LIMIT ?',
          ).all(projectId, limit)
    ) as Row[]
    return rows.map(toProposal)
  }

  countPending(projectId: string): number {
    const row = this.#stmt(
      "SELECT count(*) AS n FROM proposals WHERE project_id = ? AND status = 'pending'",
    ).get(projectId) as Row
    return num(row.n)
  }

  decideProposal(
    id: string,
    d: {
      status: ProposalStatus
      issues?: Issue[]
      result?: unknown
      decidedAt: string
      decidedBy: string
      note?: string | null
    },
  ): void {
    this.#stmt(
      `UPDATE proposals SET status = ?, issues = COALESCE(?, issues), result = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?`,
    ).run(
      d.status,
      d.issues ? JSON.stringify(d.issues) : null,
      d.result ? JSON.stringify(d.result) : null,
      d.decidedAt,
      d.decidedBy,
      d.note ?? null,
      id,
    )
  }

  // ---------- read models ----------

  countsAt(
    projectId: string,
    rev: number,
  ): { objects: Record<string, number>; relations: Record<string, number>; evidence: number } {
    const objects = this.#stmt(
      `SELECT type, count(*) AS n FROM object_versions WHERE project_id = @p AND ${CURRENT_AT} AND lifecycle = 'active' GROUP BY type ORDER BY type`,
    ).all({ p: projectId, rev }) as Row[]
    const relations = this.#stmt(
      `SELECT type, count(*) AS n FROM relation_versions WHERE project_id = @p AND ${CURRENT_AT} AND lifecycle = 'active' GROUP BY type ORDER BY type`,
    ).all({ p: projectId, rev }) as Row[]
    const evidence = this.#stmt(
      'SELECT count(*) AS n FROM evidence WHERE project_id = ? AND revision <= ?',
    ).get(projectId, rev) as Row
    return {
      objects: Object.fromEntries(objects.map((r) => [str(r.type), num(r.n)])),
      relations: Object.fromEntries(relations.map((r) => [str(r.type), num(r.n)])),
      evidence: num(evidence.n),
    }
  }

  history(projectId: string, limit: number): ChangeSetSummary[] {
    const rows = this.#stmt(
      'SELECT * FROM change_sets WHERE project_id = ? ORDER BY revision DESC LIMIT ?',
    ).all(projectId, limit) as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      revision: num(r.revision),
      proposalId: str(r.proposal_id),
      proposedBy: str(r.proposed_by),
      committedBy: str(r.committed_by),
      origin: r.origin as InstructionOrigin,
      rebasedFrom:
        num(r.proposal_base_revision) === num(r.applied_on_revision)
          ? null
          : num(r.proposal_base_revision),
      committedAt: str(r.committed_at),
      writeCount: num(r.write_count),
    }))
  }

  /** Canonical dump of revisioned state, used to prove that event replay reproduces it (R3). */
  dumpRevisionedState(projectId: string): unknown {
    const q = (sql: string) => this.db.prepare(sql).all(projectId)
    return {
      project: this.db
        .prepare(
          'SELECT id, name, description, created_at, created_by, head_revision FROM projects WHERE id = ?',
        )
        .get(projectId),
      objects: q('SELECT * FROM object_versions WHERE project_id = ? ORDER BY id, rev_from'),
      relations: q('SELECT * FROM relation_versions WHERE project_id = ? ORDER BY id, rev_from'),
      evidence: q('SELECT * FROM evidence WHERE project_id = ? ORDER BY id'),
      changeSets: q('SELECT * FROM change_sets WHERE project_id = ? ORDER BY revision'),
    }
  }
}

class SqliteStateView implements StateView {
  readonly #store: SqliteStore
  readonly #projectId: string
  readonly revision: number

  constructor(store: SqliteStore, projectId: string, revision: number) {
    this.#store = store
    this.#projectId = projectId
    this.revision = revision
  }

  getObject(id: string) {
    return this.#store.getObjectAt(this.#projectId, id, this.revision)
  }
  getRelation(id: string) {
    return this.#store.getRelationAt(this.#projectId, id, this.revision)
  }
  getEvidence(id: string) {
    return this.#store.getEvidenceAt(this.#projectId, id, this.revision)
  }
  listObjects(filter: ObjectFilter) {
    return this.#store
      .objectsAt(this.#projectId, this.revision, { types: filter.types })
      .filter((o) => matchesObject(o, filter))
  }
  listRelations(filter: RelationFilter) {
    return this.#store.relationsAt(this.#projectId, this.revision, filter)
  }
}

function placeholders(
  prefix: string,
  values: readonly string[],
  params: Record<string, unknown>,
): string {
  return values
    .map((v, i) => {
      params[`${prefix}${i}`] = v
      return `@${prefix}${i}`
    })
    .join(', ')
}

function toProject(r: Row): ProjectSummary {
  return {
    id: str(r.id),
    name: str(r.name),
    description: str(r.description),
    createdAt: str(r.created_at),
    createdBy: str(r.created_by),
    headRevision: num(r.head_revision),
  }
}

function toObject(r: Row): ObjectVersion {
  return {
    id: str(r.id),
    type: str(r.type),
    typeVersion: num(r.type_version),
    stance: r.stance as ObjectVersion['stance'],
    lifecycle: r.lifecycle as ObjectVersion['lifecycle'],
    attributes: json(r.attributes),
    claim: json(r.claim),
    revision: num(r.rev_from),
    retiredReason: nstr(r.retired_reason),
  }
}

function toRelation(r: Row): RelationVersion {
  return {
    id: str(r.id),
    type: str(r.type),
    typeVersion: num(r.type_version),
    from: str(r.from_id),
    to: str(r.to_id),
    stance: r.stance as RelationVersion['stance'],
    lifecycle: r.lifecycle as RelationVersion['lifecycle'],
    properties: json(r.properties),
    claim: json(r.claim),
    revision: num(r.rev_from),
    retiredReason: nstr(r.retired_reason),
  }
}

function toEvidence(r: Row): EvidenceRecord {
  return {
    id: str(r.id),
    source: json(r.source),
    excerpt:
      r.excerpt_content_id === null
        ? null
        : { contentId: str(r.excerpt_content_id), sha256: str(r.excerpt_sha256) },
    collectedBy: json(r.collected_by),
    collectedAt: str(r.collected_at),
  }
}

function toProposal(r: Row): Proposal {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    baseRevision: num(r.base_revision),
    proposedBy: str(r.proposed_by),
    origin: r.origin as InstructionOrigin,
    ops: json(r.ops),
    rationale: str(r.rationale),
    readSet: json(r.read_set),
    writeSet: json(r.write_set),
    predicates: json(r.predicates),
    idempotencyKey: nstr(r.idempotency_key),
    status: r.status as ProposalStatus,
    issues: json(r.issues),
    result: r.result === null ? null : json(r.result),
    createdAt: str(r.created_at),
    decidedAt: nstr(r.decided_at),
    decidedBy: nstr(r.decided_by),
    decisionNote: nstr(r.decision_note),
  }
}

function toAgentToken(r: Row): Omit<AgentTokenSummary, 'scopes'> {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    principalId: str(r.principal_id),
    label: str(r.label),
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
    expiresAt: str(r.expires_at),
    revokedAt: nstr(r.revoked_at),
  }
}
