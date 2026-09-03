import { describe, expect, it } from 'vitest'
import {
  applyGovernanceReview,
  applyGovernanceReviews,
  buildInstanceImport,
  classifySourceMapping,
  inferInstanceRelations,
  stableInstanceId,
  validateInstances,
  governanceReviews,
} from '../src/client/lineage/data-integration.ts'
import type { LineageGraph } from '../src/client/lineage/lineage-types.ts'

describe('source mapping strategy', () => {
  it('detects join, dictionary, view, and normal class mappings', () => {
    const graph: LineageGraph = { nodes: [], edges: [] }
    expect(classifySourceMapping({
      name: 'order_product', type: 'table',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, defaultValue: '', comment: '' },
        { name: 'order_id', dataType: 'int', nullable: false, defaultValue: '', comment: '' },
        { name: 'product_id', dataType: 'int', nullable: false, defaultValue: '', comment: '' },
      ],
    }, graph).strategy).toBe('join_table')

    expect(classifySourceMapping({
      name: 'order_status', type: 'table',
      columns: [
        { name: 'code', dataType: 'varchar', nullable: false, defaultValue: '', comment: '' },
        { name: 'label', dataType: 'varchar', nullable: false, defaultValue: '', comment: '' },
      ],
    }, graph).strategy).toBe('dictionary_enum')

    expect(classifySourceMapping({ name: 'order_summary', type: 'view' }, graph).strategy).toBe('derived_view')
    expect(classifySourceMapping({
      name: 'orders', type: 'table',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, defaultValue: '', comment: '' },
        { name: 'name', dataType: 'varchar', nullable: false, defaultValue: '', comment: '' },
      ],
    }, graph).strategy).toBe('one_table_class')
  })
})

describe('instance integration', () => {
  it('creates deterministic stable ids and preserves the business key', () => {
    const binding = { connectionId: 'conn', database: 'db', objectName: 'orders' }
    const first = buildInstanceImport({ id: 100, name: 'Order 100' }, { classId: 'order', binding })
    const second = buildInstanceImport({ id: 100, name: 'Order 100' }, { classId: 'order', binding })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.node.id).toBe(second!.node.id)
    expect(first!.node.id).toBe(stableInstanceId(binding, '100'))
    expect(first!.node.properties?.values).toEqual({ id: 100, name: 'Order 100' })
  })

  it('infers instance relations from foreign-key values', () => {
    const graph: LineageGraph = {
      nodes: [
        { id: 'order', label: 'order', type: 'class' },
        { id: 'order-instance', label: '100', type: 'entity', properties: { primaryKey: 100, values: { id: 100 } } },
        { id: 'item-instance', label: 'Item', type: 'entity', properties: { values: { order_id: 100 } } },
      ],
      edges: [
        { id: 'e1', from: 'order-instance', to: 'order', rel_type: 'instance_of' },
      ],
    }
    const relations = inferInstanceRelations(graph, graph.nodes[2]!, 'item-1')
    expect(relations).toHaveLength(1)
    expect(relations[0]?.toInstanceId).toBe('order-instance')
    expect(relations[0]?.relationType).toBe('depends_on')
  })
})

describe('instance quality', () => {
  it('reports required attribute, duplicate identity, and relation coverage', () => {
    const graph: LineageGraph = {
      nodes: [
        { id: 'order', label: 'Order', type: 'class' },
        { id: 'order-name', label: 'name', type: 'attribute', properties: { required: true, dataType: 'string' } },
        { id: 'a', label: 'A', type: 'entity', properties: { primaryKey: 'A', values: { name: 'A' } } },
        { id: 'a2', label: 'A', type: 'entity', properties: { primaryKey: 'A', values: { name: 'A' } } },
        { id: 'b', label: 'B', type: 'entity', properties: { primaryKey: 'B', values: {} } },
      ],
      edges: [
        { id: 'ea', from: 'order-name', to: 'order', rel_type: 'attribute_of', properties: { required: true } },
        { id: 'ia', from: 'a', to: 'order', rel_type: 'instance_of' },
        { id: 'ia2', from: 'a2', to: 'order', rel_type: 'instance_of' },
        { id: 'ib', from: 'b', to: 'order', rel_type: 'instance_of' },
      ],
    }
    const report = validateInstances(graph)
    const order = report.classes.find((item) => item.classId === 'order')
    expect(order?.instanceCount).toBe(3)
    expect(order?.duplicateCount).toBe(1)
    expect(order?.requiredMissingCount).toBe(1)
    expect(report.issueCount).toBeGreaterThan(0)
  })
})

describe('governance review', () => {
  it('collects and confirms pending relation, mapping, and instance decisions', () => {
    const graph: LineageGraph = {
      nodes: [
        { id: 'customer', label: 'Customer', type: 'class' },
        {
          id: 'customer-1',
          label: 'Customer 1',
          layer: 'instance',
          type: 'entity',
          source: 'derived',
          properties: {
            reviewStatus: 'pending',
            sourceBindings: [{ connectionId: 'conn', database: 'db', objectName: 'customers', reviewStatus: 'pending' }],
          },
        },
      ],
      edges: [
        { id: 'instance-edge', from: 'customer-1', to: 'customer', rel_type: 'instance_of', source: 'inferred', properties: { reviewStatus: 'pending' } },
        { id: 'inferred-edge', from: 'customer', to: 'customer', rel_type: 'depends_on', source: 'inferred', properties: { reviewStatus: 'pending' } },
      ],
    }

    const reviews = governanceReviews(graph)
    expect(reviews.map((review) => review.kind)).toEqual(['relation', 'relation', 'mapping', 'instance'])

    const instanceReview = reviews.find((review) => review.kind === 'instance')!
    const confirmed = applyGovernanceReview(graph, instanceReview, 'confirmed')
    const instance = confirmed.nodes.find((node) => node.id === 'customer-1')!
    const instanceEdge = confirmed.edges.find((edge) => edge.id === 'instance-edge')!
    expect(instance.properties?.reviewStatus).toBe('confirmed')
    expect(instanceEdge.properties?.reviewStatus).toBe('confirmed')
  })

  it('confirms multiple governance decisions in one pass', () => {
    const graph: LineageGraph = {
      nodes: [
        { id: 'customer', label: 'Customer', type: 'class' },
        { id: 'customer-1', label: 'Customer 1', layer: 'instance', type: 'entity', source: 'derived', properties: { reviewStatus: 'pending' } },
      ],
      edges: [
        { id: 'instance-edge', from: 'customer-1', to: 'customer', rel_type: 'instance_of', source: 'inferred', properties: { reviewStatus: 'pending' } },
      ],
    }
    const reviews = governanceReviews(graph)
    const next = applyGovernanceReviews(graph, reviews, 'confirmed')
    expect(next.nodes[1]?.properties?.reviewStatus).toBe('confirmed')
    expect(next.edges[0]?.properties?.reviewStatus).toBe('confirmed')
  })
})
