import { createHash } from 'node:crypto'
import type { Caller, ObjectVersion, Result } from '@kalyth/contracts'
import { ensureLocalOwner, ensurePrincipal, KalythServices, SqliteStore } from '@kalyth/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AnalysisResult,
  analyzeRepository,
  GitRepository,
  ingestRepository,
} from '../src/index.ts'
import { FixtureRepo } from './fixture-repo.ts'

// A small FastAPI and SQLModel application covering the data-access heuristics of ADR 0021.
const lines = (...l: string[]) => `${l.join('\n')}\n`
const ITEMS_V1 = lines(
  'import uuid',
  'from typing import Annotated',
  '',
  'from fastapi import APIRouter, Cookie, Header, HTTPException',
  'from sqlmodel import func, select',
  'from somelib import External',
  '',
  'from app import crud',
  'from app.api.deps import CurrentUser, SessionDep',
  'from app.models import Item, ItemCreate, Sort',
  '',
  'router = APIRouter(prefix="/items", tags=["items"])',
  '',
  '',
  '@router.get("/")',
  'def read_items(session: SessionDep, skip: int = 0, limit: int = 100, sort: Sort = Sort.asc):',
  '    count = session.exec(select(func.count()).select_from(Item)).one()',
  '    return session.exec(select(Item).offset(skip).limit(limit)).all()',
  '',
  '',
  '@router.get("/{id}")',
  'def read_item(',
  '    session: SessionDep,',
  '    id: uuid.UUID,',
  '    x_trace: str | None = Header(None),',
  '    token: Annotated[str | None, Cookie()] = None,',
  ') -> Item:',
  '    item = session.get(Item, id)',
  '    if not item:',
  '        raise HTTPException(status_code=404)',
  '    return item',
  '',
  '',
  '@router.post("/")',
  'def create_item(',
  '    *, session: SessionDep, current_user: CurrentUser, item_in: ItemCreate, tags: list[str], extra: External',
  '):',
  '    item = Item.model_validate(item_in, update={"owner_id": current_user.id})',
  '    session.add(item)',
  '    session.commit()',
  '    return item',
  '',
  '',
  '@router.put("/{id}")',
  'def update_item(*, session: SessionDep, id: uuid.UUID, data: dict) -> Item:',
  '    item = session.get(Item, id)',
  '    return crud.update_item(session=session, item=item, data=data)',
  '',
  '',
  '@router.delete("/{id}")',
  'def delete_item(session: SessionDep, id: uuid.UUID) -> None:',
  '    item = session.get(Item, id)',
  '    session.delete(item)',
  '    session.commit()',
  '',
  '',
  '@router.post("/audit")',
  'def audit_items(session: SessionDep) -> None:',
  '    crud.audit(session)',
)

