import { describe, expect, it } from 'vitest'
import { diffLineageVersions, versionDiffSummary } from '../src/client/lineage/version-diff.ts'

const base = {
  nodes: [
    { id: 'customer', label: '客户', type: 'class', properties: { description: 'a' } },
    { id: 'order', label: '订单', type: 'class' },
  ],
  edges: [{ id: 'e1', from: 'order', to: 'customer', rel_type: 'belongs_to' }],
}

describe('diffLineageVersions', () => {
  it('reports node and edge changes by stable ids', () => {
    const target = {
      nodes: [
        { id: 'customer', label: '客户', type: 'class', properties: { description: 'b' } },
        { id: 'contract', label: '合同', type: 'class' },
      ],
      edges: [
        { id: 'e1', from: 'contract', to: 'customer', rel_type: 'belongs_to' },
        { id: 'e2', from: 'contract', to: 'customer', rel_type: 'signed_by' },
      ],
    }
    const diff = diffLineageVersions(base, target)
    expect(diff.addedNodes).toBe(1)
    expect(diff.removedNodes).toBe(1)
    expect(diff.changedNodes).toBe(1)
    expect(diff.addedEdges).toBe(1)
    expect(diff.changedEdges).toBe(1)
    expect(diff.changes.find((change) => change.kind === 'edge' && change.id === 'e1')?.label).toBe('合同 → 客户')
    expect(versionDiffSummary(diff)).toContain('+1 类')
  })

  it('treats equal graphs as unchanged', () => {
    const diff = diffLineageVersions(base, structuredClone(base))
    expect(versionDiffSummary(diff)).toBe('无结构差异')
  })
})
