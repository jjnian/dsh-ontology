import type { LineageEdge, LineageGraph, LineageNode } from './lineage-types.ts'
import { extractOntologyProfile, type OntologyProfile } from './ontology-semantics.ts'

export type SourceMappingStrategy =
  | 'one_table_class'
  | 'derived_view'
  | 'join_table'
  | 'dictionary_enum'
  | 'multi_table_inheritance'
  | 'field_group'

export interface SourceTableInfo {
  name: string
  type: string
  comment?: string
  columns?: { name: string; dataType: string; nullable: boolean; defaultValue: string; comment: string }[]
}

export interface SourceMappingCandidate {
  strategy: SourceMappingStrategy
  confidence: number
  reason: string[]
  childClassId?: string
  parentClassId?: string
  enumColumns: string[]
  keyColumns: string[]
}

export interface InstanceSourceBinding {
  connectionId: string
  connectionName?: string
  engine?: string
  database: string
  objectKind?: string
  objectName: string
  mappingStrategy?: SourceMappingStrategy
  primaryKey?: string
  businessKey?: string
  importedAt?: string
}

export interface InstanceQualityIssue {
  nodeId: string
  kind: string
  message: string
  attribute?: string
}

export interface InstanceClassQuality {
  classId: string
  classLabel: string
  instanceCount: number
  validCount: number
  duplicateCount: number
  requiredMissingCount: number
  relationMissingCount: number
  coverage: number
  issues: InstanceQualityIssue[]
}

export interface InstanceQualityReport {
  classes: InstanceClassQuality[]
  validRate: number
  issueCount: number
}

export type GovernanceReviewStatus = 'pending' | 'confirmed' | 'rejected'
export type GovernanceReviewKind = 'relation' | 'mapping' | 'instance'

export interface GovernanceReviewItem {
  id: string
  kind: GovernanceReviewKind
  label: string
  detail: string
  confidence?: number
  nodeId?: string
  edgeId?: string
  bindingIndex?: number
}

const FK_PATTERN = /^(.+?)(?:_?id|_?no|_?code)$/i

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, '')
}

function singular(value: string): string {
  const normalized = normalizeLabel(value)
  if (normalized.endsWith('ies')) return `${normalized.slice(0, -3)}y`
  if (normalized.endsWith('ses') || normalized.endsWith('xes')) return normalized.slice(0, -2)
  if (normalized.endsWith('s')) return normalized.slice(0, -1)
  return normalized
}

/** A deterministic, collision-resistant-enough local instance id. */
export function stableInstanceId(binding: Pick<InstanceSourceBinding, 'connectionId' | 'database' | 'objectName'>, businessKey: string): string {
  const seed = `${binding.connectionId}::${binding.database}::${binding.objectName}::${businessKey}`
  let hashHigh = 0x811c9dc5
  let hashLow = 0x01000193
  for (let index = 0; index < seed.length; index += 1) {
    const char = seed.charCodeAt(index)
    hashHigh = (hashHigh ^ char) * 0x01000193
    hashLow = (hashLow + char * (index + 7)) ^ (hashHigh >>> 5)
    hashHigh >>>= 0
    hashLow >>>= 0
  }
  return `instance:${hashHigh.toString(16).padStart(8, '0')}${hashLow.toString(16).padStart(8, '0')}`
}

