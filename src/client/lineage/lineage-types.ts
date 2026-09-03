/**
 * Lineage graph domain types, ported 1:1 from EIC-CC's `src/types.ts`
 * (`OntologyNode` / `OntologyEdge`). Only the fields the graph canvas and
 * node detail panel render are kept; unknown payload keys are preserved so
 * richer EIC-CC exports still load.
 */

export type LineageNodeSource = 'derived' | 'inferred' | 'preset' | 'manual' | string

export type LineageEvidenceType =
  | 'file'
  | 'ddl'
  | 'sql'
  | 'database'
  | 'manual'
  | 'llm'
  | 'data-check'
  | string

export interface LineageEvidence {
  id: string
  type: LineageEvidenceType
  summary: string
  detail?: string
  sourcePath?: string
  connectionId?: string
  database?: string
  objectName?: string
  checkedAt?: string
}

export interface LineageNode {
  id: string
  label: string
  /** Ontology governance layer. New graphs should set class or instance explicitly. */
  layer?: string
  type: string
  source?: LineageNodeSource
  domain?: string
  x?: number
  y?: number
  properties?: Record<string, unknown>
  evidence?: string
  evidences?: LineageEvidence[]
  confidence?: number
  [key: string]: unknown
}

export interface LineageEdge {
  id: string
  from: string
  to: string
  label?: string
  source?: LineageNodeSource
  rel_type?: string
  evidence?: string
  evidences?: LineageEvidence[]
  confidence?: number
  properties?: Record<string, unknown>
  [key: string]: unknown
}

/** The payload a lineage file/API carries: `{ nodes, edges }`. */
export interface LineageGraph {
  nodes: LineageNode[]
  edges: LineageEdge[]
}

/** Read legacy single-evidence and new multi-evidence fields in one order. */
export function evidenceTexts(item: { evidence?: string; evidences?: LineageEvidence[] }): string[] {
  const texts: string[] = []
  if (item.evidence !== undefined && item.evidence !== '') texts.push(item.evidence)
  for (const evidence of item.evidences ?? []) {
    if (evidence.summary !== '' && !texts.includes(evidence.summary)) texts.push(evidence.summary)
    if (evidence.detail !== undefined && evidence.detail !== '' && !texts.includes(evidence.detail)) {
      texts.push(evidence.detail)
    }
  }
  return [...new Set(texts)]
}

/** Merge evidence without losing legacy strings or duplicate-checked sources. */
export function mergeEvidence<
  T extends { evidence?: string; evidences?: LineageEvidence[] },
>(item: T, incoming: { evidence?: string; evidences?: LineageEvidence[] }): T {
  const evidences = [...(item.evidences ?? [])]
  const signatures = new Set(evidences.map((evidence) => evidence.summary))
  if (incoming.evidence !== undefined && incoming.evidence !== '') {
    const signature = incoming.evidence
    if (!signatures.has(signature)) {
      evidences.push({ id: `legacy:${evidences.length + 1}`, type: 'legacy', summary: incoming.evidence })
      signatures.add(signature)
    }
  }
  for (const evidence of incoming.evidences ?? []) {
    const signature = evidence.summary
    if (!signatures.has(signature)) {
      evidences.push(evidence)
      signatures.add(signature)
    }
  }
  return { ...item, evidences }
}

export interface LineageWorkspaceSummary {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  nodeCount: number
  edgeCount: number
}

export interface LineageWorkspace {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  sourceAssets?: string[]
  nodes: LineageNode[]
  edges: LineageEdge[]
  revisions?: LineageRevision[]
}

export interface LineageRevision {
  id: string
  createdAt: string
  source: string
  nodes: LineageNode[]
  edges: LineageEdge[]
}

/** One lineage graph snapshot found in a session event log. */
export interface LineageHistoryEntry {
  /** Stable id derived from the source event (usable as a select key). */
  id: string
  /** Source event sequence number. */
  seq: number
  /** Source event timestamp (epoch ms). */
  time: number
  /** The conversation turn that produced this graph, when known. */
  turn?: number
  /** Which event shape produced this graph: tool call or assistant message. */
  kind: 'tool' | 'message'
  /** Tool name for tool-call snapshots; absent for message snapshots. */
  name?: string
  graph: LineageGraph
}

/** Parse arbitrary JSON into a lineage graph; throws a descriptive Error. */
export function parseLineageGraph(raw: string): LineageGraph {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('lineageInvalidJson')
  }
  if (typeof value !== 'object' || value === null) throw new Error('lineageInvalidGraph')
  const obj = value as Record<string, unknown>
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) throw new Error('lineageInvalidGraph')
  return {
    nodes: obj.nodes as LineageNode[],
    edges: obj.edges as LineageEdge[],
  }
}
