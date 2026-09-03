/**
 * Ontology validation engine: is_a cycle detection, disjointness conflict
 * detection, and relation domain/range type checking. Pure functions over
 * the LineageGraph data model, usable from both the client and tests.
 */
import type { LineageGraph, LineageNode, LineageEdge } from './lineage-types.ts'
import { relationDef, endpointMatchesLayer, nodeLayer, ONTOLOGY_DISJOINT_PAIRS } from './ontology-definitions.ts'
import { extractOntologyProfile, validateInstanceAgainstClass } from './ontology-semantics.ts'
import { inferTransitiveEdges } from './ontology-reasoner.ts'

/** One validation finding (error or warning). */
export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  nodes: string[]
  edges: string[]
  category?: string
}

/**
 * Detect cycles in the is_a hierarchy. A well-formed ontology is_a must be
 * a DAG; a cycle means the class hierarchy is inconsistent.
 */
function detectIsACycles(edges: readonly LineageEdge[]): ValidationIssue[] {
  const hierarchyEdges = edges.filter((e) => e.rel_type === 'is_a')
  if (hierarchyEdges.length === 0) return []

  const adjacency = new Map<string, string[]>()
  for (const edge of hierarchyEdges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  const issues: ValidationIssue[] = []
  const visited = new Set<string>()
  const inStack = new Set<string>()

  const dfs = (nodeId: string, path: string[]): void => {
    if (inStack.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId)
      const cycle = path.slice(cycleStart)
      issues.push({
        severity: 'error',
        message: 'is_a hierarchy contains a cycle: ' + cycle.join(' -> '),
        nodes: cycle,
        edges: hierarchyEdges.filter((e) => cycle.includes(e.from) && cycle.includes(e.to)).map((e) => e.id),
        category: '层级循环',
      })
      return
    }
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    inStack.add(nodeId)
    for (const next of adjacency.get(nodeId) ?? []) dfs(next, [...path, nodeId])
    inStack.delete(nodeId)
  }

  for (const id of adjacency.keys()) dfs(id, [])
  return issues
}

/**
 * Detect nodes that are instances of two disjoint classes. Uses both the
 * hardcoded disjointness pairs and any explicit disjoint_with edges.
 */
function detectDisjointConflicts(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const instanceMap = new Map<string, string[]>()
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  for (const edge of edges) {
    if (edge.rel_type !== 'instance_of') continue
    const list = instanceMap.get(edge.from) ?? []
    list.push(edge.to)
    instanceMap.set(edge.from, list)
  }

  // Check hardcoded type-level disjointness
  for (const [typeA, typeB] of ONTOLOGY_DISJOINT_PAIRS) {
    const aNodes = nodes.filter((n) => n.type === typeA)
    const bNodes = nodes.filter((n) => n.type === typeB)
    for (const a of aNodes) {
      for (const b of bNodes) {
        const hasConflict = edges.some((e) =>
          (e.from === a.id && e.to === b.id && e.rel_type === 'is_a') ||
          (e.from === b.id && e.to === a.id && e.rel_type === 'is_a'),
        )
        if (hasConflict) {
          issues.push({
            severity: 'warning',
            message: 'Disjoint types connected by is_a: ' + a.label + ' (' + typeA + ') vs ' + b.label + ' (' + typeB + ')',
        nodes: [a.id, b.id],
        edges: [],
        category: '本体互斥',
      })
        }
      }
    }
  }

  // Check explicit disjoint_with edges
  const disjointEdges = edges.filter((e) => e.rel_type === 'disjoint_with')
  for (const dEdge of disjointEdges) {
    for (const [entityId, classIds] of instanceMap) {
      if (classIds.includes(dEdge.from) && classIds.includes(dEdge.to)) {
        const entity = nodeById.get(entityId)
        const classA = nodeById.get(dEdge.from)
        const classB = nodeById.get(dEdge.to)
        issues.push({
          severity: 'error',
          message: 'Instance ' + (entity?.label ?? entityId) + ' belongs to two disjoint classes: ' + (classA?.label ?? dEdge.from) + ' and ' + (classB?.label ?? dEdge.to),
          nodes: [entityId, dEdge.from, dEdge.to],
          edges: [dEdge.id],
          category: '本体互斥',
        })
      }
    }
  }

  return issues
}

