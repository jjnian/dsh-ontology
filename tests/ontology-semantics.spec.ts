import { describe, expect, it } from 'vitest'
import { extractOntologyProfile, validateInstanceAgainstClass } from '../src/client/lineage/ontology-semantics.ts'
import { inferTransitiveEdges, reasonOntology } from '../src/client/lineage/ontology-reasoner.ts'
import { validateOntology } from '../src/client/lineage/ontology-validation.ts'

const graph = {
  nodes: [
    { id: 'person', label: 'Person', type: 'class', properties: { description: 'A person' } },
    { id: 'person-name', label: 'name', type: 'attribute', properties: { required: true, dataType: 'string' } },
    { id: 'person-age', label: 'age', type: 'attribute', properties: { dataType: 'integer', maxValue: 150 } },
    { id: 'employee', label: 'Employee', type: 'class', properties: { identifierKey: 'employeeNo' } },
    { id: 'employee-no', label: 'employeeNo', type: 'attribute', properties: { identifier: true, required: true, unique: true, dataType: 'string' } },
    { id: 'alice', label: 'Alice', type: 'entity', properties: { values: { name: 'Alice', age: 180, employeeNo: 'E001' } } },
    { id: 'a', label: 'A', type: 'class' },
    { id: 'b', label: 'B', type: 'class' },
    { id: 'c', label: 'C', type: 'class' },
  ],
  edges: [
    { id: 'e-name', from: 'person-name', to: 'person', rel_type: 'attribute_of' },
    { id: 'e-age', from: 'person-age', to: 'person', rel_type: 'attribute_of' },
    { id: 'e-no', from: 'employee-no', to: 'employee', rel_type: 'attribute_of' },
    { id: 'e-isa', from: 'employee', to: 'person', rel_type: 'is_a' },
    { id: 'e-instance', from: 'alice', to: 'employee', rel_type: 'instance_of' },
    { id: 'e-ab', from: 'a', to: 'b', rel_type: 'part_of' },
    { id: 'e-bc', from: 'b', to: 'c', rel_type: 'part_of' },
  ],
}

describe('ontology semantics', () => {
  it('extracts class attributes and machine-readable constraints', () => {
    const profile = extractOntologyProfile(graph)
    expect(profile.classes.get('person')?.attributes.map((item) => item.id)).toEqual(['person-name', 'person-age'])
    expect(profile.classes.get('employee')?.attributes.map((item) => item.id)).toEqual(['employee-no'])
    expect(profile.constraints.map((item) => item.kind)).toContain('attribute-required')
    expect(profile.constraints.map((item) => item.kind)).toContain('attribute-datatype')
  })

  it('validates instance values against the effective class attributes', () => {
    const profile = extractOntologyProfile(graph)
    const instance = graph.nodes[5]!
    const violations = validateInstanceAgainstClass(
      instance,
      profile.classes.get('employee')!,
      [...profile.classes.get('employee')!.attributes, ...profile.classes.get('person')!.attributes],
    )
    expect(violations.map((item) => item.kind)).toContain('attribute-range')
  })
})

describe('ontology reasoner', () => {
  it('expands ancestors and inherited attributes', () => {
    const reasoning = reasonOntology(graph, 'employee')
    expect(reasoning?.ancestors.map((node) => node.id)).toEqual(['person'])
    expect(reasoning?.effectiveAttributes.map((attribute) => attribute.id)).toContain('person-name')
    expect(reasoning?.modelGaps).toContain('缺少业务定义')
  })

  it('infers deterministic transitive edges without replacing direct edges', () => {
    const inferred = inferTransitiveEdges(graph, 'part_of')
    expect(inferred).toHaveLength(1)
    expect(inferred[0]?.from).toBe('a')
    expect(inferred[0]?.to).toBe('c')
  })
})

describe('ontology validation with semantics', () => {
  it('reports instance constraint violations', () => {
    const issues = validateOntology(graph)
    expect(issues.some((issue) => issue.category === '实例约束冲突')).toBe(true)
  })
})
