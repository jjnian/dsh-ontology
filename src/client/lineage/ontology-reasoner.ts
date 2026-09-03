import type { LineageEdge, LineageGraph, LineageNode } from './lineage-types.ts'
import { relationDef } from './ontology-definitions.ts'
import { extractOntologyProfile, type OntologyAttributeDefinition } from './ontology-semantics.ts'

export interface InheritedAttribute {
  attribute: OntologyAttributeDefinition
  fromClassId: string
  fromClassLabel: string
  depth: number
}

export interface InheritedRelation {
  edgeId: string
  relationType: string
  fromClassId: string
  toClassId: string
  fromClassLabel: string
  toClassLabel: string
  depth: number
}

export interface OntologyReasoning {
  ancestors: LineageNode[]
  descendants: LineageNode[]
  equivalentClasses: LineageNode[]
  directAttributes: OntologyAttributeDefinition[]
  inheritedAttributes: InheritedAttribute[]
  effectiveAttributes: OntologyAttributeDefinition[]
  inheritedRelations: InheritedRelation[]
  effectiveRelations: LineageEdge[]
  instanceClasses: LineageNode[]
  reachableNodes: LineageNode[]
  modelGaps: string[]
}

function classLayer(node: LineageNode): boolean {
  return node.type === 'class' || node.type === 'process' || node.type === 'rule'
    || node.type === 'attribute' || node.type === 'constraint'
}

function parentsOf(graph: LineageGraph, id: string): string[] {
  return graph.edges
    .filter((edge) => edge.from === id && edge.rel_type === 'is_a' && graph.nodes.some((node) => node.id === edge.to))
    .map((edge) => edge.to)
}

function childrenOf(graph: LineageGraph, id: string): string[] {
  return graph.edges
    .filter((edge) => edge.to === id && edge.rel_type === 'is_a' && graph.nodes.some((node) => node.id === edge.from))
    .map((edge) => edge.from)
}

function closureOf(graph: LineageGraph, seedId: string, next: (id: string) => string[]): string[] {
  const result: string[] = []
  const visited = new Set([seedId])
  let frontier = [seedId]
  let guard = graph.nodes.length + graph.edges.length + 1
  while (frontier.length > 0 && guard-- > 0) {
    const nextFrontier: string[] = []
    for (const id of frontier) {
      for (const candidate of next(id)) {
        if (visited.has(candidate)) continue
        visited.add(candidate)
        result.push(candidate)
        nextFrontier.push(candidate)
      }
    }
    frontier = nextFrontier
  }
  return result
}

function nodesByIds(graph: LineageGraph, ids: string[]): LineageNode[] {
  const map = new Map(graph.nodes.map((node) => [node.id, node]))
  return ids.map((id) => map.get(id)).filter((node): node is LineageNode => node !== undefined)
}

/**
 * Apply lightweight structural reasoning for one focus node. The graph is
 * still the source of truth; the result is derived, not materialized.
 */
