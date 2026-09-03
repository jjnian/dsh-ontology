import type { LineageEdge, LineageGraph } from './lineage-types.ts'

const FORWARD_LINEAGE = new Set(['flows_to', 'produces', 'triggers', 'precedes'])
const BACKWARD_LINEAGE = new Set(['depends_on', 'derives_from', 'consumes'])
const NON_LINEAGE = new Set(['associated_with', 'is_a', 'instance_of', 'attribute_of', 'equivalent_to', 'disjoint_with'])

export type LineageDirection = 'upstream' | 'downstream'

export interface LineageTrace {
  upstream: string[]
  downstream: string[]
  upstreamEdges: string[]
  downstreamEdges: string[]
}

function nextId(edge: LineageEdge, direction: LineageDirection): string | undefined {
  if (edge.rel_type !== undefined && NON_LINEAGE.has(edge.rel_type)) return undefined
  if (edge.rel_type !== undefined && FORWARD_LINEAGE.has(edge.rel_type)) {
    return direction === 'downstream' ? edge.to : edge.from
  }
  if (edge.rel_type !== undefined && BACKWARD_LINEAGE.has(edge.rel_type)) {
    return direction === 'downstream' ? edge.from : edge.to
  }
  return direction === 'downstream' ? edge.to : edge.from
}

/** Breadth-first trace over semantic lineage direction, not storage edge direction. */
export function traceLineage(graph: LineageGraph, seedId: string, maxDepth = 6): LineageTrace {
  const result: LineageTrace = { upstream: [], downstream: [], upstreamEdges: [], downstreamEdges: [] }
  const visit = (direction: LineageDirection, nodeKey: 'upstream' | 'downstream', edgeKey: 'upstreamEdges' | 'downstreamEdges'): void => {
    const queue: { id: string; depth: number }[] = [{ id: seedId, depth: 0 }]
    const visited = new Set([seedId])
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const edge of graph.edges) {
        const next = nextId(edge, direction)
        const boundary = direction === 'downstream' ? edge.from : edge.to
        if (next === undefined || boundary !== current.id || visited.has(next) || current.depth >= maxDepth) continue
        visited.add(next)
        result[nodeKey].push(next)
        result[edgeKey].push(edge.id)
        queue.push({ id: next, depth: current.depth + 1 })
      }
    }
  }
  visit('upstream', 'upstream', 'upstreamEdges')
  visit('downstream', 'downstream', 'downstreamEdges')
  return result
}

export interface SimplePath {
  nodeIds: string[]
  edgeIds: string[]
}

/** All simple semantic-lineage paths between two nodes, direction-aware and depth-bounded. */
export function findLineagePaths(graph: LineageGraph, fromId: string, toId: string, maxDepth = 6, maxPaths = 50): SimplePath[] {
  const paths: SimplePath[] = []
  const visit = (nodeId: string, nodePath: string[], edgePath: string[], visited: Set<string>): void => {
    if (paths.length >= maxPaths || nodePath.length - 1 > maxDepth) return
    if (nodeId === toId && nodePath.length > 1) {
      paths.push({ nodeIds: [...nodePath], edgeIds: [...edgePath] })
      return
    }
    for (const edge of graph.edges) {
      const next = nextId(edge, 'downstream')
      if (next === undefined || edge.from !== nodeId || visited.has(next)) continue
      visited.add(next)
      nodePath.push(next)
      edgePath.push(edge.id)
      visit(next, nodePath, edgePath, visited)
      nodePath.pop()
      edgePath.pop()
      visited.delete(next)
    }
  }
  visit(fromId, [fromId], [], new Set([fromId]))
  return paths
}

export interface LineageHealth {
  nodeCount: number
  edgeCount: number
  isolatedNodes: number
  evidenceCoverage: number
  inferredRatio: number
  pendingReviews: number
  components: number
  issues: string[]
}

