import { describe, expect, it } from 'vitest'
import { obj } from '../test/records.ts'
import { objectLabel } from './labels.ts'
import { searchObjects } from './search.ts'

describe('searching elements', () => {
  const modules = Array.from({ length: 12 }, (_, i) =>
    obj('software.Module', { path: `backend/app/api/routes/users_${i}.py` }),
  )
  const usersModule = obj('software.Module', { path: 'backend/app/api/routes/users.py' })
  const user = obj('software.DataEntity', { name: 'User' })
  const item = obj('software.DataEntity', { name: 'Item' })
  const objects = [...modules, usersModule, item, user]
  const labels = (query: string, limit = 8) =>
    searchObjects(objects, query, limit).map((o) => objectLabel(o))

  it('finds an entity by its name before the many modules that mention it', () => {
    expect(labels('user')[0]).toBe('User')
    expect(labels('Item')).toEqual(['Item'])
  })

  it('ranks a file name match above a match anywhere in the path', () => {
    const found = labels('users', 3)
    expect(found[0]).toBe('backend/app/api/routes/users.py')
  })

  it('finds a record by a pasted id, and leaves out excluded ones', () => {
    expect(searchObjects(objects, user.id, 8).map((o) => o.id)).toEqual([user.id])
    expect(searchObjects(objects, 'user', 8, new Set([user.id])).map((o) => o.id)).not.toContain(
      user.id,
    )
    expect(searchObjects(objects, '   ', 8)).toEqual([])
  })
})
