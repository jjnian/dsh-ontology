/**
 * Ontology definitions for the lineage graph: relation types, node types,
 * and constraints. This is the 类/实例 vocabulary that the
 * LLM must reference when generating graphs, and that the validation engine
 * checks against.
 */

/** One semantic relation type with its constraint metadata. */
export interface OntologyRelationDef {
  id: string
  label: string
  /** Inverse relation, when one exists. */
  inverse?: string
  /** The relation is transitive: a->b, b->c implies a->c. */
  transitive?: boolean
  /** The relation is symmetric: a->b implies b->a. */
  symmetric?: boolean
  /** The relation is functional: each node has at most one target. */
  functional?: boolean
  /** The relation represents an is_a / subclass hierarchy. */
  isHierarchy?: boolean
  /** From/to domain constraints (node type ids), when enforceable. */
  domain?: string[]
  range?: string[]
  /** Maximum incoming edges per node; omit for unbounded. */
  maxIn?: number
  /** Maximum outgoing edges per node; omit for unbounded. */
  maxOut?: number
  description: string
}

export type OntologyLayer = 'class' | 'instance'

/** One node type with its ontology-layer membership. */
export interface OntologyNodeType {
  id: string
  label: string
  /** 默认归属：类 (schema/class) or 实例 (instance/individual). */
  layer: 'class-layer' | 'instance-layer'
  color: string
  bg: string
  description: string
}

/** One ontology class definition (used for disjoint-with checks). */
export interface OntologyClassDef {
  id: string
  label: string
  disjointWith?: string[]
  description?: string
}

/** The canonical relation type set the LLM must choose from. */
export const ONTOLOGY_RELATIONS: readonly OntologyRelationDef[] = [
  { id: 'is_a', label: '继承', inverse: 'has_subclass', transitive: true, isHierarchy: true, domain: ['class'], range: ['class'], maxIn: 1, description: 'Subclass relation: A is a specialization of B. Must form a DAG (no cycles).' },
  { id: 'instance_of', label: '实例', inverse: 'has_instance', domain: ['instance'], range: ['class'], description: 'Instance relation: this node is an instance of the target class (实例 -> 类).' },
  { id: 'part_of', label: '组成', inverse: 'has_part', transitive: true, domain: ['class', 'instance'], range: ['class', 'instance'], description: 'Mereological relation: A is a component of B.' },
  { id: 'depends_on', label: '依赖', description: 'A depends on B for its operation or definition.' },
  { id: 'flows_to', label: '数据流向', domain: ['class', 'instance'], range: ['class', 'instance'], description: 'Data flows from source A to target B; the forward lineage direction.' },
  { id: 'produces', label: '产生', domain: ['instance'], range: ['class', 'instance'], description: 'Process A produces output B.' },
  { id: 'consumes', label: '消耗', domain: ['instance'], range: ['class', 'instance'], description: 'Process A consumes input B.' },
  { id: 'contains', label: '包含', transitive: true, description: 'A contains B (spatial or structural containment).' },
  { id: 'triggers', label: '触发', domain: ['instance'], range: ['instance'], description: 'Event/process A triggers event/process B.' },
  { id: 'precedes', label: '先于', domain: ['instance'], range: ['instance'], description: 'A occurs before B in a temporal or causal sequence.' },
  { id: 'equivalent_to', label: '等价', symmetric: true, domain: ['class'], range: ['class'], description: 'A and B are semantically equivalent classes.' },
  { id: 'disjoint_with', label: '互斥', symmetric: true, domain: ['class'], range: ['class'], description: 'A and B share no common instances (OWL disjointWith).' },
  { id: 'aggregates', label: '聚合', domain: ['class', 'instance'], range: ['class', 'instance'], description: 'A aggregates B (weaker than part_of: loose collection).' },
  { id: 'measures', label: '度量', description: 'Metric A measures entity/process B.' },
  { id: 'constrains', label: '约束', domain: ['class'], range: ['class'], description: 'Constraint A restricts the valid values or behavior of B.' },
  { id: 'derives_from', label: '派生', description: 'A is derived from B (data lineage).' },
  { id: 'attribute_of', label: '属性', domain: ['attribute'], range: ['class'], description: 'Attribute A belongs to entity/class B.' },
]