/** Check relation endpoints against every declared domain/range constraint. */
function detectTypeMismatches(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  for (const edge of edges) {
    const fromNode = nodeById.get(edge.from)
    const toNode = nodeById.get(edge.to)
    if (fromNode === undefined || toNode === undefined) continue

    const definition = relationDef(edge.rel_type)
    if (definition === undefined) continue
    const fromValid = definition.domain === undefined || definition.domain.some((selector) => endpointMatchesLayer(fromNode, selector))
    const toValid = definition.range === undefined || definition.range.some((selector) => endpointMatchesLayer(toNode, selector))
    if (!fromValid || !toValid) {
      issues.push({
        severity: 'warning',
        message: `${definition.label} 端点不匹配：${nodeLayer(fromNode)} -> ${nodeLayer(toNode)}，应为 ${definition.domain?.join('|') ?? '*'} -> ${definition.range?.join('|') ?? '*'}`,
        nodes: [edge.from, edge.to],
        edges: [edge.id],
        category: '方向类型不匹配',
      })
    }
  }

  return issues
}

function normalizeConcept(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

function descriptionOf(node: LineageNode): string {
  const properties = node.properties as Record<string, unknown> | undefined
  const direct = typeof node.evidence === 'string' ? node.evidence.trim() : ''
  const propertyDescription = typeof properties?.description === 'string' ? properties.description.trim() : ''
  const meaning = typeof properties?.meaning === 'string' ? properties.meaning.trim() : ''
  return propertyDescription !== '' ? propertyDescription : meaning !== '' ? meaning : direct
}

function aliasesOf(node: LineageNode): string[] {
  const properties = node.properties as Record<string, unknown> | undefined
  const raw = properties?.aliases ?? properties?.synonyms
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.split(/[,;，；]/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function hasEquivalentEdge(edges: readonly LineageEdge[], aId: string, bId: string): boolean {
  return edges.some((edge) => edge.rel_type === 'equivalent_to'
    && ((edge.from === aId && edge.to === bId) || (edge.from === bId && edge.to === aId)))
}

/** Same display label with different descriptions. */
function detectSameNameDifferentMeaning(nodes: readonly LineageNode[]): ValidationIssue[] {
  const groups = new Map<string, LineageNode[]>()
  for (const node of nodes) {
    const key = normalizeConcept(node.label)
    if (key === '') continue
    const list = groups.get(key) ?? []
    list.push(node)
    groups.set(key, list)
  }

  const issues: ValidationIssue[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const descriptions = [...new Set(group.map(descriptionOf).filter((text) => text !== ''))]
    if (descriptions.length < 2) continue
    issues.push({
      severity: 'warning',
      message: `同名不同义: ${group[0]!.label} — ${descriptions.join(' / ')}`,
      nodes: group.map((node) => node.id),
      edges: [],
      category: '同名不同义',
    })
  }
  return issues
}

/** Different labels that look like the same concept through aliases. */
function detectSynonymDifferentName(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!
      const b = nodes[j]!
      if (normalizeConcept(a.label) === normalizeConcept(b.label)) continue
      if (hasEquivalentEdge(edges, a.id, b.id)) continue
      const aliasesA = aliasesOf(a)
      const aliasesB = aliasesOf(b)
      const labelMatch = aliasesA.includes(b.label) || aliasesB.includes(a.label)
      const aliasMatch = aliasesA.some((alias) => aliasesB.includes(alias))
      if (labelMatch || aliasMatch) {
        issues.push({
          severity: 'warning',
          message: `同义不同名: ${a.label} ↔ ${b.label}`,
          nodes: [a.id, b.id],
          edges: [],
          category: '同义不同名',
        })
      }
    }
  }
  return issues
}

/** Attribute nodes with the same name but different declared types. */
function detectAttributeTypeConflicts(nodes: readonly LineageNode[]): ValidationIssue[] {
  const groups = new Map<string, LineageNode[]>()
  for (const node of nodes) {
    if (node.type !== 'attribute') continue
    const key = normalizeConcept(node.label)
    if (key === '') continue
    const list = groups.get(key) ?? []
    list.push(node)
    groups.set(key, list)
  }

  const issues: ValidationIssue[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const types = group.map((node) => {
      const properties = node.properties as Record<string, unknown> | undefined
      return typeof properties?.dataType === 'string' ? properties.dataType.trim() : ''
    }).filter((type) => type !== '')
    if (new Set(types).size < 2) continue
    issues.push({
      severity: 'warning',
      message: `属性类型冲突: ${group[0]!.label} — ${[...new Set(types)].join(' / ')}`,
      nodes: group.map((node) => node.id),
      edges: [],
      category: '属性类型冲突',
    })
  }
  return issues
}

/** The same directed relation asserted in both directions. */
function detectRelationDirectionConflicts(edges: readonly LineageEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!
      const b = edges[j]!
      if (a.rel_type === undefined || a.rel_type !== b.rel_type) continue
      const definition = relationDef(a.rel_type)
      if (definition?.symmetric) continue
      if (a.from === b.to && a.to === b.from) {
        issues.push({
          severity: 'warning',
          message: `关系方向冲突: ${a.rel_type} 在同一对节点上双向存在`,
          nodes: [a.from, a.to],
          edges: [a.id, b.id],
          category: '关系方向冲突',
        })
      }
    }
  }
  return issues
}