export function reasonOntology(graph: LineageGraph, nodeId: string): OntologyReasoning | null {
  const focus = graph.nodes.find((node) => node.id === nodeId)
  if (focus === undefined) return null
  const profile = extractOntologyProfile(graph)
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const ancestors = closureOf(graph, nodeId, (id) => parentsOf(graph, id))
  const descendants = closureOf(graph, nodeId, (id) => childrenOf(graph, id))
  const equivalentClasses = graph.edges
    .filter((edge) => edge.rel_type === 'equivalent_to' && (edge.from === nodeId || edge.to === nodeId))
    .map((edge) => nodeById.get(edge.from === nodeId ? edge.to : edge.from))
    .filter((node): node is LineageNode => node !== undefined)

  const own = profile.classes.get(nodeId)
  const directAttributes = own?.attributes ?? []
  const inheritedAttributes: InheritedAttribute[] = []
  for (const [depth, ancestorId] of ancestors.entries()) {
    const ancestor = nodeById.get(ancestorId)
    const definition = profile.classes.get(ancestorId)
    if (ancestor === undefined || definition === undefined) continue
    for (const attribute of definition.attributes) {
      inheritedAttributes.push({
        attribute,
        fromClassId: ancestor.id,
        fromClassLabel: ancestor.label,
        depth: depth + 1,
      })
    }
  }
  const effectiveAttributes = [...directAttributes]
  const seenAttributes = new Set(directAttributes.map((attribute) => attribute.label))
  for (const inherited of inheritedAttributes) {
    if (!seenAttributes.has(inherited.attribute.label)) {
      effectiveAttributes.push(inherited.attribute)
      seenAttributes.add(inherited.attribute.label)
    }
  }

  const directRelationIds = new Set(
    graph.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).map((edge) => edge.id),
  )
  const inheritedRelations: InheritedRelation[] = []
  for (const [depth, ancestorId] of ancestors.entries()) {
    const ancestor = nodeById.get(ancestorId)
    if (ancestor === undefined) continue
    for (const edge of graph.edges) {
      if (edge.from !== ancestor.id || edge.to === ancestor.id) continue
      if (edge.rel_type === 'attribute_of' || edge.rel_type === 'is_a' || edge.rel_type === 'instance_of') continue
      const to = nodeById.get(edge.to)
      if (to === undefined) continue
      inheritedRelations.push({
        edgeId: edge.id,
        relationType: edge.rel_type ?? edge.label ?? 'associated_with',
        fromClassId: ancestor.id,
        toClassId: to.id,
        fromClassLabel: ancestor.label,
        toClassLabel: to.label,
        depth: depth + 1,
      })
    }
  }
  const effectiveRelations = [
    ...graph.edges.filter((edge) => directRelationIds.has(edge.id)),
    ...inheritedRelations.map((relation) => {
      const edge: LineageEdge = {
        id: `inherited:${relation.edgeId}:${nodeId}`,
        from: nodeId,
        to: relation.toClassId,
        label: relation.relationType,
        rel_type: relation.relationType,
        source: 'inferred',
        properties: { inheritedFrom: relation.fromClassId, inheritedDepth: relation.depth },
      }
      return edge
    }),
  ]

  const directClasses = graph.edges
    .filter((edge) => edge.from === nodeId && edge.rel_type === 'instance_of')
    .map((edge) => nodeById.get(edge.to))
    .filter((node): node is LineageNode => node !== undefined)
  const instanceClasses = [...directClasses]
  for (const direct of directClasses) {
    for (const ancestor of nodesByIds(graph, closureOf(graph, direct.id, (id) => parentsOf(graph, id)))) {
      if (classLayer(ancestor) && !instanceClasses.some((item) => item.id === ancestor.id)) instanceClasses.push(ancestor)
    }
  }

  const reachable = new Set([nodeId])
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
  }
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (reachable.has(next)) continue
      reachable.add(next)
      queue.push(next)
    }
  }

  const modelGaps: string[] = []
  if (classLayer(focus)) {
    if (own !== undefined) {
      if (own.description === undefined) modelGaps.push('缺少业务定义')
      if (own.aliases.length === 0) modelGaps.push('缺少同义词/别名')
      if (effectiveAttributes.length === 0) modelGaps.push('缺少属性结构')
      if (!effectiveAttributes.some((attribute) => attribute.identifier)) modelGaps.push('缺少业务标识键')
      if (own.outgoingRelations.length === 0 && own.incomingRelations.length === 0) modelGaps.push('缺少业务关系')
    }
  }

  return {
    ancestors: nodesByIds(graph, ancestors),
    descendants: nodesByIds(graph, descendants),
    equivalentClasses,
    directAttributes,
    inheritedAttributes,
    effectiveAttributes,
    inheritedRelations,
    effectiveRelations,
    instanceClasses,
    reachableNodes: nodesByIds(graph, [...reachable]),
    modelGaps,
  }
}

/** Materialize only new, deterministic transitive edges for a transitive relation. */
export function inferTransitiveEdges(graph: LineageGraph, relationType: string): LineageEdge[] {
  const definition = relationDef(relationType)
  if (definition?.transitive !== true) return []
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = graph.edges.filter((edge) => edge.rel_type === relationType)
  const adjacency = new Map<string, string[]>()
  const edgeByPair = new Map<string, LineageEdge>()
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    edgeByPair.set(`${edge.from}:${edge.to}`, edge)
  }
  const inferred: LineageEdge[] = []
  for (const start of nodeById.keys()) {
    const visited = new Set<string>()
    const queue: { id: string; via: string[] }[] = (adjacency.get(start) ?? []).map((id) => ({ id, via: [id] }))
    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current.id)) continue
      visited.add(current.id)
      if (current.id !== start && !edgeByPair.has(`${start}:${current.id}`)) {
        inferred.push({
          id: `inferred:${relationType}:${start}:${current.id}`,
          from: start,
          to: current.id,
          label: definition.label,
          rel_type: relationType,
          source: 'inferred',
          confidence: 0.7,
          properties: { inferredPath: current.via },
        })
      }
      for (const next of adjacency.get(current.id) ?? []) {
        queue.push({ id: next, via: [...current.via, next] })
      }
    }
  }
  return inferred
}