/** Canonical node type set, split into 类 (schema) and 实例 (instance). */
export const ONTOLOGY_NODE_TYPES: readonly OntologyNodeType[] = [
  { id: 'class', label: '类', layer: 'class-layer', color: '#2563eb', bg: '#eff6ff', description: 'A concept or category in the ontology schema (类).' },
  { id: 'entity', label: '实体', layer: 'instance-layer', color: '#0d9488', bg: '#f0fdfa', description: 'A concrete instance of a class (实例).' },
  { id: 'process', label: '流程', layer: 'class-layer', color: '#059669', bg: '#ecfdf5', description: 'A process type (类).' },
  { id: 'event', label: '事件', layer: 'instance-layer', color: '#d97706', bg: '#fff7ed', description: 'A concrete event occurrence (实例).' },
  { id: 'rule', label: '规则', layer: 'class-layer', color: '#db2777', bg: '#fdf2f8', description: 'A business rule or axiom (类).' },
  { id: 'metric', label: '指标', layer: 'instance-layer', color: '#7c3aed', bg: '#f5f3ff', description: 'A measurable quantity or KPI (实例).' },
  { id: 'attribute', label: '属性', layer: 'class-layer', color: '#0891b2', bg: '#ecfeff', description: 'A datatype property on a class (类).' },
  { id: 'constraint', label: '约束', layer: 'class-layer', color: '#dc2626', bg: '#fef2f2', description: 'A structural constraint on classes or relations (类).' },
]

/** Disjointness pairs for the validation engine. */
export const ONTOLOGY_DISJOINT_PAIRS: readonly [string, string][] = [
  ['class', 'entity'],
  ['process', 'event'],
  ['rule', 'constraint'],
]

const RELATION_MAP = new Map(ONTOLOGY_RELATIONS.map((r) => [r.id, r]))
const NODE_TYPE_MAP = new Map(ONTOLOGY_NODE_TYPES.map((t) => [t.id, t]))

export function normalizeOntologyLayer(value: unknown): OntologyLayer | undefined {
  if (value === 'class' || value === 'class-layer') return 'class'
  if (value === 'instance' || value === 'instance-layer') return 'instance'
  return undefined
}

/** Resolve a node's governance layer; old graphs fall back to their category default. */
export function nodeLayer(node: { layer?: unknown; type?: unknown } | undefined): OntologyLayer {
  const explicit = normalizeOntologyLayer(node?.layer)
  if (explicit !== undefined) return explicit
  return nodeTypeDef(typeof node?.type === 'string' ? node.type : undefined)?.layer === 'instance-layer' ? 'instance' : 'class'
}

/** True when an edge endpoint matches a relation definition selector such as class, instance, class, or attribute. */
export function endpointMatchesLayer(node: { layer?: unknown; type?: unknown } | undefined, selector: string): boolean {
  const resolved = nodeLayer(node)
  if (selector === 'class' || selector === 'instance') return resolved === selector
  return node?.type === selector
}

/** Look up a relation definition; undefined for unknown (legacy free-form) rel_types. */
export function relationDef(id?: string): OntologyRelationDef | undefined {
  return RELATION_MAP.get(id ?? '')
}

/** Look up a node type definition; undefined for unknown types. */
export function nodeTypeDef(id?: string): OntologyNodeType | undefined {
  return NODE_TYPE_MAP.get(id ?? '')
}

/** The canonical relation ids, for the tool schema enum. */
export const ONTOLOGY_RELATION_IDS: readonly string[] = ONTOLOGY_RELATIONS.map((r) => r.id)
/** The canonical node type ids, for the tool schema enum. */
export const ONTOLOGY_NODE_TYPE_IDS: readonly string[] = ONTOLOGY_NODE_TYPES.map((t) => t.id)
