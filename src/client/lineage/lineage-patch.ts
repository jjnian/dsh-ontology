import type { LineageEdge, LineageGraph, LineageNode } from './lineage-types.ts'

export type LineagePatchOperation =
  | { op: 'upsert_node'; node: Partial<LineageNode> & Pick<LineageNode, 'id'> }
  | { op: 'update_node'; id: string; patch: Partial<Omit<LineageNode, 'id'>> }
  | { op: 'delete_node'; id: string }
  | { op: 'add_edge'; edge: Partial<LineageEdge> & Pick<LineageEdge, 'from' | 'to'> }
  | { op: 'update_edge'; id: string; patch: Partial<Omit<LineageEdge, 'id'>> }
  | { op: 'delete_edge'; id: string }
  | { op: 'merge_instance'; sourceId: string; targetId: string }
  | { op: 'set_mapping'; id: string; mapping: Record<string, unknown> }

export interface LineagePatch {
  reason?: string
  ops: LineagePatchOperation[]
}

export interface LineagePatchIssue {
  index: number
  message: string
}

export interface LineagePatchSummary {
  addedNodes: number
  updatedNodes: number
  deletedNodes: number
  addedEdges: number
  updatedEdges: number
  deletedEdges: number
  failed: LineagePatchIssue[]
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function isNodeLike(value: unknown): value is LineageNode {
  const node = value as Partial<LineageNode>
  return typeof node?.id === 'string' && node.id !== ''
    && typeof node.label === 'string' && node.label !== ''
    && typeof node.type === 'string' && node.type !== ''
}

function isEdgeLike(value: unknown): value is LineageEdge {
  const edge = value as Partial<LineageEdge>
  return typeof edge?.from === 'string' && typeof edge?.to === 'string' && edge.from !== '' && edge.to !== ''
    && ((typeof edge.label === 'string' && edge.label !== '') || (typeof edge.rel_type === 'string' && edge.rel_type !== ''))
}

export function validateLineagePatch(value: unknown): { patch: LineagePatch; issues: LineagePatchIssue[] } {
  const patch: LineagePatch = { ops: [] }
  const issues: LineagePatchIssue[] = []
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { ops?: unknown }).ops)) {
    issues.push({ index: 0, message: 'patch 必须包含 ops 数组' })
    return { patch, issues }
  }
  const raw = value as { reason?: unknown; ops: unknown[] }
  if (typeof raw.reason === 'string' && raw.reason !== '') patch.reason = raw.reason
  raw.ops.forEach((operation, index) => {
    if (typeof operation !== 'object' || operation === null) {
      issues.push({ index, message: '操作必须是对象' })
      return
    }
    const candidate = operation as Record<string, unknown>
    switch (candidate.op) {
      case 'upsert_node':
        if (isNodeLike(candidate.node)) patch.ops.push({ op: 'upsert_node', node: candidate.node })
        else issues.push({ index, message: 'upsert_node.node 需要 id' })
        return
      case 'update_node':
        if (typeof candidate.id === 'string' && typeof candidate.patch === 'object' && candidate.patch !== null) {
          const { id: _ignored, ...fields } = candidate.patch as Partial<LineageNode>
          patch.ops.push({ op: 'update_node', id: candidate.id, patch: compact(fields) })
        } else issues.push({ index, message: 'update_node 需要 id 和 patch' })
        return
      case 'delete_node':
        if (typeof candidate.id === 'string') patch.ops.push({ op: 'delete_node', id: candidate.id })
        else issues.push({ index, message: 'delete_node 需要 id' })
        return
      case 'add_edge':
        if (isEdgeLike(candidate.edge)) patch.ops.push({ op: 'add_edge', edge: candidate.edge })
        else issues.push({ index, message: 'add_edge.edge 需要 from 和 to' })
        return
      case 'update_edge':
        if (typeof candidate.id === 'string' && typeof candidate.patch === 'object' && candidate.patch !== null) {
          const { id: _ignored, ...fields } = candidate.patch as Partial<LineageEdge>
          patch.ops.push({ op: 'update_edge', id: candidate.id, patch: compact(fields) })
        } else issues.push({ index, message: 'update_edge 需要 id 和 patch' })
        return
      case 'delete_edge':
        if (typeof candidate.id === 'string') patch.ops.push({ op: 'delete_edge', id: candidate.id })
        else issues.push({ index, message: 'delete_edge 需要 id' })
        return
      case 'merge_instance':
        if (typeof candidate.sourceId === 'string' && typeof candidate.targetId === 'string') {
          patch.ops.push({ op: 'merge_instance', sourceId: candidate.sourceId, targetId: candidate.targetId })
        } else issues.push({ index, message: 'merge_instance 需要 sourceId 和 targetId' })
        return
      case 'set_mapping':
        if (typeof candidate.id === 'string' && typeof candidate.mapping === 'object' && candidate.mapping !== null) {
          patch.ops.push({ op: 'set_mapping', id: candidate.id, mapping: candidate.mapping as Record<string, unknown> })
        } else issues.push({ index, message: 'set_mapping 需要 id 和 mapping' })
        return
      default:
        issues.push({ index, message: '不支持的 op' })
    }
  })
  return { patch, issues }
}

