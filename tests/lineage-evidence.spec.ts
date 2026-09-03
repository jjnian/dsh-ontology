import { describe, expect, it } from 'vitest'
import { evidenceTexts, mergeEvidence } from '../src/client/lineage/lineage-types.ts'

describe('lineage evidence', () => {
  it('reads legacy evidence and multi-source evidence', () => {
    const texts = evidenceTexts({
      evidence: 'schema.sql',
      evidences: [
        { id: 'e1', type: 'ddl', summary: 'schema.sql' },
        { id: 'e2', type: 'sql', summary: 'INSERT...SELECT', detail: 'warehouse.sql' },
      ],
    })
    expect(texts).toEqual(['schema.sql', 'INSERT...SELECT', 'warehouse.sql'])
  })

  it('merges evidence without duplicates', () => {
    const merged = mergeEvidence(
      { evidence: 'schema.sql', evidences: undefined },
      {
        evidence: 'schema.sql',
        evidences: [{ id: 'e1', type: 'ddl', summary: 'schema.sql' }],
      },
    )
    expect(merged.evidences).toHaveLength(1)
    expect(evidenceTexts(merged)).toEqual(['schema.sql'])
  })
})