function ruleText(node: LineageNode): string {
  const properties = node.properties as Record<string, unknown> | undefined
  const description = typeof properties?.description === 'string' ? properties.description : ''
  return `${node.label} ${description}`.trim()
}

function normalizedRuleCore(text: string): string {
  return text
    .toLowerCase()
    .replace(/必须|应当|不得|禁止|不能|不允许|仅限|must not|must|should|shall/g, '')
    .replace(/[\s.,;，。；:：'"`()（）]/g, '')
}

function isNegativeRule(text: string): boolean {
  return /不得|禁止|不能|不允许|must not/i.test(text)
}

function isPositiveRule(text: string): boolean {
  return /必须|应当|仅限|must|should|shall/i.test(text)
}

/** Two rules with the same core requirement but opposite modality. */
function detectRuleConflicts(nodes: readonly LineageNode[]): ValidationIssue[] {
  const rules = nodes.filter((node) => node.type === 'rule' || node.type === 'constraint')
  const issues: ValidationIssue[] = []
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!
      const b = rules[j]!
      const coreA = normalizedRuleCore(ruleText(a))
      const coreB = normalizedRuleCore(ruleText(b))
      if (coreA === '' || coreA !== coreB) continue
      const opposite = isNegativeRule(ruleText(a)) !== isNegativeRule(ruleText(b))
      if (isPositiveRule(ruleText(a)) && isPositiveRule(ruleText(b)) && !opposite) continue
      if (isNegativeRule(ruleText(a)) && isNegativeRule(ruleText(b)) && !opposite) continue
      issues.push({
        severity: 'warning',
        message: `规则冲突: ${a.label} ↔ ${b.label}`,
        nodes: [a.id, b.id],
        edges: [],
        category: '规则冲突',
      })
    }
  }
  return issues
}

