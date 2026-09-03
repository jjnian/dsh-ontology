import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from './context-types.ts'
import { parseLineageGraph, type LineageEdge, type LineageGraph, type LineageNode } from './client/lineage/lineage-types.ts'
import { endpointMatchesLayer, nodeLayer, normalizeOntologyLayer, ONTOLOGY_RELATION_IDS, ONTOLOGY_NODE_TYPE_IDS, relationDef } from './client/lineage/ontology-definitions.ts'
import { validateLineagePatch } from './client/lineage/lineage-patch.ts'
import { extractLineageGraph } from './client/lineage/lineage-extract.ts'
import { buildOntologyContext } from './client/lineage/ontology-context.ts'

function textRender(fn: (v: { name?: string; nodeCount: number; edgeCount: number; rendered: boolean }) => string): (args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as { nodeCount: number; edgeCount: number; rendered: boolean }) }]
}

function currentLineageGraph(ctx: Context, exec: { agent?: { session?: { id?: string } } }): LineageGraph | null {
  const sessionId = exec.agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const events = ctx.sessions.get(sessionId)?.snapshotEvents()
  return events === undefined ? null : extractLineageGraph(events)
}

const NODE_ITEM = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    id: { type: 'string' as const, required: true as const, description: 'Stable unique node id.' },
    label: { type: 'string' as const, required: true as const, description: 'Short display label for the ontology node.' },
    layer: { type: 'string' as const, required: true as const, enum: ['class', 'instance'], description: 'Ontology governance layer: class for schema-level concepts, instance for concrete individuals.' },
    type: { type: 'string' as const, required: true as const, enum: [...ONTOLOGY_NODE_TYPE_IDS], description: 'Ontology node category. Use class/attribute/rule/constraint/process for schema-level nodes, and entity/event/metric for instances unless the explicit layer overrides the category default.' },
    source: { type: 'string' as const, description: 'derived | inferred | preset | manual.' },
    domain: { type: 'string' as const, description: 'Optional domain/subtitle.' },
    properties: {
      type: 'json' as const,
      description: 'Semantic metadata. Use description (business meaning), aliases (synonyms), uri, identifierKey, dataType, required, unique, allowedValues, pattern, minValue or maxValue where applicable.',
    },
    evidence: { type: 'string' as const, description: 'Optional evidence note.' },
    confidence: { type: 'number' as const, description: 'Optional confidence 0..1.' },
  },
}

const EDGE_ITEM = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    id: { type: 'string' as const, required: true as const, description: 'Stable unique edge id.' },
    from: { type: 'string' as const, required: true as const, description: 'Source node id.' },
    to: { type: 'string' as const, required: true as const, description: 'Target node id.' },
    label: { type: 'string' as const, description: 'Short human-readable relation label.' },
    rel_type: { type: 'string' as const, enum: [...ONTOLOGY_RELATION_IDS], description: 'Canonical ontology relation type. The endpoint layers must satisfy the relation definition.' },
    source: { type: 'string' as const, description: 'derived | inferred | preset | manual.' },
    evidence: { type: 'string' as const, description: 'Optional evidence note.' },
    confidence: { type: 'number' as const, description: 'Optional confidence 0..1.' },
    properties: {
      type: 'json' as const,
      description: 'Relation constraints. Use required, minCardinality, and maxCardinality (for example 1..n) where applicable.',
    },
  },
}

/**
 * Register the model-facing `lineage_graph` tool. It turns an explicit
 * ontology/lineage payload (`nodes` + `edges`) into the canonical graph
 * shape, and the right-side lineage tab discovers that call from the
 * session event log (`lineage.graph` route → `extractLineageGraph`).
 */
