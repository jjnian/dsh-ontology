/**
 * Layered auto-layout for lineage graphs, ported 1:1 from EIC-CC's
 * `src/app/lib/graphLayout.ts`. Left-to-right longest-path layering (LR),
 * with a cycle-safe BFS guard and per-layer ordering by average parent Y.
 */
import type { LineageNode, LineageEdge } from './lineage-types.ts'

/** Node render size (kept in lockstep with the canvas). */
export const NODE_W = 184
export const NODE_H = 56

const LAYER_GAP = 256
const ROW_GAP = 84

export interface XY { x: number; y: number }

/** Layer the graph left-to-right; each layer is centered vertically. */
export function layeredLayout(nodes: LineageNode[], edges: LineageEdge[]): Map<string, XY> {
  const ids = new Set(nodes.map((n) => n.id))
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const n of nodes) { adj.set(n.id, []); indeg.set(n.id, 0) }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    adj.get(e.from)!.push(e.to)
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  }

  const depth = new Map<string, number>()
  const queue: string[] = []
  for (const n of nodes) {
    if ((indeg.get(n.id) || 0) === 0) { depth.set(n.id, 0); queue.push(n.id) }
  }
  const indegLeft = new Map(indeg)
  let guard = edges.length + nodes.length + 4
  while (queue.length && guard-- > 0) {
    const cur = queue.shift()!
    const d = depth.get(cur) ?? 0
    for (const nxt of adj.get(cur) || []) {
      depth.set(nxt, Math.max(depth.get(nxt) ?? 0, d + 1))
      const left = (indegLeft.get(nxt) || 1) - 1
      indegLeft.set(nxt, left)
      if (left <= 0) queue.push(nxt)
    }
  }

  let maxDepth = 0
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d)
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1)
  }

  const layers = new Map<number, LineageNode[]>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    if (!layers.has(d)) layers.set(d, [])
    layers.get(d)!.push(n)
  }

  const pos = new Map<string, XY>()
  const sortedDepths = [...layers.keys()].sort((a, b) => a - b)
  const parentsOf = new Map<string, string[]>()
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, [])
    parentsOf.get(e.to)!.push(e.from)
  }

  for (const d of sortedDepths) {
    const layer = layers.get(d)!
    layer.sort((a, b) => {
      const pa = (parentsOf.get(a.id) || []).map((p) => pos.get(p)?.y ?? 0)
      const pb = (parentsOf.get(b.id) || []).map((p) => pos.get(p)?.y ?? 0)
      const ma = pa.length ? pa.reduce((s, v) => s + v, 0) / pa.length : 0
      const mb = pb.length ? pb.reduce((s, v) => s + v, 0) / pb.length : 0
      return ma - mb || a.label.localeCompare(b.label, 'zh')
    })
    const totalH = (layer.length - 1) * ROW_GAP
    layer.forEach((n, i) => {
      pos.set(n.id, { x: d * LAYER_GAP, y: i * ROW_GAP - totalH / 2 })
    })
  }
  return pos
}

/** Bounding box of a set of positioned nodes. */
export function boundsOf(pos: Iterable<XY>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pos) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H)
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300 }
  return { minX, minY, maxX, maxY }
}
