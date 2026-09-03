import { describe, expect, it } from 'vitest'
import { evidenceSources, evidenceTexts, mergeEvidence } from '../src/client/lineage/lineage-types.ts'

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

  it('formats source provenance for files, databases, and inference', () => {
    const sources = evidenceSources({
      evidence: 'business rules',
      evidences: [
        { id: 'file', type: 'file', summary: 'orders', sourcePath: 'docs/orders.md' },
        { id: 'db', type: 'database', summary: 'customer table', connectionId: 'mysql', database: 'crm', objectName: 'customer' },
        { id: 'llm', type: 'llm', summary: 'inferred containment' },
      ],
    })
    expect(sources).toEqual([
      { id: 'file:file', icon: '📄', kind: '文件', label: 'orders.md', title: 'docs/orders.md' },
      { id: 'db:db', icon: '🗄️', kind: '数据库', label: 'crm.customer', title: 'customer table' },
      { id: 'llm:llm', icon: '✨', kind: 'LLM', label: 'LLM联想', title: 'inferred containment' },
      { id: 'legacy', icon: '🔗', kind: '佐证', label: 'business rules' },
    ])
  })
})