function withReason(properties: Record<string, unknown> | undefined, reason: string): Record<string, unknown> {
  const history = Array.isArray(properties?.patchHistory) ? properties.patchHistory : []
  return {
    ...properties,
    patchHistory: [...history, { reason, at: new Date().toISOString() }].slice(-10),
  }
}

export function applyLineagePatch(
  graph: LineageGraph,
  patch: LineagePatch,
  options: { reason?: string } = {},
): { graph: LineageGraph; summary: LineagePatchSummary } {
  const reason = options.reason ?? patch.reason ?? '对话增量更新'
  let nodes = graph.nodes.map((node) => ({ ...node }))
  let edges = graph.edges.map((edge) => ({ ...edge }))
  const summary: LineagePatchSummary = {
    addedNodes: 0, updatedNodes: 0, deletedNodes: 0,
    addedEdges: 0, updatedEdges: 0, deletedEdges: 0, failed: [],
  }

  patch.ops.forEach((operation, index) => {
    if (operation.op === 'upsert_node') {
      const nodeIndex = nodes.findIndex((node) => node.id === operation.node.id)
      if (nodeIndex >= 0) {
        nodes[nodeIndex] = { ...nodes[nodeIndex]!, ...compact(operation.node) }
        summary.updatedNodes += 1
      } else {
        nodes.push({ ...operation.node } as LineageNode)
        summary.addedNodes += 1
      }
      return
    }
    if (operation.op === 'update_node') {
      const nodeIndex = nodes.findIndex((node) => node.id === operation.id)
      if (nodeIndex < 0) {
        summary.failed.push({ index, message: `节点 ${operation.id} 不存在` })
        return
      }
      nodes[nodeIndex] = { ...nodes[nodeIndex]!, ...compact(operation.patch) }
      summary.updatedNodes += 1
      return
    }
    if (operation.op === 'delete_node') {
      const before = nodes.length
      nodes = nodes.filter((node) => node.id !== operation.id)
      if (nodes.length === before) {
        summary.failed.push({ index, message: `节点 ${operation.id} 不存在` })
        return
      }
      const beforeEdges = edges.length
      edges = edges.filter((edge) => edge.from !== operation.id && edge.to !== operation.id)
      summary.deletedNodes += 1
      summary.deletedEdges += beforeEdges - edges.length
      return
    }
    if (operation.op === 'add_edge') {
      const endpointsExist = nodes.some((node) => node.id === operation.edge.from)
        && nodes.some((node) => node.id === operation.edge.to)
      if (!endpointsExist) {
        summary.failed.push({ index, message: `关系端点不存在：${operation.edge.from} → ${operation.edge.to}` })
        return
      }
      const id = operation.edge.id ?? `edge-${Date.now().toString(36)}-${summary.addedEdges}`
      if (edges.some((edge) => edge.id === id)) {
        summary.failed.push({ index, message: `关系 id 已存在：${id}` })
        return
      }
      const duplicate = edges.find((edge) => edge.from === operation.edge.from && edge.to === operation.edge.to)
      if (duplicate !== undefined) {
        edges = edges.map((edge) => edge.id === duplicate.id
          ? { ...edge, ...compact(operation.edge), id: duplicate.id, properties: withReason(edge.properties, reason) }
          : edge)
        summary.updatedEdges += 1
      } else {
        edges.push({ ...operation.edge, id, properties: withReason(operation.edge.properties, reason) })
        summary.addedEdges += 1
      }
      return
    }
    if (operation.op === 'update_edge') {
      const edgeIndex = edges.findIndex((edge) => edge.id === operation.id)
      if (edgeIndex < 0) {
        summary.failed.push({ index, message: `关系 ${operation.id} 不存在` })
        return
      }
      const edge = edges[edgeIndex]!
      if (operation.patch.from !== undefined && !nodes.some((node) => node.id === operation.patch.from)) {
        summary.failed.push({ index, message: `新端点不存在：${operation.patch.from}` })
        return
      }
      if (operation.patch.to !== undefined && !nodes.some((node) => node.id === operation.patch.to)) {
        summary.failed.push({ index, message: `新端点不存在：${operation.patch.to}` })
        return
      }
      edges[edgeIndex] = { ...edge, ...compact(operation.patch), properties: withReason(edge.properties, reason) }
      summary.updatedEdges += 1
      return
    }
    if (operation.op === 'merge_instance') {
      const sourceIndex = nodes.findIndex((node) => node.id === operation.sourceId)
      const targetIndex = nodes.findIndex((node) => node.id === operation.targetId)
      if (sourceIndex < 0 || targetIndex < 0 || operation.sourceId === operation.targetId) {
        summary.failed.push({ index, message: `实例合并失败：${operation.sourceId} → ${operation.targetId}` })
        return
      }
      const source = nodes[sourceIndex]!
      const target = nodes[targetIndex]!
      const sourceValues = source.properties?.values
      const targetValues = target.properties?.values
      const mergedValues = {
        ...(typeof targetValues === 'object' && targetValues !== null && !Array.isArray(targetValues) ? targetValues as Record<string, unknown> : {}),
        ...(typeof sourceValues === 'object' && sourceValues !== null && !Array.isArray(sourceValues) ? sourceValues as Record<string, unknown> : {}),
      }
      const sourceBindings = [
        ...(Array.isArray(target.properties?.sourceBindings) ? target.properties!.sourceBindings as Record<string, unknown>[] : []),
        ...(source.properties?.sourceBinding !== undefined ? [source.properties.sourceBinding as Record<string, unknown>] : []),
        ...(Array.isArray(source.properties?.sourceBindings) ? source.properties!.sourceBindings as Record<string, unknown>[] : []),
      ]
      const merged: LineageNode = {
        ...target,
        properties: {
          ...target.properties,
          values: mergedValues,
          ...(sourceBindings.length > 0 ? { sourceBindings } : {}),
          mergedFrom: [...(Array.isArray(target.properties?.mergedFrom) ? target.properties!.mergedFrom as string[] : []), source.id],
          mergedAt: new Date().toISOString(),
        },
        evidences: [...(target.evidences ?? []), ...(source.evidences ?? [])],
      }
      const redirected: LineageEdge[] = []
      const edgeSignatures = new Set<string>()
      for (const edge of edges) {
        const next = edge.from === source.id || edge.to === source.id
          ? {
              ...edge,
              from: edge.from === source.id ? target.id : edge.from,
              to: edge.to === source.id ? target.id : edge.to,
              properties: { ...edge.properties, mergedFromEdge: edge.id },
            }
          : edge
        const signature = `${next.from}:${next.to}:${next.rel_type ?? next.label ?? ''}`
        if (edgeSignatures.has(signature)) continue
        edgeSignatures.add(signature)
        redirected.push(next)
      }
      nodes[targetIndex] = merged
      nodes = nodes.filter((node) => node.id !== source.id)
      edges = redirected
      summary.updatedNodes += 1
      summary.deletedNodes += 1
      return
    }
    if (operation.op === 'set_mapping') {
      const nodeIndex = nodes.findIndex((node) => node.id === operation.id)
      if (nodeIndex < 0) {
        summary.failed.push({ index, message: `节点 ${operation.id} 不存在` })
        return
      }
      const node = nodes[nodeIndex]!
      const bindings = Array.isArray(node.properties?.sourceBindings) ? node.properties!.sourceBindings as Record<string, unknown>[] : []
      const duplicate = bindings.some((binding) =>
        binding.connectionId === operation.mapping.connectionId
        && binding.database === operation.mapping.database
        && binding.objectName === operation.mapping.objectName)
      if (duplicate) {
        summary.failed.push({ index, message: '数据源映射已存在' })
        return
      }
      nodes[nodeIndex] = {
        ...node,
        properties: {
          ...node.properties,
          sourceBindings: [...bindings, { ...operation.mapping, reviewStatus: 'pending', mappedAt: new Date().toISOString() }],
        },
      }
      summary.updatedNodes += 1
      return
    }
    const before = edges.length
    edges = edges.filter((edge) => edge.id !== operation.id)
    if (edges.length === before) {
      summary.failed.push({ index, message: `关系 ${operation.id} 不存在` })
      return
    }
    summary.deletedEdges += 1
  })

  if (summary.failed.length > 0) {
    return { graph: { nodes: graph.nodes.map((node) => ({ ...node })), edges: graph.edges.map((edge) => ({ ...edge })) }, summary }
  }
  return { graph: { nodes, edges }, summary }
}
