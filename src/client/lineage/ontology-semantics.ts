import type { LineageEdge, LineageGraph, LineageNode } from './lineage-types.ts'
import { nodeTypeDef } from './ontology-definitions.ts'

export interface OntologyAttributeDefinition {
  id: string
  label: string
  classId: string
  required: boolean
  unique: boolean
  identifier: boolean
  dataType?: string
  allowedValues?: string[]
  minValue?: number
  maxValue?: number
  pattern?: string
  description?: string
}

export interface OntologyRelationUsage {
  id: string
  relationType: string
  fromId: string
  toId: string
  required: boolean
  minCardinality?: number
  maxCardinality?: number
  observedCount: number
  label?: string
}

export interface OntologyClassDefinition {
  id: string
  label: string
  type: string
  aliases: string[]
  description?: string
  uri?: string
  identifierKey?: string
  attributes: OntologyAttributeDefinition[]
  outgoingRelations: OntologyRelationUsage[]
  incomingRelations: OntologyRelationUsage[]
}

export type OntologyConstraintKind =
  | 'attribute-required'
  | 'attribute-unique'
  | 'attribute-datatype'
  | 'attribute-allowed-values'
  | 'attribute-range'
  | 'attribute-pattern'
  | 'relation-required'
  | 'relation-cardinality'
  | 'business-rule'

export interface OntologyConstraint {
  id: string
  kind: OntologyConstraintKind
  classId?: string
  attributeId?: string
  edgeId?: string
  label: string
  value?: unknown
  source: 'attribute' | 'relation' | 'business-rule'
}

export interface OntologyProfile {
  classes: Map<string, OntologyClassDefinition>
  attributes: Map<string, OntologyAttributeDefinition[]>
  constraints: OntologyConstraint[]
}

export interface OntologyConstraintViolation {
  nodeId: string
  constraintId: string
  kind: OntologyConstraintKind
  message: string
  attributeId?: string
}

const NUMBER_PATTERN = /int|integer|decimal|numeric|float|double|real|number/i
const DATE_PATTERN = /date|time/i