/** A mapped data source should describe the ontology class structure. */
function detectSourceStructureInconsistency(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of nodes) {
    const bindings = Array.isArray(node.properties?.sourceBindings)
      ? node.properties!.sourceBindings as unknown[]
      : []
    if (bindings.length === 0) continue
    if (node.type !== 'class') {
      issues.push({
        severity: 'warning',
        message: `数据源结构不一致: ${node.label} 不是类节点，但带有数据源映射`,
        nodes: [node.id],
        edges: [],
        category: '数据源结构不一致',
      })
      continue
    }
    const hasAttributes = edges.some((edge) => edge.rel_type === 'attribute_of' && edge.to === node.id)
    if (!hasAttributes) {
      issues.push({
        severity: 'warning',
        message: `数据源结构不一致: ${node.label} 已映射数据源，但缺少属性结构`,
        nodes: [node.id],
        edges: [],
        category: '数据源结构不一致',
      })
    }
  }
  return issues
}

/** Check duplicate class attributes and declared relation cardinality conflicts. */
function detectSchemaConstraintConflicts(graph: Parameters<typeof extractOntologyProfile>[0]): ValidationIssue[] {
  const profile = extractOntologyProfile(graph)
  const issues: ValidationIssue[] = []
  for (const [classId, attributes] of profile.attributes) {
    const groups = new Map<string, typeof attributes>()
    for (const attribute of attributes) {
      const key = attribute.label.trim().toLowerCase()
      groups.set(key, [...(groups.get(key) ?? []), attribute])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      issues.push({
        severity: 'warning',
        message: `属性定义冲突: ${group[0]!.label} 在同一类中重复定义`,
        nodes: [classId, ...group.map((attribute) => attribute.id)],
        edges: [],
        category: '属性定义冲突',
      })
    }
  }

  const relationCounts = new Map<string, number>()
  for (const edge of graph.edges) {
    if (edge.rel_type === 'attribute_of') continue
    const key = `${edge.from}:${edge.to}:${edge.rel_type ?? edge.label ?? ''}`
    relationCounts.set(key, (relationCounts.get(key) ?? 0) + 1)
  }
  for (const edge of graph.edges) {
    const max = edge.properties?.maxCardinality
    const key = `${edge.from}:${edge.to}:${edge.rel_type ?? edge.label ?? ''}`
    if (typeof max === 'number' && (relationCounts.get(key) ?? 0) > max) {
      issues.push({
        severity: 'error',
        message: `关系基数冲突: ${edge.rel_type ?? edge.label ?? '关联'} 超过最大基数 ${max}`,
        nodes: [edge.from, edge.to],
        edges: [edge.id],
        category: '关系基数冲突',
      })
    }
  }
  return issues
}

/** Validate imported instance values against class attributes, including inherited attributes. */
function detectInstanceConstraintViolations(graph: Parameters<typeof extractOntologyProfile>[0]): ValidationIssue[] {
  const profile = extractOntologyProfile(graph)
  const issues: ValidationIssue[] = []
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const parentOf = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.rel_type !== 'is_a') continue
    parentOf.set(edge.from, [...(parentOf.get(edge.from) ?? []), edge.to])
  }
  const ancestors = (id: string): string[] => {
    const result: string[] = []
    const visited = new Set([id])
    const queue = [...(parentOf.get(id) ?? [])]
    while (queue.length > 0 && visited.size < graph.nodes.length + 1) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)
      result.push(current)
      queue.push(...(parentOf.get(current) ?? []))
    }
    return result
  }

  for (const edge of graph.edges) {
    if (edge.rel_type !== 'instance_of') continue
    const instance = nodeById.get(edge.from)
    const classDefinition = profile.classes.get(edge.to)
    if (instance === undefined || classDefinition === undefined) continue
    const attributes = [...classDefinition.attributes]
    for (const ancestorId of ancestors(classDefinition.id)) {
      attributes.push(...(profile.attributes.get(ancestorId) ?? []))
    }
    for (const violation of validateInstanceAgainstClass(instance, classDefinition, attributes)) {
      issues.push({
        severity: 'error',
        message: `实例约束冲突: ${violation.message}`,
        nodes: [instance.id, classDefinition.id],
        edges: [edge.id],
        category: '实例约束冲突',
      })
    }
  }
  return issues
}