/** Detect the most likely mapping strategy from table shape and ontology context. */
export function classifySourceMapping(
  table: SourceTableInfo,
  graph: LineageGraph,
  options: { classId?: string } = {},
): SourceMappingCandidate {
  const columns = table.columns ?? []
  const keyColumns = columns.filter((column) => /(^|_)(id|no|code)$/i.test(column.name)).map((column) => column.name)
  const fkRoots = keyColumns
    .map((column) => column.match(FK_PATTERN)?.[1])
    .filter((root): root is string => root !== undefined)
  const classes = graph.nodes.filter((node) =>
    node.type === 'class' || node.type === 'process' || node.type === 'rule' || node.type === 'constraint')
  const classLabels = new Map(classes.map((node) => [normalizeLabel(node.label), node.id]))

  if (table.type.toLowerCase() === 'view') {
    return {
      strategy: 'derived_view',
      confidence: 0.9,
      reason: ['视图自动映射为派生类', '保留派生关系 lineage'],
      enumColumns: [],
      keyColumns,
    }
  }

  if (fkRoots.length >= 2) {
    const matchedParents = fkRoots
      .map((root) => classLabels.get(singular(root)) ?? classLabels.get(normalizeLabel(root)))
      .filter((id): id is string => id !== undefined)
    if (matchedParents.length >= 2 || keyColumns.length >= 3) {
      return {
        strategy: 'join_table',
        confidence: matchedParents.length >= 2 ? 0.88 : 0.72,
        reason: ['包含多个外键列', '建议映射为类间关系而不是独立实例类'],
        enumColumns: [],
        keyColumns,
      }
    }
  }

  const dictionaryShape = columns.length > 0 && columns.length <= 3
    && (/type|status|category|kind/i.test(table.name)
      || (keyColumns.length <= 1 && columns.every((column) => /code|type|status|category|kind|label|name|value/i.test(column.name))))
  if (dictionaryShape) {
    return {
      strategy: 'dictionary_enum',
      confidence: 0.8,
      reason: ['表结构较小', '建议转为本体枚举或约束'],
      enumColumns: columns.map((column) => column.name),
      keyColumns,
    }
  }

  const childClassId = options.classId ?? classes[0]?.id
  const childClass = classes.find((node) => node.id === childClassId)
  const normalizedTable = normalizeLabel(table.name)
  const inheritanceParent = classes.find((candidate) => {
    const parent = normalizeLabel(candidate.label)
    if (childClass === undefined || parent === '') return false
    const child = normalizeLabel(childClass.label)
    return child.includes(parent) && child !== parent
  })
  if (inheritanceParent !== undefined) {
    return {
      strategy: 'multi_table_inheritance',
      confidence: 0.76,
      reason: [`表名包含父类 ${inheritanceParent.label}`, '建议映射为子类继承结构'],
      childClassId,
      parentClassId: inheritanceParent.id,
      enumColumns: [],
      keyColumns,
    }
  }

  if (columns.some((column) => /json|payload|attributes|properties/i.test(column.name))) {
    return {
      strategy: 'field_group',
      confidence: 0.68,
      reason: ['包含 JSON/属性组字段', '建议映射为复合属性'],
      enumColumns: [],
      keyColumns,
    }
  }

  return {
    strategy: 'one_table_class',
    confidence: 0.82,
    reason: ['标准表结构', '建议一表一类映射'],
    childClassId,
    enumColumns: [],
    keyColumns,
  }
}

/** Match class attributes to source columns using exact, normalized, alias, and comment evidence. */
export function suggestColumnMappings(
  attributes: { id: string; label: string; aliases?: string[] }[],
  columns: SourceTableInfo['columns'] = [],
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const attribute of attributes) {
    const candidates = [attribute.label, ...(attribute.aliases ?? [])]
    for (const candidate of candidates) {
      const expected = normalizeLabel(candidate)
      if (expected === '') continue
      const matched = columns.find((column) =>
        normalizeLabel(column.name) === expected
        || normalizeLabel(column.comment) === expected)
      if (matched !== undefined) {
        result[attribute.label] = matched.name
        break
      }
    }
    for (const candidate of candidates) {
      if (result[attribute.label] !== undefined) break
      const matched = columns.find((column) =>
        (column.comment !== '' && column.comment.includes(candidate))
        || (candidate !== '' && candidate.includes(column.comment)))
      if (matched !== undefined) result[attribute.label] = matched.name
    }
  }
  return result
}

function aliasList(node: LineageNode): string[] {
  const aliases = node.properties?.aliases
  return Array.isArray(aliases) ? aliases.map((item) => String(item)) : []
}