export function registerLineageTool(ctx: Context): () => void {
  const graphDisposer = ctx.tools.register(defineTool({
    name: 'lineage_graph',
    description:
      'Build an ontology/lineage graph for the current conversation and render it in the right sidebar. '
      + 'First, generate a short descriptive name for the graph (pass it as the ame parameter) — the name should tell the reader what the graph is about. Then think in ontology terms: identify the domain concepts, entities, attributes, processes, events, metrics, and rules that matter, '
      + 'then connect them with named semantic relationships. Pass the complete graph as `nodes` and `edges`. '
      + 'Each node needs `id`, `label`, and `type`; each edge needs `id`, `from`, and `to` (node ids), plus a meaningful `label` or `rel_type`. '
      + 'Use node `type` values such as class, entity, process, event, rule, metric, attribute, or constraint; use `rel_type` for the ontology relationship name. '
      + 'Give every class a business definition, aliases when known, an identifierKey when possible, and model attributes as separate `attribute` nodes connected by `attribute_of`. Add machine-readable constraints in `properties`. '
      + 'The graph becomes the latest lineage graph for the current conversation; open the right-side lineage tab (sidebar + menu) to view it.',
    parameters: {
      name: {
        type: 'string',
        description: 'A short human-readable name for the graph (e.g. "订单履约流程血缘图"). Generate this from the graph content; the name appears in the conversation and the sidebar tab.',
      },
      nodes: {
        type: 'array',
        required: true,
        items: NODE_ITEM,
        description: 'All lineage nodes.',
      },
      edges: {
        type: 'array',
        required: true,
        items: EDGE_ITEM,
        description: 'All lineage edges.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'The human-readable graph name.' },
          nodeCount: { type: 'integer', required: true, description: 'Number of rendered nodes.' },
          edgeCount: { type: 'integer', required: true, description: 'Number of rendered edges.' },
          rendered: { type: 'boolean', required: true, description: 'Whether the graph payload was accepted and sent to the lineage tab.' },
        },
      },
      render: textRender((v) =>
        v.rendered
          ? `Saved ${v.nodeCount} nodes and ${v.edgeCount} edges as the latest lineage graph; open the right-side lineage tab to view it.`
          : 'The lineage graph payload was not rendered.',
      ),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const graph = parseLineageGraph(JSON.stringify({
        nodes: args.nodes as LineageNode[],
        edges: args.edges as LineageEdge[],
      }))
      const issues: string[] = []
      const nodeIds = new Set(graph.nodes.map((node) => node.id))
      for (const node of graph.nodes) {
        if (normalizeOntologyLayer(node.layer) === undefined) issues.push(`node ${node.id}: layer must be class or instance`)
        if (!ONTOLOGY_NODE_TYPE_IDS.includes(node.type)) issues.push(`node ${node.id}: unknown type ${node.type}`)
      }
      for (const edge of graph.edges) {
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
          issues.push(`edge ${edge.id}: endpoint does not exist`)
          continue
        }
        const definition = relationDef(edge.rel_type)
        if (definition === undefined) {
          issues.push(`edge ${edge.id}: unknown rel_type ${edge.rel_type ?? ''}`)
          continue
        }
        const from = graph.nodes.find((node) => node.id === edge.from)
        const to = graph.nodes.find((node) => node.id === edge.to)
        const fromValid = definition.domain === undefined || definition.domain.some((selector) => endpointMatchesLayer(from, selector))
        const toValid = definition.range === undefined || definition.range.some((selector) => endpointMatchesLayer(to, selector))
        if (!fromValid || !toValid) {
          issues.push(`edge ${edge.id}: ${nodeLayer(from)} -> ${nodeLayer(to)} violates ${definition.id} endpoint constraints`)
        }
      }
      if (issues.length > 0) throw new Error(`invalid ontology graph: ${issues.slice(0, 8).join('; ')}`)
      return {
        name: typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        rendered: true,
      }
    },
  }))
  const patchDisposer = ctx.tools.register(defineTool({
    name: 'lineage_patch',
    description:
      'Apply a small, reviewable change to the latest lineage graph instead of regenerating it. '
      + 'Use `upsert_node` to add or update a node, `update_node` to change an existing node, `delete_node` to remove a node and its edges, '
      + '`add_edge` / `update_edge` / `delete_edge` for relationships. Give `reason` as a short Chinese explanation shown in the review card. '
      + 'Reference existing node ids when possible; when creating an edge, use stable new node ids only after creating those nodes in the same patch. '
      + 'Call lineage_context first. Use update_node.patch for business definitions, aliases, uri, identifierKey, attribute constraints, data source mappings, '
      + 'and rule/constraint descriptions. Use update_edge.patch for relation type, direction, required flag, cardinality, review status, and evidence. '
      + 'For entity normalization, propose update_node operations that preserve stable instance ids and merge evidence instead of deleting the original instance.',
    parameters: {
      reason: {
        type: 'string',
        description: 'Short user-facing reason for this incremental change.',
      },
      ops: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            op: {
              type: 'string',
              required: true,
              description: 'upsert_node | update_node | delete_node | add_edge | update_edge | delete_edge | merge_instance | set_mapping',
            },
            id: { type: 'string', description: 'Existing node or edge id for update/delete operations.' },
            sourceId: { type: 'string', description: 'Duplicate instance id for merge_instance.' },
            targetId: { type: 'string', description: 'Surviving instance id for merge_instance.' },
            mapping: { type: 'json', description: 'One source mapping object for set_mapping; include connectionId, database and objectName.' },
            node: NODE_ITEM,
            edge: EDGE_ITEM,
            patch: { type: 'json', description: 'Partial node or edge fields for update operations.' },
          },
        },
        description: 'Ordered patch operations.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          opsApplied: { type: 'integer', required: true, description: 'Number of valid operations submitted.' },
          issueCount: { type: 'integer', required: true, description: 'Number of invalid operations.' },
          rendered: { type: 'boolean', required: true, description: 'Whether the patch was sent to the review card.' },
        },
      },
      render: () => [{ type: 'text', text: 'The lineage patch is ready for review; open the right-side lineage tab to apply it.' }],
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const result = validateLineagePatch(args)
      return {
        opsApplied: result.patch.ops.length,
        issueCount: result.issues.length,
        rendered: result.patch.ops.length > 0,
      }
    },
  }))
  const contextDisposer = ctx.tools.register(defineTool({
    name: 'lineage_context',
    description:
      'Retrieve a compact ontology context for the current conversation graph. '
      + 'Call this before reasoning about ontology structure, data mappings, instances, rules, or making a lineage_patch. '
      + 'It returns only the most relevant classes, relations, constraints, mappings, sample instances, quality issues, and patch workflow rules.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The user task or question used to rank relevant ontology nodes.',
      },
      maxNodes: {
        type: 'integer',
        description: 'Maximum focused classes/nodes to retrieve. Default 16.',
      },
      maxInstancesPerClass: {
        type: 'integer',
        description: 'Maximum sample instances per class. Default 3.',
      },
      includeQuality: {
        type: 'boolean',
        description: 'Include data quality and instance validation issues. Default true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: 'Whether a current lineage graph was found.' },
          focusCount: { type: 'integer', required: true, description: 'Number of focused nodes.' },
          edgeCount: { type: 'integer', required: true, description: 'Number of included relations.' },
          constraintCount: { type: 'integer', required: true, description: 'Number of included constraints.' },
          mappingCount: { type: 'integer', required: true, description: 'Number of included source mappings.' },
          instanceCount: { type: 'integer', required: true, description: 'Number of included sample instances.' },
          context: { type: 'string', required: true, description: 'Compact Markdown ontology context.' },
        },
      },
      render: () => [{ type: 'text', text: 'Retrieved the compact ontology context; use lineage_patch for graph changes.' }],
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const graph = currentLineageGraph(ctx, exec)
      if (graph === null) {
        return {
          found: false,
          focusCount: 0,
          edgeCount: 0,
          constraintCount: 0,
          mappingCount: 0,
          instanceCount: 0,
          context: '当前会话没有血缘图。请先使用 lineage_graph 生成图，或让用户打开已有工作区。',
        }
      }
      const context = buildOntologyContext(graph, {
        query: typeof args.query === 'string' ? args.query : '',
        ...(typeof args.maxNodes === 'number' ? { maxNodes: args.maxNodes } : {}),
        ...(typeof args.maxInstancesPerClass === 'number' ? { maxInstancesPerClass: args.maxInstancesPerClass } : {}),
        ...(typeof args.includeQuality === 'boolean' ? { includeQuality: args.includeQuality } : {}),
      })
      return {
        found: true,
        focusCount: context.focus.length,
        edgeCount: context.edges.length,
        constraintCount: context.constraints.length,
        mappingCount: context.mappings.length,
        instanceCount: context.instances.length,
        context: context.text,
      }
    },
  }))
  return () => {
    graphDisposer()
    patchDisposer()
    contextDisposer()
  }
}