function propertiesOf(node: LineageNode): Record<string, unknown> {
  return node.properties ?? {}
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter((item) => item !== '')
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isClassNode(node: LineageNode): boolean {
  return nodeTypeDef(node.type)?.layer === 'class-layer'
}

function attributeFromNode(node: LineageNode, classId: string, edge?: LineageEdge): OntologyAttributeDefinition {
  const properties = propertiesOf(node)
  const edgeProperties = edge?.properties ?? {}
  const required = properties.required === true
    || properties.nullable === false
    || edgeProperties.required === true
  const unique = properties.unique === true || properties.primaryKey === true
  const identifier = properties.identifier === true || properties.primaryKey === true
  const dataType = typeof properties.dataType === 'string' ? properties.dataType : undefined
  const description = typeof properties.description === 'string' ? properties.description : undefined
  const pattern = typeof properties.pattern === 'string' ? properties.pattern : undefined
  const allowedValues = properties.allowedValues !== undefined
    ? stringArray(properties.allowedValues)
    : properties.enum !== undefined ? stringArray(properties.enum) : []
  return {
    id: node.id,
    label: node.label,
    classId,
    required,
    unique,
    identifier,
    ...(dataType !== undefined ? { dataType } : {}),
    ...(allowedValues.length > 0 ? { allowedValues } : {}),
    ...(optionalNumber(properties.minValue) !== undefined ? { minValue: optionalNumber(properties.minValue) } : {}),
    ...(optionalNumber(properties.maxValue) !== undefined ? { maxValue: optionalNumber(properties.maxValue) } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}

function relationUsage(edge: LineageEdge): OntologyRelationUsage {
  const properties = edge.properties ?? {}
  const cardinality = typeof properties.cardinality === 'string' ? properties.cardinality.trim() : ''
  const cardinalityMatch = cardinality.match(/^(\d+)\s*(?:\.\.\s*(\d+|\*))?$/)
  const minCardinality = optionalNumber(properties.minCardinality)
    ?? (cardinalityMatch !== null ? Number(cardinalityMatch[1]) : undefined)
  const maxCardinality = optionalNumber(properties.maxCardinality)
    ?? (cardinalityMatch !== null
      ? cardinalityMatch[2] === '*' || cardinalityMatch[2] === undefined ? undefined : Number(cardinalityMatch[2])
      : undefined)
  return {
    id: edge.id,
    relationType: edge.rel_type ?? edge.label ?? 'associated_with',
    fromId: edge.from,
    toId: edge.to,
    required: properties.required === true || minCardinality === 1,
    ...(minCardinality !== undefined ? { minCardinality } : {}),
    ...(maxCardinality !== undefined ? { maxCardinality } : {}),
    observedCount: 1,
    ...(edge.label !== undefined ? { label: edge.label } : {}),
  }
}

/**
 * Extract the ontology schema actually encoded in a graph: class definitions,
 * attributes, relation usages, and machine-readable constraints. This remains
 * non-destructive: the graph is the storage, while the profile is a view.
 */
export function extractOntologyProfile(graph: LineageGraph): OntologyProfile {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const classes = new Map<string, OntologyClassDefinition>()
  const attributes = new Map<string, OntologyAttributeDefinition[]>()
  const constraints: OntologyConstraint[] = []

  for (const node of graph.nodes) {
    if (!isClassNode(node)) continue
    const properties = propertiesOf(node)
    classes.set(node.id, {
      id: node.id,
      label: node.label,
      type: node.type,
      aliases: stringArray(properties.aliases),
      ...(typeof properties.description === 'string' ? { description: properties.description } : {}),
      ...(typeof properties.uri === 'string' ? { uri: properties.uri } : {}),
      ...(typeof properties.identifierKey === 'string' ? { identifierKey: properties.identifierKey } : {}),
      attributes: [],
      outgoingRelations: [],
      incomingRelations: [],
    })
  }

  for (const edge of graph.edges) {
    if (edge.rel_type !== 'attribute_of') continue
    const attribute = nodes.get(edge.from)
    const owner = classes.get(edge.to)
    if (attribute === undefined || owner === undefined) continue
    const definition = attributeFromNode(attribute, owner.id, edge)
    owner.attributes.push(definition)
    const existing = attributes.get(owner.id) ?? []
    existing.push(definition)
    attributes.set(owner.id, existing)

    if (definition.required) {
      constraints.push({
        id: `${edge.id}:required`, kind: 'attribute-required', classId: owner.id,
        attributeId: definition.id, label: `${owner.label}.${definition.label} 必填`, value: true, source: 'attribute',
      })
    }
    if (definition.unique) {
      constraints.push({
        id: `${edge.id}:unique`, kind: 'attribute-unique', classId: owner.id,
        attributeId: definition.id, label: `${owner.label}.${definition.label} 唯一`, value: true, source: 'attribute',
      })
    }
    if (definition.dataType !== undefined) {
      constraints.push({
        id: `${edge.id}:datatype`, kind: 'attribute-datatype', classId: owner.id,
        attributeId: definition.id, label: `${owner.label}.${definition.label} 数据类型 ${definition.dataType}`,
        value: definition.dataType, source: 'attribute',
      })
    }
    if (definition.allowedValues !== undefined && definition.allowedValues.length > 0) {
      constraints.push({
        id: `${edge.id}:allowed`, kind: 'attribute-allowed-values', classId: owner.id,
        attributeId: definition.id, label: `${owner.label}.${definition.label} 取值范围`, value: definition.allowedValues, source: 'attribute',
      })
    }
    if (definition.minValue !== undefined || definition.maxValue !== undefined) {
      constraints.push({
        id: `${edge.id}:range`, kind: 'attribute-range', classId: owner.id,
        attributeId: definition.id, label: `${owner.label}.${definition.label} 数值范围`,
        value: { min: definition.minValue, max: definition.maxValue }, source: 'attribute',
      })
    }
    if (definition.pattern !== undefined) {
      constraints.push({
        id: `${edge.id}:pattern`, kind: 'attribute-pattern', classId: owner.id,
        attributeId: definition.id, label: `${owner.label}.${definition.label} 格式约束`, value: definition.pattern, source: 'attribute',
      })
    }
  }

  for (const edge of graph.edges) {
    if (edge.rel_type === 'attribute_of') continue
    const from = classes.get(edge.from)
    const to = classes.get(edge.to)
    if (from !== undefined) from.outgoingRelations.push(relationUsage(edge))
    if (to !== undefined) to.incomingRelations.push(relationUsage(edge))
    const properties = edge.properties ?? {}
    if (properties.required === true) {
      constraints.push({
        id: `${edge.id}:relation-required`, kind: 'relation-required', classId: edge.from, edgeId: edge.id,
        label: `${nodes.get(edge.from)?.label ?? edge.from} 必须有 ${edge.rel_type ?? edge.label ?? '关联'} 到 ${nodes.get(edge.to)?.label ?? edge.to}`,
        value: true, source: 'relation',
      })
    }
    const usage = relationUsage(edge)
    if (usage.minCardinality !== undefined || usage.maxCardinality !== undefined) {
      constraints.push({
        id: `${edge.id}:cardinality`, kind: 'relation-cardinality', classId: edge.from, edgeId: edge.id,
        label: `${nodes.get(edge.from)?.label ?? edge.from} → ${nodes.get(edge.to)?.label ?? edge.to} 基数 ${usage.minCardinality ?? 0}..${usage.maxCardinality ?? '*'}`,
        value: { min: usage.minCardinality, max: usage.maxCardinality }, source: 'relation',
      })
    }
  }

  for (const edge of graph.edges) {
    if (edge.rel_type !== 'constrains') continue
    const rule = nodes.get(edge.from)
    const target = classes.get(edge.to)
    if (rule === undefined || target === undefined) continue
    constraints.push({
      id: `${edge.id}:business-rule`, kind: 'business-rule', classId: target.id, edgeId: edge.id,
      label: `${rule.label}${typeof rule.properties?.description === 'string' ? `: ${rule.properties.description}` : ''}`,
      source: 'business-rule',
    })
  }

  return { classes, attributes, constraints }
}

function instanceValues(instance: LineageNode): Record<string, unknown> {
  const values = instance.properties?.values
  if (typeof values === 'object' && values !== null && !Array.isArray(values)) return values as Record<string, unknown>
  return instance.properties ?? {}
}

function typeMatches(dataType: string, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (NUMBER_PATTERN.test(dataType)) return typeof value === 'number' || (typeof value === 'string' && value !== '' && Number.isFinite(Number(value)))
  if (DATE_PATTERN.test(dataType)) return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
  if (/bool/i.test(dataType)) return typeof value === 'boolean' || value === 'true' || value === 'false'
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Validate one instance against the effective attribute constraints of a class. */
export function validateInstanceAgainstClass(
  instance: LineageNode,
  classDefinition: OntologyClassDefinition,
  attributes: OntologyAttributeDefinition[],
): OntologyConstraintViolation[] {
  const values = instanceValues(instance)
  const violations: OntologyConstraintViolation[] = []
  for (const attribute of attributes) {
    const value = values[attribute.label] ?? values[attribute.id]
    if (value === undefined || value === null || value === '') {
      if (attribute.required) {
        violations.push({
          nodeId: instance.id,
          constraintId: `${classDefinition.id}:${attribute.id}:required`,
          kind: 'attribute-required',
          message: `${instance.label} 缺少必填属性 ${attribute.label}`,
          attributeId: attribute.id,
        })
      }
      continue
    }
    if (attribute.dataType !== undefined && !typeMatches(attribute.dataType, value)) {
      violations.push({
        nodeId: instance.id,
        constraintId: `${classDefinition.id}:${attribute.id}:datatype`,
        kind: 'attribute-datatype',
        message: `${instance.label}.${attribute.label} 数据类型应为 ${attribute.dataType}`,
        attributeId: attribute.id,
      })
    }
    if (attribute.allowedValues !== undefined && attribute.allowedValues.length > 0
      && !attribute.allowedValues.includes(String(value))) {
      violations.push({
        nodeId: instance.id,
        constraintId: `${classDefinition.id}:${attribute.id}:allowed`,
        kind: 'attribute-allowed-values',
        message: `${instance.label}.${attribute.label} 的值 ${String(value)} 不在允许范围内`,
        attributeId: attribute.id,
      })
    }
    const numeric = Number(value)
    if ((attribute.minValue !== undefined || attribute.maxValue !== undefined) && Number.isFinite(numeric)) {
      if (attribute.minValue !== undefined && numeric < attribute.minValue) {
        violations.push({
          nodeId: instance.id,
          constraintId: `${classDefinition.id}:${attribute.id}:min`,
          kind: 'attribute-range',
          message: `${instance.label}.${attribute.label} 不能小于 ${attribute.minValue}`,
          attributeId: attribute.id,
        })
      }
      if (attribute.maxValue !== undefined && numeric > attribute.maxValue) {
        violations.push({
          nodeId: instance.id,
          constraintId: `${classDefinition.id}:${attribute.id}:max`,
          kind: 'attribute-range',
          message: `${instance.label}.${attribute.label} 不能大于 ${attribute.maxValue}`,
          attributeId: attribute.id,
        })
      }
    }
    if (attribute.pattern !== undefined && (typeof value === 'string' || typeof value === 'number')
      && !new RegExp(attribute.pattern).test(String(value))) {
      violations.push({
        nodeId: instance.id,
        constraintId: `${classDefinition.id}:${attribute.id}:pattern`,
        kind: 'attribute-pattern',
        message: `${instance.label}.${attribute.label} 不满足格式 ${attribute.pattern}`,
        attributeId: attribute.id,
      })
    }
  }
  return violations
}