function classByIdentifier(graph: LineageGraph, identifierKey: string, rootLabel: string): LineageNode | undefined {
  const classes = graph.nodes.filter((node) =>
    node.type === 'class' || node.type === 'process' || node.type === 'rule' || node.type === 'constraint')
  const normalizedRoot = singular(rootLabel)
  return classes.find((node) => {
    const keys = [String(node.properties?.identifierKey ?? ''), ...aliasList(node), node.label]
      .map((item) => singular(item))
    return keys.includes(identifierKey) || keys.includes(normalizedRoot)
  })
}

/** Find a matching instance for a foreign-key value using stable business identity. */
export function findInstanceByValue(
  graph: LineageGraph,
  targetClassId: string,
  value: unknown,
  businessKey?: string,
): LineageNode | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const serialized = String(value)
  return graph.nodes.find((node) => {
    const classEdges = graph.edges.filter((edge) => edge.from === node.id && edge.rel_type === 'instance_of' && edge.to === targetClassId)
    if (classEdges.length === 0) return false
    const values = node.properties?.values
    const record = typeof values === 'object' && values !== null && !Array.isArray(values) ? values as Record<string, unknown> : {}
    if (String(node.properties?.primaryKey ?? '') === serialized) return true
    if (businessKey !== undefined && String(record[businessKey] ?? '') === serialized) return true
    return Object.entries(record).some(([key, candidate]) =>
      /(^|_)(id|no|code|key)$/i.test(key) && String(candidate ?? '') === serialized)
  })
}

export interface InstanceImportCandidate {
  node: LineageNode
  classId: string
  edge: LineageEdge
  businessKey: string
}

/** Build one stable instance upsert plus its instance_of edge. */
export function buildInstanceImport(
  record: Record<string, unknown>,
  options: {
    classId: string
    binding: InstanceSourceBinding
    labelColumn?: string
    identityColumn?: string
  },
): InstanceImportCandidate | null {
  const inferredIdentityColumn = Object.keys(record).find((column) => /(^|_)(id|no|code|key)$/i.test(column))
  const identityColumn = options.identityColumn ?? options.binding.primaryKey ?? inferredIdentityColumn
  if (identityColumn === undefined) return null
  const businessKey = String(record[identityColumn] ?? '')
  if (businessKey === '') return null
  const id = stableInstanceId(options.binding, businessKey)
  const labelColumn = options.labelColumn ?? identityColumn
  const binding: InstanceSourceBinding = {
    ...options.binding,
    primaryKey: identityColumn,
    importedAt: new Date().toISOString(),
  }
  const label = String(record[labelColumn] ?? businessKey)
  return {
    classId: options.classId,
    businessKey,
    node: {
      id,
      label,
      type: 'entity',
      source: 'derived',
      domain: '数据源',
      properties: {
        primaryKey: record[identityColumn],
        values: record,
        sourceBinding: binding,
        reviewStatus: 'pending',
      },
    },
    edge: {
      id: `edge:${id}:instance_of:${options.classId}`,
      from: id,
      to: options.classId,
      label: '实例',
      rel_type: 'instance_of',
      source: 'derived',
      confidence: 1,
    },
  }
}

export interface InstanceRelationCandidate {
  fromInstanceId: string
  toInstanceId: string
  targetClassId: string
  relationType: string
  sourceColumn: string
  confidence: number
}

