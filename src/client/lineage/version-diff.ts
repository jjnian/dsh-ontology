import type { LineageGraph, LineageNode, LineageEdge } from './lineage-types.ts'

export interface LineageVersionChange {
  kind: 'node' | 'edge'
  id: string
  label: string
  action: 'added' | 'removed' | 'changed'
  fields: string[]
}

export interface LineageVersionDiff {
  addedNodes: number
  removedNodes: number
  changedNodes: number
  addedEdges: number
  removedEdges: number
  changedEdges: number
  changes: LineageVersionChange[]
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_, item) => item)
}

function fieldsChanged(left: Record<string, unknown>, right: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((key) => stable(left[key]) !== stable(right[key]))
}

function edgeLabel(edge: LineageEdge, nodes: Map<string, LineageNode>): string {
  const from = nodes.get(edge.from)?.label ?? edge.from
  const to = nodes.get(edge.to)?.label ?? edge.to
  return `${from} → ${to}`
}

export function diffLineageVersions(
  base: LineageGraph,
  target: LineageGraph,
): LineageVersionDiff {
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]))
  const targetNodes = new Map(target.nodes.map((node) => [node.id, node]))
  const baseEdges = new Map(base.edges.map((edge) => [edge.id, edge]))
  const targetEdges = new Map(target.edges.map((edge) => [edge.id, edge]))
  const changes: LineageVersionChange[] = []

  for (const node of target.nodes) {
    if (!baseNodes.has(node.id)) changes.push({ kind: 'node', id: node.id, label: node.label, action: 'added', fields: [] })
  }
  for (const node of base.nodes) {
    const next = targetNodes.get(node.id)
    if (next === undefined) {
      changes.push({ kind: 'node', id: node.id, label: node.label, action: 'removed', fields: [] })
      continue
    }
    const fields = fieldsChanged(node as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, [
      'label', 'type', 'domain', 'source', 'confidence', 'properties', 'evidence', 'evidences',
    ])
    if (fields.length > 0) changes.push({ kind: 'node', id: node.id, label: node.label, action: 'changed', fields })
  }

  for (const edge of target.edges) {
    if (!baseEdges.has(edge.id)) changes.push({ kind: 'edge', id: edge.id, label: edgeLabel(edge, targetNodes), action: 'added', fields: [] })
  }
  for (const edge of base.edges) {
    const next = targetEdges.get(edge.id)
    if (next === undefined) {
      changes.push({ kind: 'edge', id: edge.id, label: edgeLabel(edge, baseNodes), action: 'removed', fields: [] })
      continue
    }
    const fields = fieldsChanged(edge as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, [
      'from', 'to', 'label', 'rel_type', 'source', 'confidence', 'properties', 'evidence', 'evidences',
    ])
    if (fields.length > 0) changes.push({ kind: 'edge', id: edge.id, label: edgeLabel(next, targetNodes), action: 'changed', fields })
  }

  const count = (kind: LineageVersionChange['kind'], action: LineageVersionChange['action']): number =>
    changes.filter((change) => change.kind === kind && change.action === action).length

  return {
    addedNodes: count('node', 'added'),
    removedNodes: count('node', 'removed'),
    changedNodes: count('node', 'changed'),
    addedEdges: count('edge', 'added'),
    removedEdges: count('edge', 'removed'),
    changedEdges: count('edge', 'changed'),
    changes: changes.slice(0, 80),
  }
}

export function versionDiffSummary(diff: LineageVersionDiff): string {
  const parts = [
    ...(diff.addedNodes > 0 ? [`+${diff.addedNodes} 类`] : []),
    ...(diff.removedNodes > 0 ? [`-${diff.removedNodes} 类`] : []),
    ...(diff.changedNodes > 0 ? [`~${diff.changedNodes} 类`] : []),
    ...(diff.addedEdges > 0 ? [`+${diff.addedEdges} 关系`] : []),
    ...(diff.removedEdges > 0 ? [`-${diff.removedEdges} 关系`] : []),
    ...(diff.changedEdges > 0 ? [`~${diff.changedEdges} 关系`] : []),
  ]
  return parts.join(' · ') || '无结构差异'
}
