import { describe, expect, it } from 'vitest'
import { collapseLineageByDomain } from '../src/client/lineage/domain-collapse.ts'

describe('collapseLineageByDomain', () => {
  it('groups nodes by domain and aggregates cross-domain edges without mutating the source graph', () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'A', type: 'class', domain: '订单' },
        { id: 'b', label: 'B', type: 'class', domain: '订单' },
        { id: 'c', label: 'C', type: 'class', domain: '库存' },
        { id: 'd', label: 'D', type: 'entity' },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', rel_type: 'part_of' },
        { id: 'e2', from: 'b', to: 'c', rel_type: 'depends_on' },
        { id: 'e3', from: 'c', to: 'a', rel_type: 'produces' },
        { id: 'e4', from: 'd', to: 'a', rel_type: 'instance_of' },
      ],
    }
    const collapsed = collapseLineageByDomain(graph)
    expect(collapsed.groups.map((group) => group.label)).toEqual(['订单', '库存', '未分类'])
    expect(collapsed.nodes).toHaveLength(3)
    expect(collapsed.edges.map((edge) => edge.count)).toEqual([2, 1])
    expect(collapsed.edges[0]?.from).toBe('domain:订单')
    expect(collapsed.edges[0]?.to).toBe('domain:库存')
    expect(collapsed.membership.get('d')).toBe('未分类')
    expect(graph.nodes).toHaveLength(4)
  })

  it('expands one domain while keeping the other domains collapsed', () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'A', type: 'class', domain: '订单' },
        { id: 'b', label: 'B', type: 'class', domain: '库存' },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', label: '依赖', rel_type: 'depends_on' }],
    }
    const collapsed = collapseLineageByDomain(graph, new Set(['订单']))
    expect(collapsed.nodes.map((node) => node.id)).toEqual(['a', 'domain:库存'])
    expect(collapsed.edges).toHaveLength(1)
    expect(collapsed.edges[0]?.from).toBe('a')
    expect(collapsed.edges[0]?.to).toBe('domain:库存')
  })
})