export function lineageHealth(graph: LineageGraph): LineageHealth {
  const connected = new Set<string>()
  for (const edge of graph.edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }
  const isolatedNodes = graph.nodes.filter((node) => !connected.has(node.id)).length
  const evidenceCount = [...graph.nodes, ...graph.edges].filter((item) =>
    (item.evidence !== undefined && item.evidence !== '') || (item.evidences?.length ?? 0) > 0).length
  const totalItems = graph.nodes.length + graph.edges.length
  const inferredEdges = graph.edges.filter((edge) => edge.source === 'inferred' || edge.source === 'llm').length
  const pendingReviews = graph.edges.filter((edge) =>
    edge.properties?.reviewStatus !== 'confirmed'
    && (edge.source === 'inferred' || edge.source === 'llm' || (typeof edge.confidence === 'number' && edge.confidence < 0.7))).length

  const visited = new Set<string>()
  let components = 0
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue
    components += 1
    const stack = [node.id]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      for (const edge of graph.edges) {
        if (edge.from === current) stack.push(edge.to)
        if (edge.to === current) stack.push(edge.from)
      }
    }
  }

  const issues: string[] = []
  if (isolatedNodes > 0) issues.push(`${isolatedNodes} 个孤立节点`)
  if (pendingReviews > 0) issues.push(`${pendingReviews} 条待审核推断关系`)
  if (graph.edges.length > 0 && inferredEdges / graph.edges.length > 0.5) issues.push('推断关系占比超过 50%')
  if (components > 1) issues.push(`图谱有 ${components} 个连通分量`)

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    isolatedNodes,
    evidenceCoverage: totalItems === 0 ? 1 : evidenceCount / totalItems,
    inferredRatio: graph.edges.length === 0 ? 0 : inferredEdges / graph.edges.length,
    pendingReviews,
    components,
    issues,
  }
}

export interface LineageHighlight {
  nodes: Set<string>
  edges: Set<string>
  direction: Map<string, 'upstream' | 'downstream'>
}

export function highlightForTrace(trace: LineageTrace | null): LineageHighlight {
  const direction = new Map<string, 'upstream' | 'downstream'>()
  for (const id of trace?.upstream ?? []) direction.set(id, 'upstream')
  for (const id of trace?.downstream ?? []) direction.set(id, 'downstream')
  return {
    nodes: new Set(direction.keys()),
    edges: new Set([...(trace?.upstreamEdges ?? []), ...(trace?.downstreamEdges ?? [])]),
    direction,
  }
}

export interface LineageImpactAnalysis {
  removedNodes: string[]
  removedEdges: string[]
  orphanedNodes: string[]
  disconnectedComponents: number
  downstreamNodes: string[]
  upstreamNodes: string[]
  criticalNodes: string[]
}

/** Analyze what would disappear or become isolated if selected nodes/edges were removed. */
export function analyzeLineageImpact(
  graph: LineageGraph,
  removeNodeIds: ReadonlySet<string> = new Set(),
  removeEdgeIds: ReadonlySet<string> = new Set(),
): LineageImpactAnalysis {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const removedEdges = graph.edges.filter((edge) => removeEdgeIds.has(edge.id)
    || removeNodeIds.has(edge.from)
    || removeNodeIds.has(edge.to))
  const remainingEdges = graph.edges.filter((edge) => !removedEdges.includes(edge))
  const removedNodeIds = new Set([...removeNodeIds])
  const orphanedNodes = graph.nodes
    .filter((node) => !removeNodeIds.has(node.id)
      && !remainingEdges.some((edge) => edge.from === node.id || edge.to === node.id))
    .map((node) => node.id)

  const adjacency = new Map<string, string[]>()
  for (const edge of remainingEdges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
  }
  const visited = new Set<string>()
  let components = 0
  for (const node of graph.nodes) {
    if (removeNodeIds.has(node.id) || visited.has(node.id)) continue
    components += 1
    const stack = [node.id]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      stack.push(...(adjacency.get(current) ?? []))
    }
  }

  const connectedCount = new Map<string, number>()
  for (const edge of remainingEdges) {
    connectedCount.set(edge.from, (connectedCount.get(edge.from) ?? 0) + 1)
    connectedCount.set(edge.to, (connectedCount.get(edge.to) ?? 0) + 1)
  }
  const remainingNodeCount = graph.nodes.filter((node) => !removeNodeIds.has(node.id)).length
  const meanDegree = remainingEdges.length === 0 ? 0 : (remainingEdges.length * 2) / Math.max(1, remainingNodeCount)
  const criticalNodes = [...connectedCount.entries()]
    .filter(([id, degree]) => degree >= Math.max(2, meanDegree * 2) && !removeNodeIds.has(id))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([id]) => id)

  const downstream = new Set<string>()
  const upstream = new Set<string>()
  for (const nodeId of removeNodeIds) {
    for (const id of traceLineage(graph, nodeId, 12).downstream) downstream.add(id)
    for (const id of traceLineage(graph, nodeId, 12).upstream) upstream.add(id)
  }

  return {
    removedNodes: [...removeNodeIds],
    removedEdges: removedEdges.map((edge) => edge.id),
    orphanedNodes,
    disconnectedComponents: components,
    downstreamNodes: [...downstream].filter((id) => !removeNodeIds.has(id)),
    upstreamNodes: [...upstream].filter((id) => !removeNodeIds.has(id)),
    criticalNodes,
  }
}