const APP: Record<string, string> = {
  'backend/pyproject.toml': '[project]\nname = "app"\nversion = "0.1.0"\n',
  'backend/app/__init__.py': '',
  'backend/app/api/__init__.py': '',
  'backend/app/api/routes/__init__.py': '',
  'backend/app/models.py': lines(
    'import uuid',
    'from enum import Enum',
    '',
    'from sqlmodel import Field, Relationship, SQLModel',
    '',
    '',
    'class Sort(str, Enum):',
    '    asc = "asc"',
    '    desc = "desc"',
    '',
    '',
    'class Team(SQLModel, table=True):',
    '    __tablename__ = "teams"',
    '    id: int | None = Field(default=None, primary_key=True)',
    '',
    '',
    'class UserCreate(SQLModel):',
    '    email: str',
    '',
    '',
    'class User(SQLModel, table=True):',
    '    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)',
    '    email: str',
    '    team_id: int | None = Field(default=None, foreign_key="teams.id")',
    '    items: list["Item"] = Relationship(back_populates="owner")',
    '',
    '',
    'class ItemCreate(SQLModel):',
    '    title: str',
    '',
    '',
    'class Item(SQLModel, table=True):',
    '    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)',
    '    title: str',
    '    owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False)',
    '    owner: User | None = Relationship(back_populates="items")',
  ),
  'backend/app/api/deps.py': lines(
    'from typing import Annotated',
    '',
    'from fastapi import Depends',
    'from sqlmodel import Session',
    '',
    'from app.models import User',
    '',
    '',
    'def get_db():',
    '    yield None',
    '',
    '',
    'SessionDep = Annotated[Session, Depends(get_db)]',
    '',
    '',
    'def get_current_user(session: SessionDep) -> User:',
    '    return session.get(User, 1)',
    '',
    '',
    'CurrentUser = Annotated[User, Depends(get_current_user)]',
  ),
  'backend/app/crud.py': lines(
    'from sqlmodel import Session, select',
    '',
    'from app.models import Item, User, UserCreate',
    '',
    '',
    'def create_user(*, session: Session, user_create: UserCreate) -> User:',
    '    db_obj = User.model_validate(user_create)',
    '    session.add(db_obj)',
    '    session.commit()',
    '    return db_obj',
    '',
    '',
    'def get_user_by_email(*, session: Session, email: str) -> User | None:',
    '    return session.exec(select(User).where(User.email == email)).first()',
    '',
    '',
    'def update_item(*, session: Session, item: Item, data: dict) -> Item:',
    '    item.sqlmodel_update(data)',
    '    session.add(item)',
    '    return item',
    '',
    '',
    'def register(*, session: Session, user_create: UserCreate) -> User:',
    '    return create_user(session=session, user_create=user_create)',
    '',
    '',
    'def audit(session: Session) -> None:',
    '    level_two(session)',
    '',
    '',
    'def level_two(session: Session) -> None:',
    '    level_three(session)',
    '',
    '',
    'def level_three(session: Session) -> None:',
    '    session.add(Item(title="audit"))',
  ),
  'backend/app/api/routes/items.py': ITEMS_V1,
  'backend/app/api/routes/users.py': lines(
    'from fastapi import APIRouter',
    'from sqlmodel import delete, select',
    '',
    'from app import crud',
    'from app.api.deps import CurrentUser, SessionDep',
    'from app.crud import register',
    'from app.models import Item, User, UserCreate',
    '',
    'router = APIRouter(prefix="/users", tags=["users"])',
    '',
    '',
    '@router.post("/")',
    'def create_user(session: SessionDep, user_in: UserCreate) -> User:',
    '    if crud.get_user_by_email(session=session, email=user_in.email):',
    '        return None',
    '    return crud.create_user(session=session, user_create=user_in)',
    '',
    '',
    '@router.post("/signup")',
    'def signup(session: SessionDep, user_in: UserCreate) -> User:',
    '    return register(session=session, user_create=user_in)',
    '',
    '',
    '@router.get("/me")',
    'def read_me(current_user: CurrentUser) -> User:',
    '    return current_user',
    '',
    '',
    '@router.delete("/me")',
    'def delete_me(session: SessionDep, current_user: CurrentUser) -> None:',
    '    session.exec(delete(Item).where(Item.owner_id == current_user.id))',
    '    session.delete(current_user)',
    '',
    '',
    '@router.post("/seen")',
    'def remember(current_user: CurrentUser) -> int:',
    '    seen = set()',
    '    seen.add(current_user)',
    '    return len(seen)',
    '',
    '',
    '@router.delete("/")',
    'def purge(session: SessionDep) -> None:',
    '    for user in session.exec(select(User)).all():',
    '        session.delete(user)',
  ),
  'backend/app/api/routes/utils.py': lines(
    'from fastapi import APIRouter',
    '',
    'router = APIRouter(prefix="/utils", tags=["utils"])',
    '',
    '',
    '@router.get("/health-check/")',
    'def health_check() -> bool:',
    '    return True',
  ),
  'backend/app/api/main.py': lines(
    'from fastapi import APIRouter',
    '',
    'from app.api.routes import items, users, utils',
    '',
    'api_router = APIRouter()',
    'api_router.include_router(items.router)',
    'api_router.include_router(users.router)',
    'api_router.include_router(utils.router)',
  ),
  'backend/app/main.py': lines(
    'from fastapi import FastAPI',
    '',
    'from app.api.main import api_router',
    '',
    'app = FastAPI()',
    'app.include_router(api_router, prefix="/api/v1")',
  ),
}

/** Version 2: an agent adds a `q` filter to the item listing; nothing else changes. */
const ITEMS_V2 = ITEMS_V1.replace(
  'sort: Sort = Sort.asc):',
  'sort: Sort = Sort.asc, q: str | None = None):',
)

const REPO = 'example.org/data-app'
const ep = (method: string, path: string) => `endpoint:${method} /api/v1${path}`
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

let fixture: FixtureRepo
let v1: string
let v2: string
let result: AnalysisResult
beforeAll(async () => {
  fixture = new FixtureRepo()
  fixture.write(APP)
  v1 = fixture.commit('v1')
  fixture.write({ 'backend/app/api/routes/items.py': ITEMS_V2 })
  v2 = fixture.commit('v2: filter items by q')
  result = await analyzeRepository({ git: new GitRepository(fixture.path), repo: REPO, ref: v1 })
})
afterAll(() => fixture?.dispose())

const relation = (type: string, from: string, to: string) =>
  result.relations.find((r) => r.key === `${type}|${from}|${to}`)
