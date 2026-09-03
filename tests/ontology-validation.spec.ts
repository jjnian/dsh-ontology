import { describe, expect, it } from 'vitest'
import { validateOntology } from '../src/client/lineage/ontology-validation.ts'
import type { LineageEdge, LineageGraph, LineageNode } from '../src/client/lineage/lineage-types.ts'

function graphWith(nodes: LineageNode[], edges: LineageEdge[] = []): LineageGraph {
  return { nodes, edges }
}

describe('validateOntology conflict detection', () => {
  it('detects the same label with different meanings', () => {
    const graph = graphWith([
      { id: 'a', label: '客户', type: 'class', properties: { description: '买方主体' } },
      { id: 'b', label: '客户', type: 'class', properties: { description: '内部客户编码' } },
    ])
    const issues = validateOntology(graph)
    expect(issues.some((issue) => issue.category === '同名不同义')).toBe(true)
  })

  it('detects synonyms without an equivalent relation', () => {
    const graph = graphWith([
      { id: 'a', label: '客户', type: 'class', properties: { aliases: ['顾客'] } },
      { id: 'b', label: '顾客', type: 'class' },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '同义不同名')).toBe(true)
  })

  it('detects conflicting attribute types', () => {
    const graph = graphWith([
      { id: 'a', label: '客户编号', type: 'attribute', properties: { dataType: 'string' } },
      { id: 'b', label: '客户编号', type: 'attribute', properties: { dataType: 'number' } },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '属性类型冲突')).toBe(true)
  })

  it('detects opposite directed relations', () => {
    const graph = graphWith([
      { id: 'a', label: 'A', type: 'class' },
      { id: 'b', label: 'B', type: 'class' },
    ], [
      { id: 'e1', from: 'a', to: 'b', rel_type: 'depends_on' },
      { id: 'e2', from: 'b', to: 'a', rel_type: 'depends_on' },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '关系方向冲突')).toBe(true)
  })

  it('detects positive and negative rule contradictions', () => {
    const graph = graphWith([
      { id: 'a', label: '客户必须具有唯一编号', type: 'rule' },
      { id: 'b', label: '客户不得具有唯一编号', type: 'rule' },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '规则冲突')).toBe(true)
  })

  it('detects a source mapping without ontology attributes', () => {
    const graph = graphWith([
      { id: 'a', label: '客户', type: 'class', properties: { sourceBindings: [{ objectName: 'customer' }] } },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '数据源结构不一致')).toBe(true)
  })

  it('rejects an is_a edge from an explicit instance to a class', () => {
    const graph = graphWith([
      { id: 'customer', label: '客户', type: 'class' },
      { id: 'customer-1', label: '客户 1', layer: 'instance', type: 'entity' },
    ], [
      { id: 'edge-1', from: 'customer-1', to: 'customer', rel_type: 'is_a' },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '方向类型不匹配')).toBe(true)
  })

  it('rejects more than one confirmed class hierarchy edge into a subclass', () => {
    const graph = graphWith([
      { id: 'root', label: 'Root', type: 'class' },
      { id: 'parent-a', label: 'Parent A', type: 'class' },
      { id: 'parent-b', label: 'Parent B', type: 'class' },
      { id: 'child', label: 'Child', type: 'class' },
    ], [
      { id: 'edge-a', from: 'parent-a', to: 'child', rel_type: 'is_a' },
      { id: 'edge-b', from: 'parent-b', to: 'child', rel_type: 'is_a' },
    ])
    expect(validateOntology(graph).some((issue) => issue.category === '关系基数冲突')).toBe(true)
  })
})