/** Infer instance-to-instance relations from conventional foreign-key columns. */
export function inferInstanceRelations(
  graph: LineageGraph,
  instance: LineageNode,
  businessKey: string,
): InstanceRelationCandidate[] {
  const values = instance.properties?.values
  const record = typeof values === 'object' && values !== null && !Array.isArray(values) ? values as Record<string, unknown> : {}
  const candidates: InstanceRelationCandidate[] = []
  for (const [column, value] of Object.entries(record)) {
    const root = column.match(FK_PATTERN)?.[1]
    if (root === undefined || value === null || value === undefined || value === '') continue
    const identifierKey = singular(column)
    const targetClass = classByIdentifier(graph, identifierKey, root)
    if (targetClass === undefined || targetClass.id === businessKey) continue
    const target = findInstanceByValue(graph, targetClass.id, value, targetClass.properties?.identifierKey as string | undefined)
    if (target === undefined || target.id === instance.id) continue
    const relationType = column.toLowerCase().includes('parent') ? 'is_a' : 'depends_on'
    candidates.push({
      fromInstanceId: instance.id,
      toInstanceId: target.id,
      targetClassId: targetClass.id,
      relationType,
      sourceColumn: column,
      confidence: 0.65,
    })
  }
  return candidates
}

function instanceOfClasses(graph: LineageGraph, instanceId: string): string[] {
  return graph.edges
    .filter((edge) => edge.from === instanceId && edge.rel_type === 'instance_of')
    .map((edge) => edge.to)
}

function ancestorsOf(graph: LineageGraph, classId: string): string[] {
  const result: string[] = []
  const visited = new Set([classId])
  const queue = graph.edges
    .filter((edge) => edge.from === classId && edge.rel_type === 'is_a')
    .map((edge) => edge.to)
  while (queue.length > 0 && visited.size < graph.nodes.length + 1) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    result.push(current)
    queue.push(...graph.edges.filter((edge) => edge.from === current && edge.rel_type === 'is_a').map((edge) => edge.to))
  }
  return result
}

function recordOf(instance: LineageNode): Record<string, unknown> {
  const values = instance.properties?.values
  return typeof values === 'object' && values !== null && !Array.isArray(values)
    ? values as Record<string, unknown>
    : instance.properties ?? {}
}

function typeMatches(dataType: string, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (/int|integer|decimal|numeric|float|double|real|number/i.test(dataType)) {
    return typeof value === 'number' || (typeof value === 'string' && value !== '' && Number.isFinite(Number(value)))
  }
  if (/date|time/i.test(dataType)) return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
  if (/bool/i.test(dataType)) return typeof value === 'boolean' || value === 'true' || value === 'false'
  return true
}

/**
 * Validate imported instances with identity, attribute, and required-relation
 * checks. This complements ontology validation with data-access metrics.
 */
