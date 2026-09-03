import { describe, expect, it } from 'vitest'
import { extractOntologyFromDdl, extractOntologyFromSql, extractOntologyFromText } from '../src/ontology-assets.ts'

describe('extractOntologyFromText', () => {
  it('extracts headings, definitions, rules, and document evidence', () => {
    const graph = extractOntologyFromText([
      '# 客户管理',
      '客户是指与公司发生业务往来的组织或个人。',
      '客户必须具有唯一客户编号。',
      '## 个人客户',
    ].join('\n'), 'docs/customer.md')

    expect(graph.nodes.map((node) => node.type)).toContain('class')
    expect(graph.nodes.map((node) => node.type)).toContain('rule')
    expect(graph.nodes.every((node) => node.properties?.sourceAsset === 'docs/customer.md')).toBe(true)
    expect(graph.edges.some((edge) => edge.rel_type === 'is_a')).toBe(true)
    expect(graph.edges.some((edge) => edge.rel_type === 'constrains')).toBe(true)
  })
})

describe('extractOntologyFromDdl', () => {
  it('extracts tables, columns, comments, and foreign keys', () => {
    const sql = `
      CREATE TABLE enterprise (
        enterprise_id BIGINT PRIMARY KEY COMMENT '企业编号',
        enterprise_name VARCHAR(200) COMMENT '企业名称'
      );
      CREATE TABLE customer (
        customer_id BIGINT PRIMARY KEY COMMENT '客户编号',
        enterprise_id BIGINT,
        FOREIGN KEY (enterprise_id) REFERENCES enterprise(enterprise_id)
      );
    `
    const graph = extractOntologyFromDdl(sql, 'schema.sql')
    expect(graph.nodes.filter((node) => node.type === 'class').map((node) => node.label)).toEqual(['enterprise', 'customer'])
    expect(graph.nodes.filter((node) => node.type === 'attribute').some((node) => node.label === '企业编号')).toBe(true)
    expect(graph.edges.some((edge) => edge.rel_type === 'attribute_of')).toBe(true)
    const foreignKey = graph.edges.find((edge) => edge.rel_type === 'depends_on')
    expect(foreignKey?.source).toBe('derived')
    expect(foreignKey?.confidence).toBe(1)
  })

  it('infers foreign-key-like references from naming conventions', () => {
    const sql = `
      CREATE TABLE customer (
        customer_id BIGINT PRIMARY KEY
      );
      CREATE TABLE orders (
        order_id BIGINT PRIMARY KEY,
        customer_id BIGINT
      );
    `
    const graph = extractOntologyFromDdl(sql, 'schema.sql')
    const edge = graph.edges.find((candidate) => candidate.rel_type === 'depends_on' && candidate.source === 'inferred')
    expect(edge).toBeDefined()
    expect(edge?.confidence).toBe(0.5)
    expect(edge?.properties?.childObject).toBe('orders')
    expect(edge?.properties?.parentObject).toBe('customer')
    expect(edge?.properties?.reviewStatus).toBe('candidate')
  })
})

describe('extractOntologyFromSql', () => {
  it('extracts deterministic SQL lineage from INSERT, CTAS, and MERGE statements', () => {
    const graph = extractOntologyFromSql(`
      INSERT INTO dws_order_summary SELECT * FROM ods_order;
      CREATE TABLE dm_customer_order AS SELECT * FROM dws_customer JOIN dws_order ON 1=1;
      MERGE INTO dm_customer_profit USING dws_profit ON 1=1 WHEN MATCHED THEN UPDATE SET 1=1;
      WITH latest AS (SELECT * FROM ods_event) INSERT INTO dm_event SELECT * FROM latest;
    `, 'warehouse.sql')

    const labels = new Map(graph.nodes.map((node) => [node.id, node.label]))
    const relations = graph.edges.map((edge) => `${labels.get(edge.from)}=>${labels.get(edge.to)}`)
    expect(relations.some((relation) => relation.endsWith('=>dws_order_summary'))).toBe(true)
    expect(relations.some((relation) => relation.endsWith('=>dm_customer_order'))).toBe(true)
    expect(relations.some((relation) => relation.endsWith('=>dm_customer_profit'))).toBe(true)
    expect(relations.some((relation) => relation.endsWith('=>dm_event'))).toBe(true)
    expect(graph.edges.every((edge) => edge.source === 'derived' && edge.confidence === 1)).toBe(true)
    expect(graph.edges.some((edge) => edge.to?.includes('latest'))).toBe(false)
  })
})
