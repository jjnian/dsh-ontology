import { describe, expect, it } from 'vitest'
import { DATABASE_COMPATIBILITY } from '../src/client/lineage/database-compatibility.ts'

describe('database compatibility', () => {
  it('declares supported engines and capabilities', () => {
    expect(DATABASE_COMPATIBILITY.map((item) => item.engine)).toEqual(['mysql', 'postgresql', 'dm'])
    for (const item of DATABASE_COMPATIBILITY) {
      expect(item.status).toBe('supported')
      expect(item.versions).not.toBe('')
      expect(item.features).toContain('ddl')
      expect(item.features).toContain('query')
      expect(item.notes.length).toBeGreaterThan(0)
    }
  })
})