const relationsFrom = (from: string, types = ['reads', 'writes']) =>
  result.relations
    .filter((r) => r.from === from && types.includes(r.type))
    .map((r) => `${r.type} ${r.to}`)
    .sort()
/** Each support group as "path#symbol" entries, in the order they are cited. */
const groups = (type: string, from: string, to: string) =>
  relation(type, from, to)?.supports.map((g) => g.map((s) => `${s.path}#${s.symbol}`))

describe('entity fields', () => {
  it('records each field with its annotation, the key it holds and its relationship', () => {
    const user = result.objects.find((o) => o.key === 'entity:User')
    expect(user?.attributes.fields).toEqual([
      { name: 'id', type: 'uuid.UUID' },
      { name: 'email', type: 'str' },
      { name: 'team_id', type: 'int | None', references: 'teams.id' },
      { name: 'items', type: 'list[Item]', relationship: 'list[Item]' },
    ])
    const item = result.objects.find((o) => o.key === 'entity:Item')
    expect(item?.attributes.fields).toContainEqual({
      name: 'owner_id',
      type: 'uuid.UUID',
      references: 'user.id',
    })
  })
})

describe('data access from route handlers (ADR 0021)', () => {
  it('reads entities named in select, select_from and session.get', () => {
    expect(relationsFrom(ep('GET', '/items/'))).toEqual(['reads entity:Item'])
    expect(relationsFrom(ep('GET', '/items/{id}'))).toEqual(['reads entity:Item'])
    expect(groups('reads', ep('GET', '/items/{id}'), 'entity:Item')).toEqual([
      ['backend/app/api/routes/items.py#read_item'],
    ])
    expect(relationsFrom(ep('GET', '/utils/health-check/'))).toEqual([])
  })

  it('writes entities that are built and added, deleted, updated or targeted by a statement', () => {
    expect(relationsFrom(ep('POST', '/items/'))).toEqual(['writes entity:Item'])
    expect(relationsFrom(ep('DELETE', '/items/{id}'))).toEqual([
      'reads entity:Item',
      'writes entity:Item',
    ])
    // delete(Item) is a statement; session.delete(current_user) writes a User because the
    // CurrentUser alias says so, and the alias is cited with the handler.
    expect(relationsFrom(ep('DELETE', '/users/me'))).toEqual([
      'writes entity:Item',
      'writes entity:User',
    ])
    expect(groups('writes', ep('DELETE', '/users/me'), 'entity:User')).toEqual([
      ['backend/app/api/routes/users.py#delete_me', 'backend/app/api/deps.py#CurrentUser'],
    ])
  })

  it('follows calls into repository functions one and two levels deep, citing each one', () => {
    expect(relationsFrom(ep('PUT', '/items/{id}'))).toEqual([
      'reads entity:Item',
      'writes entity:Item',
    ])
    expect(groups('writes', ep('PUT', '/items/{id}'), 'entity:Item')).toEqual([
      ['backend/app/api/routes/items.py#update_item', 'backend/app/crud.py#update_item'],
    ])
    expect(relationsFrom(ep('POST', '/users/'))).toEqual([
      'reads entity:User',
      'writes entity:User',
    ])
    expect(groups('reads', ep('POST', '/users/'), 'entity:User')).toEqual([
      ['backend/app/api/routes/users.py#create_user', 'backend/app/crud.py#get_user_by_email'],
    ])
    expect(groups('writes', ep('POST', '/users/signup'), 'entity:User')).toEqual([
      [
        'backend/app/api/routes/users.py#signup',
        'backend/app/crud.py#register',
        'backend/app/crud.py#create_user',
      ],
    ])
    // audit → level_two → level_three is one call deeper than followed.
    expect(relationsFrom(ep('POST', '/items/audit'))).toEqual([])
    expect(result.stats.unfollowedCalls).toBe(1)
    expect(result.limitations.join('; ')).toContain('whose own calls were not followed')
  })

  it('says nothing when it is unsure', () => {
    // FastAPI dependencies are not followed, untyped loop variables are not tracked, and a set's
    // add is not a session's.
    expect(relationsFrom(ep('GET', '/users/me'))).toEqual([])
    expect(relationsFrom(ep('POST', '/users/seen'))).toEqual([])
    expect(relationsFrom(ep('DELETE', '/users/'))).toEqual(['reads entity:User'])
  })

  it('records references between entities from foreign keys and scalar relationships', () => {
    expect(groups('references', 'entity:Item', 'entity:User')).toEqual([
      ['backend/app/models.py#Item.owner_id'],
      ['backend/app/models.py#Item.owner'],
    ])
    // __tablename__ names the target table; the collection side adds no reverse reference.
    expect(groups('references', 'entity:User', 'entity:Team')).toEqual([
      ['backend/app/models.py#User.team_id'],
    ])
    expect(relation('references', 'entity:User', 'entity:Item')).toBeUndefined()
    expect(result.stats.referencesRelations).toBe(2)
  })

  it('pins the new evidence to the exact text of each span', () => {
    const spans = result.relations
      .filter((r) => ['reads', 'writes', 'references'].includes(r.type))
      .flatMap((r) => r.supports.flat())
    expect(spans.length).toBeGreaterThan(20)
    for (const span of spans) {
      expect(span.blobSha).toBe(fixture.blob(v1, span.path))
      const text = fixture
        .show(v1, span.path)
        .split(/\r?\n/)
        .slice(span.startLine - 1, span.endLine)
        .join('\n')
      expect(span.spanSha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
      expect(span.excerpt).toBe(text)
    }
  })
})

describe('endpoint parameters (ADR 0021)', () => {
  const parameters = (key: string) =>
    result.objects.find((o) => o.key === key)?.attributes.parameters

  it('classifies parameters the way FastAPI does and leaves dependencies out', () => {
    expect(parameters(ep('GET', '/items/'))).toEqual([
      { name: 'skip', in: 'query', type: 'int' },
      { name: 'limit', in: 'query', type: 'int' },
      { name: 'sort', in: 'query', type: 'Sort' },
    ])
    expect(parameters(ep('GET', '/items/{id}'))).toEqual([
      { name: 'id', in: 'path', type: 'uuid.UUID' },
      { name: 'x_trace', in: 'header', type: 'str | None' },
      { name: 'token', in: 'cookie', type: 'Annotated[str | None, Cookie()]' },
    ])
    expect(parameters(ep('POST', '/items/'))).toEqual([
      { name: 'item_in', in: 'body', type: 'ItemCreate' },
      { name: 'tags', in: 'body', type: 'list[str]' },
      { name: 'extra', in: 'unknown', type: 'External' },
    ])
    expect(parameters(ep('PUT', '/items/{id}'))).toEqual([
      { name: 'id', in: 'path', type: 'uuid.UUID' },
      { name: 'data', in: 'body', type: 'dict' },
    ])
    expect(parameters(ep('GET', '/users/me'))).toEqual([])
  })
})

describe('ingest of data access', () => {
  function project() {
    const services = new KalythServices({ store: new SqliteStore(':memory:') })
    const owner: Caller = { principalId: ensureLocalOwner(services).id, origin: 'human' }
    const analyzer = ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
      'project.read',
      'proposal.create',
      'ingest.observed',
    ])
    const projectId = unwrap(services.createProject(owner, { name: 'Data app' })).id
    const ingest = (ref: string) =>
      ingestRepository({
        services,
        caller: { principalId: analyzer.id, origin: 'tool' },
        projectId,
        git: new GitRepository(fixture.path),
        repo: REPO,
        ref,
      })
    return { services, owner, projectId, ingest }
  }

  it('lands observed access relations, re-ingests idempotently and shows a new parameter', async () => {
    const p = project()
    await p.ingest(v1)
    const count = () => {
      const relations = unwrap(
        p.services.queryRelations(p.owner, {
          projectId: p.projectId,
          types: ['reads', 'writes', 'references'],
        }),
      ).relations
      return relations.length
    }
    expect(count()).toBe(
      (result.stats.readsRelations ?? 0) +
        (result.stats.writesRelations ?? 0) +
        (result.stats.referencesRelations ?? 0),
    )
    const freshness = unwrap(p.services.assessFreshness(p.owner, { projectId: p.projectId }))
    expect(Object.keys(freshness.summary)).toEqual(['current'])
    expect(await p.ingest(v1)).toMatchObject({ proposalId: null })

    const second = await p.ingest(v2)
    expect(second.stats.created).toBe(0)
    const listing = unwrap(
      p.services.queryObjects(p.owner, { projectId: p.projectId, types: ['software.Endpoint'] }),
    ).objects.find(
      (o: ObjectVersion) => o.attributes.path === '/api/v1/items/' && o.attributes.method === 'GET',
    )
    expect(listing?.attributes.parameters).toContainEqual({
      name: 'q',
      in: 'query',
      type: 'str | None',
    })
    expect(listing?.revision).toBe(second.revision)
    expect(count()).toBe(
      (result.stats.readsRelations ?? 0) +
        (result.stats.writesRelations ?? 0) +
        (result.stats.referencesRelations ?? 0),
    )
    const after = unwrap(p.services.assessFreshness(p.owner, { projectId: p.projectId }))
    expect(Object.keys(after.summary)).toEqual(['current'])
  })
})
