import type { LineageGraph, LineageNode } from './lineage-types.ts'
import { extractOntologyProfile } from './ontology-semantics.ts'
import { reasonOntology } from './ontology-reasoner.ts'
import { validateInstances } from './data-integration.ts'

export interface OntologyContextOptions {
  query: string
  maxNodes?: number
  maxInstancesPerClass?: number
  includeMappings?: boolean
  includeQuality?: boolean
}

export interface OntologyContext {
  graphName?: string
  focus: LineageNode[]
  relatedNodes: LineageNode[]
  edges: LineageGraph['edges']
  constraints: { id: string; kind: string; label: string }[]
  mappings: { nodeId: string; label: string; binding: Record<string, unknown> }[]
  instances: { id: string; label: string; classId: string; values: Record<string, unknown> }[]
  quality: { validRate: number; issueCount: number; issues: string[] }
  instructions: string[]
  text: string
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'to', 'in', 'on', 'is', 'are', 'what', 'which',
  '请', '的', '和', '与', '或者', '以及', '哪些', '什么', '如何', '怎么', '是否', '有没有', '可以', '需要',
])

function tokens(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[_\-.]+/g, ' ')
  const latin = normalized.match(/[a-z0-9]{2,}/g) ?? []
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) ?? []
  const phrases = normalized.match(/[\u4e00-\u9fff]{2,6}/g) ?? []
  return [...latin, ...phrases, ...cjk].filter((item) => !STOP_WORDS.has(item))
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\s-]+/g, '')
}

function scoreNode(node: LineageNode, queryTokens: string[]): number {
  const aliases = Array.isArray(node.properties?.aliases) ? (node.properties!.aliases as unknown[]).map(String) : []
  const description = typeof node.properties?.description === 'string' ? node.properties.description : ''
  const haystacks = [node.label, node.type, node.domain ?? '', description, ...aliases]
  const normalizedHaystacks = haystacks.map(normalize)
  let score = 0
  for (const token of queryTokens) {
    if (token === '') continue
    if (haystacks.some((item) => item.toLowerCase() === token)) score += 4
    if (haystacks.some((item) => item.toLowerCase().includes(token))) score += 2.5
    if (normalizedHaystacks.some((item) => item.includes(normalize(token)))) score += 2
  }
  if (node.type === 'class' || node.type === 'process' || node.type === 'rule') score += 0.5
  if (typeof node.confidence === 'number') score += node.confidence * 0.2
  return score
}

function compactNode(node: LineageNode): LineageNode {
  const properties: Record<string, unknown> = {}
  if (typeof node.properties?.description === 'string') properties.description = node.properties.description
  if (Array.isArray(node.properties?.aliases)) properties.aliases = node.properties.aliases
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    ...(node.domain !== undefined ? { domain: node.domain } : {}),
    ...(node.source !== undefined ? { source: node.source } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  }
}

/**
 * Build a compact, retrieval-focused ontology context for LLM prompts.
 * It intentionally excludes full instance dumps and unrelated graph branches.
 */
