import { describe, expect, it } from 'vitest'
import { applyLineagePatch, validateLineagePatch } from '../src/client/lineage/lineage-patch.ts'

const graph = {
  nodes: [{ id: 'a', label: 'A', type: 'class' }],
  edges: [],
}

describe('applyLineagePatch', () => {
  it('adds a node and an edge in one transaction', () => {
    const result = applyLineagePatch(graph, {
      reason: '补充订单实体',
      ops: [
        { op: 'upsert_node', node: { id: 'order', label: '订单', type: 'class' } },
        { op: 'add_edge', edge: { id: 'e1', from: 'order', to: 'a', rel_type: 'depends_on' } },
      ],
    })
    expect(result.summary).toEqual({
      addedNodes: 1,
      updatedNodes: 0,
      deletedNodes: 0,
      addedEdges: 1,
      updatedEdges: 0,
      deletedEdges: 0,
      failed: [],
    })
    expect(result.graph.nodes).toHaveLength(2)
    expect(result.graph.edges[0]?.properties?.patchHistory).toHaveLength(1)
  })

  it('merges duplicate instances and redirects their edges', () => {
    const instanceGraph = {
      nodes: [
        {
          id: 'class:customer',
          label: '客户',
          type: 'class',
        },
        {
          id: 'instance:old',
          label: '重复客户',
          type: 'entity',
          properties: {
            values: { name: '重复客户', phone: '138' },
            sourceBindings: [{ connectionId: 'mysql-1', objectName: 'customer' }],
          },
          evidences: [{ id: 'e1', type: 'database', summary: 'MySQL customer' }],
        },
        {
          id: 'instance:main',
          label: '客户',
          type: 'entity',
          properties: {
            values: { name: '客户' },
            sourceBindings: [{ connectionId: 'mysql-2', objectName: 'customer' }],
          },
        },
      ],
      edges: [
        { id: 'old-class', from: 'instance:old', to: 'class:customer', rel_type: 'instance_of' },
        { id: 'old-order', from: 'order', to: 'instance:old', rel_type: 'belongs_to' },
      ],
    }
    const result = applyLineagePatch(instanceGraph, {
      reason: '合并重复实例',
      ops: [{ op: 'merge_instance', sourceId: 'instance:old', targetId: 'instance:main' }],
    })

    expect(result.summary.updatedNodes).toBe(1)
    expect(result.summary.deletedNodes).toBe(1)
    expect(result.graph.nodes.find((node) => node.id === 'instance:old')).toBeUndefined()
    const merged = result.graph.nodes.find((node) => node.id === 'instance:main')
    expect(merged?.properties?.values).toEqual({ name: '重复客户', phone: '138' })
    expect(merged?.properties?.mergedFrom).toEqual(['instance:old'])
    expect(merged?.properties?.sourceBindings).toHaveLength(2)
    expect(merged?.evidences).toHaveLength(1)
    expect(result.graph.edges.find((edge) => edge.id === 'old-order')?.to).toBe('instance:main')
    const classEdge = result.graph.edges.find((edge) => edge.id === 'old-class')
    expect(classEdge?.from).toBe('instance:main')
    expect(classEdge?.to).toBe('class:customer')
  })

  it('attaches and rejects duplicate source mappings', () => {
    const graphWithMapping = {
      nodes: [
        {
          id: 'class:customer',
          label: '客户',
          type: 'class',
          properties: {
            sourceBindings: [{ connectionId: 'mysql-1', database: 'crm', objectName: 'customer' }],
          },
        },
      ],
      edges: [],
    }
    const added = applyLineagePatch(graphWithMapping, {
      ops: [{
        op: 'set_mapping',
        id: 'class:customer',
        mapping: { connectionId: 'pgsql-1', database: 'crm', objectName: 't_customer' },
      }],
    })
    expect(added.summary.updatedNodes).toBe(1)
    const bindings = added.graph.nodes[0]?.properties?.sourceBindings as Record<string, unknown>[]
    const binding = bindings?.[1]
    expect(binding?.reviewStatus).toBe('pending')

    const failed = applyLineagePatch(added.graph, {
      ops: [{
        op: 'set_mapping',
        id: 'class:customer',
        mapping: { connectionId: 'pgsql-1', database: 'crm', objectName: 't_customer' },
      }],
    })
    expect(failed.summary.failed[0]?.message).toBe('数据源映射已存在')
    expect(failed.graph).toEqual(added.graph)
  })

  it('rolls back all operations when any operation fails', () => {
    const result = applyLineagePatch(graph, {
      ops: [
        { op: 'upsert_node', node: { id: 'order', label: '订单', type: 'class' } },
        { op: 'add_edge', edge: { id: 'bad', from: 'order', to: 'missing', rel_type: 'depends_on' } },
      ],
    })
    expect(result.graph).toEqual(graph)
    expect(result.summary.failed).toHaveLength(1)
    expect(result.summary.failed[0]?.message).toContain('missing')
  })
})

describe('validateLineagePatch', () => {
  it('reports malformed operations without throwing', () => {
    const result = validateLineagePatch({
      ops: [
        { op: 'upsert_node', node: { label: 'missing id' } },
        { op: 'nonsense' },
      ],
    })
    expect(result.patch.ops).toHaveLength(0)
    expect(result.issues).toHaveLength(2)
  })
})
