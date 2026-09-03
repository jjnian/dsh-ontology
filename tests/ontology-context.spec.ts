import { describe, expect, it } from 'vitest'
import { buildOntologyContext } from '../src/client/lineage/ontology-context.ts'
import type { LineageGraph } from '../src/client/lineage/lineage-types.ts'

describe('buildOntologyContext', () => {
  it('ranks focused nodes and includes only their relevant edges and constraints', () => {
    const graph: LineageGraph = {
      nodes: [
        { id: 'employee', label: 'Employee', type: 'class', properties: { description: 'employee concept' } },
        { id: 'employee-name', label: 'name', type: 'attribute', properties: { required: true } },
        { id: 'unrelated', label: 'Inventory', type: 'class' },
      ],
      edges: [
        { id: 'attr', from: 'employee-name', to: 'employee', rel_type: 'attribute_of', properties: { required: true } },
      ],
    }
    const context = buildOntologyContext(graph, { query: 'employee name required' })
    expect(context.focus.map((node) => node.id)).toContain('employee')
    expect(context.edges.map((edge) => edge.id)).toContain('attr')
    expect(context.constraints.some((item) => item.kind === 'attribute-required')).toBe(true)
    expect(context.text).toContain('Employee')
    expect(context.text).toContain('使用 lineage_patch')
  })

  it('includes sample instances and quality issues without dumping all data', () => {
    const graph: LineageGraph = {
      nodes: [
        { id: 'order', label: 'Order', type: 'class' },
        { id: 'amount', label: 'amount', type: 'attribute', properties: { required: true, dataType: 'number' } },
        { id: 'o1', label: 'O1', type: 'entity', properties: { values: { amount: 10 } } },
        { id: 'o2', label: 'O2', type: 'entity', properties: { values: {} } },
      ],
      edges: [
        { id: 'ea', from: 'amount', to: 'order', rel_type: 'attribute_of', properties: { required: true } },
        { id: 'i1', from: 'o1', to: 'order', rel_type: 'instance_of' },
        { id: 'i2', from: 'o2', to: 'order', rel_type: 'instance_of' },
      ],
    }
    const context = buildOntologyContext(graph, { query: 'order amount', maxInstancesPerClass: 1 })
    expect(context.instances).toHaveLength(1)
    expect(context.quality.issueCount).toBeGreaterThan(0)
    expect(context.text).toContain('O1')
  })
})
