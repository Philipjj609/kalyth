import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AnalysisResult, analyzeRepository, GitRepository } from '../src/index.ts'
import { FixtureRepo } from './fixture-repo.ts'

// What larger repositories brought out: tutorial code and several services declare the same table
// and route names, and test code uses decorators named like HTTP methods.

const lines = (...l: string[]) => `${l.join('\n')}\n`
const app = (prefix: string) =>
  lines(
    'from fastapi import FastAPI',
    'from sqlmodel import Field, SQLModel',
    '',
    'app = FastAPI()',
    '',
    '',
    'class Hero(SQLModel, table=True):',
    '    id: int | None = Field(default=None, primary_key=True)',
    `    ${prefix}_name: str`,
    '',
    '',
    '@app.get("/heroes/")',
    'def read_heroes():',
    '    return []',
  )

let fixture: FixtureRepo
let result: AnalysisResult
beforeAll(async () => {
  fixture = new FixtureRepo()
  fixture.write({
    'pyproject.toml': '[project]\nname = "docs"\nversion = "0.1.0"\n',
    'docs_src/tutorial001.py': app('first'),
    'docs_src/tutorial002.py': app('second'),
    'app/models.py': lines(
      'from sqlmodel import Field, SQLModel',
      '',
      '',
      'class Team(SQLModel, table=True):',
      '    id: int | None = Field(default=None, primary_key=True)',
    ),
    'tests/test_notify.py': lines(
      'from unittest import mock',
      '',
      '',
      '@mock.patch("app.notify.send")',
      'def test_sends(send):',
      '    assert send',
    ),
  })
  const commit = fixture.commit('v1')
  result = await analyzeRepository({
    git: new GitRepository(fixture.path),
    repo: 'example.org/docs',
    ref: commit,
  })
})
afterAll(() => fixture?.dispose())

describe('names declared in more than one place', () => {
  it('keeps them apart by where they are declared, and a unique name keeps its plain key', () => {
    const entities = result.objects.filter((o) => o.type === 'software.DataEntity')
    expect(entities.map((o) => o.key).sort()).toEqual([
      'entity:Hero@docs_src/tutorial001.py',
      'entity:Hero@docs_src/tutorial002.py',
      'entity:Team',
    ])
    expect(entities.find((o) => o.key === 'entity:Team')?.attributes.scope).toBeUndefined()
    const endpoints = result.objects.filter((o) => o.type === 'software.Endpoint')
    expect(endpoints.map((o) => o.key).sort()).toEqual([
      'endpoint:GET /heroes/@docs_src/tutorial001.py:read_heroes',
      'endpoint:GET /heroes/@docs_src/tutorial002.py:read_heroes',
    ])
    // Each module contains its own entity, so no element is contained twice.
    const contained = result.relations.filter((r) => r.type === 'contains').map((r) => r.to)
    expect(new Set(contained).size).toBe(contained.length)
  })
})

describe('route decorators', () => {
  it('counts only decorators on a FastAPI app or router, not mock.patch', () => {
    const methods = result.objects
      .filter((o) => o.type === 'software.Endpoint')
      .map((o) => o.attributes.method)
    expect(methods).not.toContain('PATCH')
    expect(result.stats.decoratorsNotOnARouter).toBe(1)
  })
})