/** Surface deterministic transitive implications as reviewable warnings. */
function detectUnmaterializedTransitiveRelations(graph: Parameters<typeof extractOntologyProfile>[0]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const relationType of ['is_a', 'part_of', 'contains']) {
    for (const edge of inferTransitiveEdges(graph, relationType)) {
      issues.push({
        severity: 'warning',
        message: `可传递关系推导: ${relationType} 可从路径推导，建议确认后物化`,
        nodes: [edge.from, edge.to],
        edges: [],
        category: '传递关系',
      })
    }
  }
  return issues
}

/** Enforce per-node relation cardinalities declared on relation types. */
function detectRelationCardinalityViolations(graph: Parameters<typeof extractOntologyProfile>[0]): ValidationIssue[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const issues: ValidationIssue[] = []
  const outgoing = new Map<string, Map<string, LineageEdge[]>>()
  const incoming = new Map<string, Map<string, LineageEdge[]>>()
  for (const edge of graph.edges) {
    const relationType = edge.rel_type
    if (relationType === undefined) continue
    for (const [boundary, bucket] of [[edge.from, outgoing], [edge.to, incoming]] as const) {
      const byRelation = bucket.get(boundary) ?? new Map<string, LineageEdge[]>()
      byRelation.set(relationType, [...(byRelation.get(relationType) ?? []), edge])
      bucket.set(boundary, byRelation)
    }
  }
  for (const [nodeId, byRelation] of outgoing) {
    for (const [relationType, edges] of byRelation) {
      const max = relationDef(relationType)?.maxOut
      if (max === undefined || edges.length <= max) continue
      issues.push({
        severity: 'error',
        message: `${relationType} 出边超过上限 ${max}：${nodeById.get(nodeId)?.label ?? nodeId} 当前 ${edges.length} 条`,
        nodes: [nodeId],
        edges: edges.map((edge) => edge.id),
        category: '关系基数冲突',
      })
    }
  }
  for (const [nodeId, byRelation] of incoming) {
    for (const [relationType, edges] of byRelation) {
      const max = relationDef(relationType)?.maxIn
      if (max === undefined || edges.length <= max) continue
      issues.push({
        severity: 'error',
        message: `${relationType} 入边超过上限 ${max}：${nodeById.get(nodeId)?.label ?? nodeId} 当前 ${edges.length} 条`,
        nodes: [nodeId],
        edges: edges.map((edge) => edge.id),
        category: '关系基数冲突',
      })
    }
  }
  return issues
}

/** Run all ontology validations on a graph, returning the combined issue list. */
export function validateOntology(graph: LineageGraph): ValidationIssue[] {
  return [
    ...detectIsACycles(graph.edges),
    ...detectDisjointConflicts(graph.nodes, graph.edges),
    ...detectTypeMismatches(graph.nodes, graph.edges),
    ...detectSameNameDifferentMeaning(graph.nodes),
    ...detectSynonymDifferentName(graph.nodes, graph.edges),
    ...detectAttributeTypeConflicts(graph.nodes),
    ...detectRelationDirectionConflicts(graph.edges),
    ...detectRuleConflicts(graph.nodes),
    ...detectSourceStructureInconsistency(graph.nodes, graph.edges),
    ...detectSchemaConstraintConflicts(graph),
    ...detectInstanceConstraintViolations(graph),
    ...detectUnmaterializedTransitiveRelations(graph),
    ...detectRelationCardinalityViolations(graph),
  ]
}

/** True when the relation id is in the canonical ontology set. */
export function isKnownRelation(relType?: string): boolean {
  return relationDef(relType) !== undefined
}
