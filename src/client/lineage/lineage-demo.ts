import type { LineageGraph } from './lineage-types.ts'

/**
 * A small built-in lineage sample so the tab renders immediately without a
 * file. Shapes mirror an EIC-CC ontology extraction: objects, processes,
 * attributes and metrics connected by directed lineage edges.
 */
export const DEMO_LINEAGE: LineageGraph = {
  nodes: [
    { id: 'n1', label: '客户', type: 'entity', domain: 'CRM' },
    { id: 'n2', label: '订单', type: 'class', domain: '订单域' },
    { id: 'n3', label: '商品', type: 'class', domain: '订单域' },
    { id: 'n4', label: '下单流程', type: 'process', domain: '交易' },
    { id: 'n5', label: '支付流程', type: 'process', domain: '交易' },
    { id: 'n6', label: '订单金额', type: 'attribute', domain: '订单域' },
    { id: 'n7', label: '履约事件', type: 'event', domain: '仓储' },
    { id: 'n8', label: '库存', type: 'class', domain: '仓储' },
    { id: 'n9', label: 'GMV 指标', type: 'metric', domain: '经营' },
    { id: 'n10', label: '风控规则', type: 'rule', domain: '风控' },
    { id: 'n11', label: '退款流程', type: 'process', domain: '售后' },
    { id: 'n12', label: '退款单', type: 'class', domain: '售后' },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n4', label: '发起', source: 'derived' },
    { id: 'e2', from: 'n4', to: 'n2', label: '产生', source: 'derived' },
    { id: 'e3', from: 'n2', to: 'n3', label: '包含', source: 'derived' },
    { id: 'e4', from: 'n2', to: 'n6', label: '拥有', source: 'inferred' },
    { id: 'e5', from: 'n4', to: 'n5', label: '触发', source: 'derived' },
    { id: 'e6', from: 'n5', to: 'n7', label: '完成后', source: 'derived' },
    { id: 'e7', from: 'n7', to: 'n8', label: '扣减', source: 'derived' },
    { id: 'e8', from: 'n6', to: 'n9', label: '聚合', source: 'derived' },
    { id: 'e9', from: 'n10', to: 'n5', label: '拦截', source: 'manual' },
    { id: 'e10', from: 'n5', to: 'n11', label: '失败转入', source: 'derived' },
    { id: 'e11', from: 'n11', to: 'n12', label: '产生', source: 'derived' },
    { id: 'e12', from: 'n8', to: 'n7', label: '缺货回执', source: 'inferred' },
  ],
}