export function validateInstances(graph: LineageGraph, profile?: OntologyProfile): InstanceQualityReport {
  const ontologyProfile = profile ?? extractOntologyProfile(graph)
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const issueCount = 0
  const reports: InstanceClassQuality[] = []

  for (const classDefinition of ontologyProfile.classes.values()) {
    const instanceEdges = graph.edges.filter((edge) =>
      edge.rel_type === 'instance_of' && (edge.to === classDefinition.id
        || ancestorsOf(graph, edge.to).includes(classDefinition.id)))
    const instances = instanceEdges.map((edge) => nodeById.get(edge.from)).filter((node): node is LineageNode => node !== undefined)
    const issues: InstanceQualityIssue[] = []
    const identityValues = new Map<string, string[]>()
    const requiredRelations = classDefinition.outgoingRelations.filter((relation) => relation.required)

    for (const instance of instances) {
      const record = recordOf(instance)
      const idCandidates = [
        String(record[classDefinition.identifierKey ?? ''] ?? ''),
        ...classDefinition.attributes.filter((attribute) => attribute.identifier).map((attribute) => String(record[attribute.label] ?? '')),
        String(instance.properties?.primaryKey ?? ''),
      ].filter((value) => value !== '')
      const identity = idCandidates[0] ?? instance.id
      identityValues.set(identity, [...(identityValues.get(identity) ?? []), instance.id])

      for (const attribute of classDefinition.attributes) {
        const value = record[attribute.label] ?? record[attribute.id]
        if ((value === undefined || value === null || value === '') && attribute.required) {
          issues.push({ nodeId: instance.id, kind: 'required-missing', message: `${instance.label} 缺少 ${attribute.label}`, attribute: attribute.label })
        }
        if (value !== undefined && value !== null && value !== '' && attribute.dataType !== undefined && !typeMatches(attribute.dataType, value)) {
          issues.push({ nodeId: instance.id, kind: 'datatype', message: `${instance.label}.${attribute.label} 类型不匹配 ${attribute.dataType}`, attribute: attribute.label })
        }
        if (value !== undefined && value !== null && value !== ''
          && attribute.allowedValues !== undefined && attribute.allowedValues.length > 0
          && !attribute.allowedValues.includes(String(value))) {
          issues.push({ nodeId: instance.id, kind: 'enum', message: `${instance.label}.${attribute.label} 不在取值范围`, attribute: attribute.label })
        }
      }

      for (const relation of requiredRelations) {
        const hasRelation = graph.edges.some((edge) =>
          edge.from === instance.id && edge.to === relation.toId
          && edge.rel_type === relation.relationType)
        if (!hasRelation) {
          issues.push({
            nodeId: instance.id,
            kind: 'relation-missing',
            message: `${instance.label} 缺少到 ${nodeById.get(relation.toId)?.label ?? relation.toId} 的 ${relation.relationType}`,
          })
        }
      }
    }

    for (const [identity, ids] of identityValues) {
      if (ids.length > 1) {
        for (const id of ids) {
          issues.push({ nodeId: id, kind: 'duplicate', message: `业务标识 ${identity} 存在重复实例` })
        }
      }
    }

    const duplicateCount = [...identityValues.values()].filter((ids) => ids.length > 1).length
    const requiredMissingCount = issues.filter((issue) => issue.kind === 'required-missing').length
    const relationMissingCount = issues.filter((issue) => issue.kind === 'relation-missing').length
    reports.push({
      classId: classDefinition.id,
      classLabel: classDefinition.label,
      instanceCount: instances.length,
      validCount: instances.length - new Set(issues.map((issue) => issue.nodeId)).size,
      duplicateCount,
      requiredMissingCount,
      relationMissingCount,
      coverage: instances.length === 0 ? 1 : (instances.length - new Set(issues.map((issue) => issue.nodeId)).size) / instances.length,
      issues: issues.slice(0, 50),
    })
  }

  const allInstances = graph.nodes.filter((node) => instanceOfClasses(graph, node.id).length > 0)
  const totalIssues = reports.reduce((sum, report) => sum + report.issues.length, 0)
  return {
    classes: reports,
    issueCount: totalIssues,
    validRate: allInstances.length === 0 ? 1 : (allInstances.length - new Set(reports.flatMap((report) => report.issues.map((issue) => issue.nodeId))).size) / allInstances.length,
  }
}

function reviewStatusOf(value: unknown): GovernanceReviewStatus {
  return value === 'confirmed' || value === 'rejected' ? value : 'pending'
}

