import { describe, expect, it } from 'vitest'
import { analyzeLineageImpact } from '../src/client/lineage/graph-analysis.ts'
import { findLineagePaths, lineageHealth, traceLineage } from '../src/client/lineage/graph-analysis.ts'
import type { LineageGraph } from '../src/client/lineage/lineage-types.ts'

describe('graph analysis', () => {
  const graph: LineageGraph = {
    nodes: [
      { id: 'ods', label: 'ods_order', type: 'class' },
      { id: 'dwd', label: 'dwd_order', type: 'class' },
      { id: 'dws', label: 'dws_order', type: 'class' },
      { id: 'orphan', label: 'orphan', type: 'class' },
    ],
    edges: [
      { id: 'e1', from: 'ods', to: 'dwd', rel_type: 'flows_to', source: 'derived', evidence: 'sql' },
      { id: 'e2', from: 'dwd', to: 'dws', rel_type: 'flows_to', source: 'derived', evidence: 'sql' },
    ],
  }

  it('traces semantic lineage through forward and backward relations', () => {
    const upstream = traceLineage(graph, 'dws')
    const downstream = traceLineage(graph, 'ods')
    expect(upstream.upstream).toEqual(['dwd', 'ods'])
    expect(downstream.downstream).toEqual(['dwd', 'dws'])
  })

  it('finds lineage paths and reports health issues', () => {
    expect(findLineagePaths(graph, 'ods', 'dws').map((path) => path.nodeIds)).toEqual([['ods', 'dwd', 'dws']])
    const health = lineageHealth(graph)
    expect(health.isolatedNodes).toBe(1)
    expect(health.pendingReviews).toBe(0)
    expect(health.issues.some((issue) => issue.includes('孤立节点'))).toBe(true)
  })
})

describe('lineage impact', () => {
  it('reports removed edges, orphans, and remaining graph components', () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'A', type: 'class' },
        { id: 'b', label: 'B', type: 'class' },
        { id: 'c', label: 'C', type: 'class' },
        { id: 'd', label: 'D', type: 'class' },
      ],
      edges: [
        { id: 'ab', from: 'a', to: 'b', rel_type: 'flows_to' },
        { id: 'bc', from: 'b', to: 'c', rel_type: 'flows_to' },
      ],
    }
    const impact = analyzeLineageImpact(graph, new Set(['b']), new Set())
    expect(impact.removedEdges).toEqual(['ab', 'bc'])
    expect(impact.orphanedNodes).toEqual(['a', 'c', 'd'])
    expect(impact.disconnectedComponents).toBe(3)
  })
})
