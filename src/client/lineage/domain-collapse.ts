import type { LineageEdge, LineageGraph, LineageNode } from './lineage-types.ts'

export interface DomainGroup {
  id: string
  label: string
  nodes: LineageNode[]
  internalEdgeCount: number
  crossEdgeCount: number
}

export type DomainCollapsedEdge = LineageEdge & {
  label: string
  count: number
}

export interface DomainCollapsedGraph {
  groups: DomainGroup[]
  nodes: LineageNode[]
  edges: DomainCollapsedEdge[]
  membership: Map<string, string>
}

const UNCLASSIFIED = '未分类'

function domainOf(node: LineageNode): string {
  const value = node.domain?.trim()
  return value === undefined || value === '' ? UNCLASSIFIED : value
}

/**
 * Derive a rendering-only domain view. The real graph is never mutated, so a
 * collapse can be reversed without losing positions or ontology facts.
 */
export function collapseLineageByDomain(
  graph: LineageGraph,
  expandedDomains: ReadonlySet<string> = new Set(),
): DomainCollapsedGraph {
  const groups = new Map<string, DomainGroup>()
  for (const node of graph.nodes) {
    const domain = domainOf(node)
    const group = groups.get(domain) ?? {
      id: `domain:${domain}`,
      label: domain,
      nodes: [],
      internalEdgeCount: 0,
      crossEdgeCount: 0,
    }
    group.nodes.push(node)
    groups.set(domain, group)
  }

  const membership = new Map<string, string>()
  for (const [domain, group] of groups) {
    for (const node of group.nodes) membership.set(node.id, domain)
  }

  const aggregated = new Map<string, DomainCollapsedEdge>()
  const nodes: LineageNode[] = []
  const edges: DomainCollapsedEdge[] = []
  for (const edge of graph.edges) {
    const fromDomain = membership.get(edge.from) ?? UNCLASSIFIED
    const toDomain = membership.get(edge.to) ?? UNCLASSIFIED
    const fromExpanded = expandedDomains.has(fromDomain)
    const toExpanded = expandedDomains.has(toDomain)
    if (fromDomain === toDomain) {
      const group = groups.get(fromDomain)
      if (group !== undefined) group.internalEdgeCount += 1
      if (fromExpanded) edges.push({ ...edge, label: edge.label ?? edge.rel_type ?? '相关', count: 1 })
      continue
    }
    if (!fromExpanded && !toExpanded) {
      const domains = [fromDomain, toDomain].sort((left, right) => left.localeCompare(right))
      const key = `${domains[0]}::${domains[1]}`
      const existing = aggregated.get(key)
      if (existing !== undefined) {
        existing.count += 1
        existing.label = `${domains[0]} ↔ ${domains[1]} ×${existing.count}`
      } else {
        aggregated.set(key, {
          id: key,
          from: `domain:${fromDomain}`,
          to: `domain:${toDomain}`,
          label: `${domains[0]} ↔ ${domains[1]} ×1`,
          count: 1,
          rel_type: edge.rel_type ?? 'depends_on',
        })
      }
      const fromGroup = groups.get(fromDomain)
      if (fromGroup !== undefined) fromGroup.crossEdgeCount += 1
      const toGroup = groups.get(toDomain)
      if (toGroup !== undefined) toGroup.crossEdgeCount += 1
      continue
    }
    const from = fromExpanded ? graph.nodes.find((node) => node.id === edge.from) : { ...emptyDomainNode(fromDomain) }
    const to = toExpanded ? graph.nodes.find((node) => node.id === edge.to) : { ...emptyDomainNode(toDomain) }
    if (from !== undefined && to !== undefined) {
      edges.push({ ...edge, from: from.id, to: to.id, label: edge.label ?? edge.rel_type ?? '相关', count: 1 })
    }
  }

  let index = 0
  for (const group of groups.values()) {
    if (expandedDomains.has(group.label)) {
      nodes.push(...group.nodes)
    } else {
      nodes.push({
        id: group.id,
        label: group.label,
        type: 'domain',
        source: 'derived',
        domain: group.label,
        x: 80 + (index % 4) * 280,
        y: 60 + Math.floor(index / 4) * 180,
        properties: {
          nodeCount: group.nodes.length,
          internalEdgeCount: group.internalEdgeCount,
          crossEdgeCount: group.crossEdgeCount,
          memberIds: group.nodes.map((node) => node.id),
        },
        confidence: 1,
      })
      index += 1
    }
  }

  return {
    groups: [...groups.values()],
    nodes,
    edges: [...aggregated.values(), ...edges],
    membership,
  }
}

function emptyDomainNode(domain: string): LineageNode {
  return { id: `domain:${domain}`, label: domain, type: 'domain', source: 'derived', domain }
}

/** Recenter synthetic domain nodes on their member nodes for a stable layout. */
export function layoutDomainGroups(collapsed: DomainCollapsedGraph, graph: LineageGraph): DomainCollapsedGraph {
  const positions = new Map(graph.nodes.map((node) => [node.id, { x: centerX(node), y: centerY(node) }]))
  const nodes = collapsed.nodes.map((node) => {
    const members = (node.properties?.memberIds as string[] | undefined) ?? []
    const points = members.map((id) => positions.get(id)).filter((point): point is { x: number; y: number } => point !== undefined)
    if (points.length === 0) return node
    return {
      ...node,
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    }
  })
  return { ...collapsed, nodes }
}

function centerX(node: LineageNode): number { return typeof node.x === 'number' ? node.x : 0 }
function centerY(node: LineageNode): number { return typeof node.y === 'number' ? node.y : 0 }
