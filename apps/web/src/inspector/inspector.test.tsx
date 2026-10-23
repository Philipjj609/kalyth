import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AttributeValues } from './AttributeValues.tsx'

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

describe('attribute values in the Inspector', () => {
  it('lists an entity’s fields one per line, in words, not as JSON', () => {
    const html = renderToStaticMarkup(
      <AttributeValues
        values={{
          name: 'Item',
          storage: 'SQL table (SQLModel)',
          fields: [
            { name: 'title', type: 'str', inheritedFrom: 'ItemBase' },
            { name: 'owner_id', type: 'uuid.UUID', references: 'user.id' },
            { name: 'owner', type: 'User | None', relationship: 'User | None' },
          ],
          fieldsOmitted: 3,
        }}
      />,
    )
    expect(html).not.toContain('{&quot;name')
    expect(text(html)).toContain(
      'fields (3) title str inherited from ItemBase owner_id uuid.UUID references user.id owner User | None relationship to User | None fieldsOmitted 3',
    )
  })

  it('reads a route’s parameters the same way, and keeps other values as JSON', () => {
    const html = renderToStaticMarkup(
      <AttributeValues
        values={{
          parameters: [{ name: 'skip', in: 'query', type: 'int' }],
          tags: ['items'],
        }}
      />,
    )
    expect(text(html)).toContain('parameters (1) skip int in query')
    expect(html).toContain('[&quot;items&quot;]')
  })
})
