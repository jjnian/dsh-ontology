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

/** A structured source provenance row for the node/edge detail panel. */
export interface LineageEvidenceSource {
  id: string
  icon: string
  kind: string
  label: string
  title?: string
}

/** Turn legacy text and structured evidences into human-readable source rows. */
export function evidenceSources(item: { evidence?: string; evidences?: LineageEvidence[] }): LineageEvidenceSource[] {
  const rows = new Map<string, LineageEvidenceSource>()
  const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

  for (const evidence of item.evidences ?? []) {
    const summary = evidence.summary || evidence.detail || ''
    const title = evidence.detail ?? summary
    if (evidence.type === 'file') {
      const label = evidence.sourcePath !== undefined && evidence.sourcePath !== ''
        ? basename(evidence.sourcePath)
        : summary
      if (label !== '') rows.set(`file:${evidence.id}`, { id: `file:${evidence.id}`, icon: '📄', kind: '文件', label, title: evidence.sourcePath ?? title })
      continue
    }
    if (evidence.type === 'database' || evidence.type === 'ddl' || evidence.type === 'sql') {
      const label = evidence.database !== undefined && evidence.database !== '' && evidence.objectName !== undefined && evidence.objectName !== ''
        ? `${evidence.database}.${evidence.objectName}`
        : evidence.database ?? evidence.objectName ?? evidence.connectionId ?? basename(evidence.sourcePath ?? '')
      if (label !== '') rows.set(`db:${evidence.id}`, { id: `db:${evidence.id}`, icon: '🗄️', kind: '数据库', label, title })
      continue
    }
    if (evidence.type === 'llm') {
      rows.set(`llm:${evidence.id}`, { id: `llm:${evidence.id}`, icon: '✨', kind: 'LLM', label: 'LLM联想', title })
      continue
    }
    if (evidence.type === 'manual') {
      rows.set(`manual:${evidence.id}`, { id: `manual:${evidence.id}`, icon: '✍️', kind: '手动', label: '手动来源', title })
      continue
    }
    if (evidence.type === 'data-check') {
      rows.set(`check:${evidence.id}`, { id: `check:${evidence.id}`, icon: '✅', kind: '校验', label: summary || '数据校验', title })
      continue
    }
    if (summary !== '') {
      rows.set(`${evidence.type}:${evidence.id}`, {
        id: `${evidence.type}:${evidence.id}`,
        icon: '🔗',
        kind: evidence.type,
        label: summary,
        title,
      })
    }
  }

  if (item.evidence !== undefined && item.evidence !== '') {
    rows.set('legacy', { id: 'legacy', icon: '🔗', kind: '佐证', label: item.evidence })
  }
  return [...rows.values()]
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