export function buildOntologyContext(graph: LineageGraph, options: OntologyContextOptions): OntologyContext {
  const maxNodes = Math.max(1, options.maxNodes ?? 16)
  const maxInstances = Math.max(0, options.maxInstancesPerClass ?? 3)
  const queryTokens = tokens(options.query)
  const profile = extractOntologyProfile(graph)
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  const scored = graph.nodes
    .map((node) => ({ node, score: scoreNode(node, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label, 'zh'))
  const focus = scored.slice(0, maxNodes).map((item) => item.node)

  const focusIds = new Set(focus.map((node) => node.id))
  const neighborIds = new Set<string>()
  const edges = graph.edges.filter((edge) => {
    const included = focusIds.has(edge.from) || focusIds.has(edge.to)
    if (!included) return false
    neighborIds.add(edge.from)
    neighborIds.add(edge.to)
    return true
  })
  for (const id of neighborIds) focusIds.add(id)
  const relatedNodes = graph.nodes.filter((node) => focusIds.has(node.id) && !focus.some((item) => item.id === node.id))

  const selectedIds = new Set([...focus, ...relatedNodes].map((node) => node.id))
  const constraints = profile.constraints
    .filter((constraint) => constraint.classId === undefined || selectedIds.has(constraint.classId)
      || (constraint.attributeId !== undefined && selectedIds.has(constraint.attributeId)))
    .slice(0, 40)
    .map((constraint) => ({ id: constraint.id, kind: constraint.kind, label: constraint.label }))

  const mappings: OntologyContext['mappings'] = []
  for (const node of [...focus, ...relatedNodes]) {
    const bindings = Array.isArray(node.properties?.sourceBindings) ? node.properties!.sourceBindings as Record<string, unknown>[] : []
    for (const binding of bindings.slice(0, 3)) {
      mappings.push({
        nodeId: node.id,
        label: node.label,
        binding: {
          connectionId: binding.connectionId,
          connectionName: binding.connectionName,
          engine: binding.engine,
          database: binding.database,
          objectName: binding.objectName,
          mappingStrategy: binding.mappingStrategy,
          columnMappings: binding.columnMappings,
        },
      })
    }
  }

  const instanceEdges = graph.edges.filter((edge) =>
    edge.rel_type === 'instance_of' && selectedIds.has(edge.to))
  const instances: OntologyContext['instances'] = []
  const perClass = new Map<string, number>()
  for (const edge of instanceEdges) {
    const used = perClass.get(edge.to) ?? 0
    if (used >= maxInstances) continue
    const instance = nodeById.get(edge.from)
    if (instance === undefined) continue
    const values = instance.properties?.values
    instances.push({
      id: instance.id,
      label: instance.label,
      classId: edge.to,
      values: typeof values === 'object' && values !== null && !Array.isArray(values) ? values as Record<string, unknown> : {},
    })
    perClass.set(edge.to, used + 1)
  }

  const qualityReport = options.includeQuality === false ? undefined : validateInstances(graph, profile)
  const quality = qualityReport === undefined
    ? { validRate: 1, issueCount: 0, issues: [] }
    : {
        validRate: qualityReport.validRate,
        issueCount: qualityReport.issueCount,
        issues: qualityReport.classes
          .flatMap((report) => report.issues.slice(0, 3).map((issue) => `${report.classLabel}: ${issue.message}`))
          .slice(0, 12),
      }

  const reasoning = focus[0] === undefined ? null : reasonOntology(graph, focus[0].id)
  const instructions = [
    '使用提供本体上下文，不要假设未列出的类、属性或关系。',
    '类必须区分业务定义、同义词、业务键和属性；实例必须有稳定来源。',
    '关系必须使用已定义 rel_type；需要约束时给出 required、minCardinality 或 maxCardinality。',
    '不要重发整图；如需修改当前图，使用 lineage_patch 的增量操作。',
    '输出要区分：确定结论、强假设、候选关系、冲突提示和数据佐证。',
  ]

  const sections: string[] = [
    '## 本体上下文',
    ...(focus.length > 0 ? [`焦点: ${focus.map((node) => `${node.label}(${node.type})`).join(', ')}`] : ['焦点: 无']),
    '## 类/节点',
    ...[...focus, ...relatedNodes].slice(0, maxNodes * 2).map((node) => {
      const definition = profile.classes.get(node.id)
      const aliases = Array.isArray(node.properties?.aliases) ? (node.properties!.aliases as unknown[]).join(', ') : ''
      const description = typeof node.properties?.description === 'string' ? node.properties.description : ''
      return `- ${node.label} [${node.type}] id=${node.id}${node.domain ? ` domain=${node.domain}` : ''}${description ? ` 定义=${description}` : ''}${aliases ? ` 别名=${aliases}` : ''}${definition?.identifierKey ? ` 业务键=${definition.identifierKey}` : ''}`
    }),
    '## 关系',
    ...edges.slice(0, 60).map((edge) => `- ${nodeById.get(edge.from)?.label ?? edge.from} --${edge.rel_type ?? edge.label ?? '关联'}--> ${nodeById.get(edge.to)?.label ?? edge.to}${edge.properties?.required === true ? ' [必填]' : ''}`),
    ...(constraints.length > 0 ? ['## 约束', ...constraints.map((item) => `- ${item.label}`)] : []),
    ...(mappings.length > 0 ? ['## 数据映射', ...mappings.map((item) => `- ${item.label}: ${item.binding.database}.${item.binding.objectName}`)] : []),
    ...(instances.length > 0 ? ['## 实例样本', ...instances.map((item) => `- ${item.label} -> ${nodeById.get(item.classId)?.label ?? item.classId}: ${JSON.stringify(item.values).slice(0, 240)}`)] : []),
    ...(reasoning?.modelGaps.length ? ['## 建模缺口', ...reasoning.modelGaps.map((gap) => `- ${gap}`)] : []),
    ...(quality.issueCount > 0 ? ['## 数据质量', `validRate=${quality.validRate.toFixed(2)}`, ...quality.issues.map((issue) => `- ${issue}`)] : []),
    '## 工作规则',
    ...instructions.map((item) => `- ${item}`),
  ]

  return {
    focus,
    relatedNodes,
    edges,
    constraints,
    mappings,
    instances,
    quality,
    instructions,
    text: sections.join('\n'),
  }
}