/** Collect all pending ontology decisions in one reviewable queue. */
export function governanceReviews(graph: LineageGraph): GovernanceReviewItem[] {
  const reviews: GovernanceReviewItem[] = []
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  for (const edge of graph.edges) {
    const status = reviewStatusOf(edge.properties?.reviewStatus)
    const lowTrust = edge.source === 'inferred' || edge.source === 'llm' || (typeof edge.confidence === 'number' && edge.confidence < 0.7)
    if (status !== 'pending' || !lowTrust) continue
    const from = nodeById.get(edge.from)?.label ?? edge.from
    const to = nodeById.get(edge.to)?.label ?? edge.to
    reviews.push({
      id: `edge:${edge.id}`,
      kind: 'relation',
      label: `${from} → ${to}`,
      detail: edge.rel_type ?? edge.label ?? '关联',
      confidence: edge.confidence,
      edgeId: edge.id,
    })
  }

  for (const node of graph.nodes) {
    const bindings = Array.isArray(node.properties?.sourceBindings) ? node.properties!.sourceBindings as Record<string, unknown>[] : []
    bindings.forEach((binding, index) => {
      if (reviewStatusOf(binding.reviewStatus) !== 'pending') return
      reviews.push({
        id: `mapping:${node.id}:${index}`,
        kind: 'mapping',
        label: node.label,
        detail: `${String(binding.connectionName ?? binding.connectionId ?? '数据库')} · ${String(binding.database ?? '')}.${String(binding.objectName ?? '')}`,
        confidence: typeof binding.confidence === 'number' ? binding.confidence : undefined,
        nodeId: node.id,
        bindingIndex: index,
      })
    })

    const isInstance = graph.edges.some((edge) => edge.from === node.id && edge.rel_type === 'instance_of')
    const hasSource = node.properties?.sourceBinding !== undefined || bindings.length > 0
    const imported = hasSource || node.source === 'derived' || node.source === 'inferred'
    if (!isInstance || !imported || reviewStatusOf(node.properties?.reviewStatus) !== 'pending') continue
    const classEdge = graph.edges.find((edge) => edge.from === node.id && edge.rel_type === 'instance_of')
    reviews.push({
      id: `instance:${node.id}`,
      kind: 'instance',
      label: node.label,
      detail: `instance_of ${nodeById.get(classEdge?.to ?? '')?.label ?? classEdge?.to ?? '类'}`,
      confidence: node.confidence,
      nodeId: node.id,
    })
  }

  return reviews
}

function setNodeReviewStatus(node: LineageNode, status: GovernanceReviewStatus): LineageNode {
  return { ...node, properties: { ...node.properties, reviewStatus: status, reviewedAt: new Date().toISOString() } }
}

function setEdgeReviewStatus(edge: LineageEdge, status: GovernanceReviewStatus): LineageEdge {
  return { ...edge, properties: { ...edge.properties, reviewStatus: status, reviewedAt: new Date().toISOString() } }
}

/** Apply one governance decision immutably; rejected mappings remain auditable but inactive. */
export function applyGovernanceReview(graph: LineageGraph, review: GovernanceReviewItem, status: Exclude<GovernanceReviewStatus, 'pending'>): LineageGraph {
  let nodes = graph.nodes.map((node) => ({ ...node }))
  let edges = graph.edges.map((edge) => ({ ...edge }))
  const nodeIndex = review.nodeId === undefined ? -1 : nodes.findIndex((node) => node.id === review.nodeId)

  if (review.kind === 'relation' && review.edgeId !== undefined) {
    edges = edges.map((edge) => edge.id === review.edgeId ? setEdgeReviewStatus(edge, status) : edge)
  }

  if (nodeIndex >= 0) {
    const node = nodes[nodeIndex]!
    if (review.kind === 'instance') {
      nodes[nodeIndex] = setNodeReviewStatus(node, status)
      edges = edges.map((edge) => edge.from === node.id && edge.rel_type === 'instance_of' ? setEdgeReviewStatus(edge, status) : edge)
    }
    if (review.kind === 'mapping' && review.bindingIndex !== undefined) {
      const bindings = Array.isArray(node.properties?.sourceBindings) ? [...node.properties!.sourceBindings as Record<string, unknown>[]] : []
      if (bindings[review.bindingIndex] !== undefined) {
        bindings[review.bindingIndex] = {
          ...bindings[review.bindingIndex]!,
          reviewStatus: status,
          active: status === 'confirmed',
          reviewedAt: new Date().toISOString(),
        }
        nodes[nodeIndex] = { ...node, properties: { ...node.properties, sourceBindings: bindings } }
      }
    }
  }

  return { nodes, edges }
}

/** Apply many governance decisions in one atomic client-side reduction. */
export function applyGovernanceReviews(graph: LineageGraph, reviews: readonly GovernanceReviewItem[], status: Exclude<GovernanceReviewStatus, 'pending'>): LineageGraph {
  return reviews.reduce((current, review) => applyGovernanceReview(current, review, status), graph)
}
