import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { LineageNode, LineageEdge } from './lineage-types.ts'
import { layeredLayout, boundsOf, NODE_W, NODE_H, type XY } from './graph-layout.ts'
import { LINEAGE_TYPE_STYLES, typeStyle } from './graph-style.ts'
import { graphViewport, intersectsViewport } from './graph-viewport.ts'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

const EDGE_NEUTRAL = '#a8b3c4'
const EDGE_SELECTED = '#4f46e5'
const EDGE_HIGHLIGHT = '#f59e0b'

export interface LineageGraphProps {
  nodes: LineageNode[]
  edges: LineageEdge[]
  selectedId?: string
  selectedEdgeId?: string
  highlight?: Set<string> | null
  query?: string
  showEdgeLabels?: boolean
  onSelect?: (node: LineageNode | null) => void
  onSelectEdge?: (edge: LineageEdge | null) => void
  onMove?: () => void
  /** Edit mode: 'addNode' adds a node on canvas click, 'connect' links two nodes by clicking them in sequence. */
  editMode?: 'none' | 'addNode' | 'connect'
  /** Canvas blank-area click handler (for addNode mode). */
  onCanvasClick?: (graphX: number, graphY: number) => void
  /** Node click handler for connect mode; returns true when a link was made. */
  onConnectClick?: (nodeId: string) => void
  /** The currently selected connect-mode source node (highlighted). */
  connectSourceId?: string
}

export interface LineageGraphHandle {
  fit(): void
  zoomIn(): void
  zoomOut(): void
}

type DragState =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'node'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | null

function edgeDash(source?: string): string | undefined {
  if (source === 'inferred') return '6 5'
  if (source === 'manual') return '2 4'
  return undefined
}

/**
 * The lineage graph canvas, ported 1:1 from EIC-CC's
 * `src/app/components/GraphCanvas.vue` (SVG pan/zoom/node-drag/selection).
 */
export const LineageGraph = forwardRef<LineageGraphHandle, LineageGraphProps>(function LineageGraph(props, ref) {
  const { nodes, edges, selectedId, selectedEdgeId, highlight, query, onSelect, onSelectEdge, onMove, editMode, onCanvasClick, onConnectClick, connectSourceId } = props

  const [view, setView] = useState<{ x: number; y: number; k: number }>({ x: 60, y: 60, k: 1 })
  const [pos, setPos] = useState<Map<string, XY>>(new Map())
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 })

  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef(view)
  const posRef = useRef(pos)
  const sizeRef = useRef(size)
  const dragRef = useRef<DragState>(null)

  const commitView = (next: { x: number; y: number; k: number }): void => {
    viewRef.current = next
    setView(next)
  }
  const commitPos = (next: Map<string, XY>): void => {
    posRef.current = next
    setPos(next)
  }
  const commitSize = (next: { w: number; h: number }): void => {
    sizeRef.current = next
    setSize(next)
  }

  function fit(): void {
    if (!posRef.current.size) return
    const b = boundsOf(posRef.current.values())
    const bw = Math.max(b.maxX - b.minX, 1)
    const bh = Math.max(b.maxY - b.minY, 1)
    const s = sizeRef.current
    const k = Math.max(0.08, Math.min(s.w / (bw + 120), s.h / (bh + 120), 1.2))
    commitView({ k, x: (s.w - bw * k) / 2 - b.minX * k, y: (s.h - bh * k) / 2 - b.minY * k })
  }

  function zoomBy(factor: number, cx?: number, cy?: number): void {
    const s = sizeRef.current
    const v = viewRef.current
    const mx = cx ?? s.w / 2
    const my = cy ?? s.h / 2
    const k2 = Math.min(3, Math.max(0.08, v.k * factor))
    const f = k2 / v.k
    commitView({ x: mx - (mx - v.x) * f, y: my - (my - v.y) * f, k: k2 })
  }

  useImperativeHandle(ref, () => ({ fit, zoomIn: () => zoomBy(1.25), zoomOut: () => zoomBy(1 / 1.25) }))

  // ── 视口 + 位置管理 ──
  useEffect(() => {
    const current = posRef.current
    const missing = nodes.filter((n) => typeof n.x !== 'number' || typeof n.y !== 'number')
    const needFull = nodes.length > 0 && missing.length > nodes.length * 0.5
    if (needFull) {
      const laid = layeredLayout(nodes, edges)
      const next = new Map<string, XY>()
      for (const [id, p] of laid) next.set(id, p)
      commitPos(next)
      return
    }
    const next = new Map<string, XY>()
    for (const n of nodes) {
      if (current.has(n.id)) next.set(n.id, current.get(n.id)!)
      else if (typeof n.x === 'number' && typeof n.y === 'number') next.set(n.id, { x: n.x, y: n.y })
    }
    const still = nodes.filter((n) => !next.has(n.id))
    if (still.length) {
      const laid = layeredLayout(nodes, edges)
      for (const n of still) {
        const p = laid.get(n.id)
        if (p !== undefined) next.set(n.id, p)
      }
    }
    const ids = new Set(nodes.map((n) => n.id))
    for (const id of [...next.keys()]) if (!ids.has(id)) next.delete(id)
    commitPos(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (): void => commitSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    fit()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // Native non-passive listener: React's onWheel is passive and can't preventDefault.
    const onNativeWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onNativeWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onPointerMove(e: globalThis.PointerEvent): void {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      commitView({ ...viewRef.current, x: drag.ox + (e.clientX - drag.sx), y: drag.oy + (e.clientY - drag.sy) })
    } else {
      const v = viewRef.current
      const dx = (e.clientX - drag.sx) / v.k
      const dy = (e.clientY - drag.sy) / v.k
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return
      drag.moved = true
      const next = new Map(posRef.current)
      next.set(drag.id, { x: drag.ox + dx, y: drag.oy + dy })
      commitPos(next)
    }
  }

  function onPointerUp(): void {
    dragRef.current = null
    window.removeEventListener('pointermove', onPointerMove)
  }

  function onBgPointerDown(e: ReactPointerEvent<SVGSVGElement>): void {
    if (editMode === 'addNode' && onCanvasClick) {
      const svg = e.currentTarget
      const rect = svg.getBoundingClientRect()
      const graphX = (e.clientX - rect.left - view.x) / view.k
      const graphY = (e.clientY - rect.top - view.y) / view.k
      onCanvasClick(graphX, graphY)
      return
    }
    dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  function onNodePointerDown(e: ReactPointerEvent<SVGGElement>, n: LineageNode): void {
    e.stopPropagation()
    if (editMode === 'connect' && onConnectClick) {
      onConnectClick(n.id)
      return
    }
    const p = posRef.current.get(n.id)
    if (!p) return
    dragRef.current = { kind: 'node', id: n.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', () => onPointerUpNode(n), { once: true })
  }

  function onEdgePointerDown(e: ReactPointerEvent<SVGPathElement>, edge: LineageEdge): void {
    e.stopPropagation()
    onSelectEdge?.(edge)
  }

  function onPointerUpNode(n: LineageNode): void {
    const wasDrag = dragRef.current?.kind === 'node' && dragRef.current.moved
    dragRef.current = null
    window.removeEventListener('pointermove', onPointerMove)
    if (wasDrag) onMove?.()
    else onSelect?.(n)
  }

  // ── 渲染数据 ──
  const queryLc = (query || '').trim().toLowerCase()

  function nodeDim(n: LineageNode): boolean {
    if (highlight && highlight.size) return !highlight.has(n.id)
    if (queryLc) return !n.label.toLowerCase().includes(queryLc)
    return false
  }

  function borderPoint(from: XY, to: XY): XY {
    const cx = from.x + NODE_W / 2
    const cy = from.y + NODE_H / 2
    const dx = to.x - from.x
    const dy = to.y - from.y
    if (!dx && !dy) return { x: cx, y: cy }
    const tx = dx ? (NODE_W / 2) / Math.abs(dx) : Infinity
    const ty = dy ? (NODE_H / 2) / Math.abs(dy) : Infinity
    const t = Math.min(tx, ty)
    return { x: cx + dx * t, y: cy + dy * t }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const viewport = graphViewport(view, size)
  const visibleNodes = nodes.filter((n) => {
    const p = pos.get(n.id)
    return p !== undefined && intersectsViewport(p, viewport)
  })
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id))
  const renderEdges = edges
    .map((e) => {
      const p1 = pos.get(e.from)
      const p2 = pos.get(e.to)
      if (!p1 || !p2) return null
      if (!visibleNodeIds.has(e.from) && !visibleNodeIds.has(e.to)) {
        const edgeMinX = Math.min(p1.x, p2.x)
        const edgeMaxX = Math.max(p1.x + NODE_W, p2.x + NODE_W)
        const edgeMinY = Math.min(p1.y, p2.y)
        const edgeMaxY = Math.max(p1.y + NODE_H, p2.y + NODE_H)
        if (edgeMaxX < viewport.x || edgeMinX > viewport.x + viewport.width
          || edgeMaxY < viewport.y || edgeMinY > viewport.y + viewport.height) return null
      }
      const a = borderPoint(p1, p2)
      const b = borderPoint(p2, p1)
      const dx = Math.abs(b.x - a.x)
      const cp = Math.max(dx * 0.5, 40)
      const d = `M${a.x},${a.y} C${a.x + cp},${a.y} ${b.x - cp},${b.y} ${b.x},${b.y}`
      const hl = !!highlight && highlight.size > 0 && highlight.has(e.from) && highlight.has(e.to)
      const dim = !!highlight && highlight.size > 0 && !hl
      const labelText = e.label || e.rel_type
      const labelWidth = labelText === undefined ? 0 : Math.min(132, labelText.length * 7 + 14)
      return {
        e,
        d,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2 - 8,
        dim,
        hl,
        selected: selectedEdgeId === e.id,
        labelText,
        labelWidth,
        fromLabel: nodeById.get(e.from)?.label ?? e.from,
        toLabel: nodeById.get(e.to)?.label ?? e.to,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  const renderNodes = visibleNodes.map((n) => {
    const p = pos.get(n.id) || { x: 0, y: 0 }
    return { n, x: p.x, y: p.y, style: typeStyle(n.type), dim: nodeDim(n) }
  })

  const transform = `translate(${view.x},${view.y}) scale(${view.k})`

  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  return (
    <div ref={containerRef} style={{
      position: 'relative',
      height: '100%',
      width: '100%',
      overflow: 'hidden',
      background:
        'radial-gradient(circle at 16% 12%, rgb(99 102 241 / 0.08), transparent 34%), '
        + 'radial-gradient(circle at 86% 86%, rgb(14 165 233 / 0.08), transparent 36%), '
        + 'linear-gradient(180deg, var(--dsw-alias-bg-layer-2, #ffffff), var(--dsw-alias-bg-layer-1, #f8fafc))',
      backgroundImage: 'radial-gradient(circle, var(--dsw-alias-border-l1, #e2e8f0) 1px, transparent 1px)',
      backgroundSize: '24px 24px',
      backgroundBlendMode: 'normal',
    }}>
      <svg
        style={{ height: '100%', width: '100%', cursor: 'grab' }}
        onPointerDown={onBgPointerDown}
        onDoubleClick={fit}
      >
        <defs>
          <linearGradient id="lineage-node-surface" x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.98" />
            <stop offset="100%" stopColor="var(--dsw-alias-bg-layer-1, #f8fafc)" />
          </linearGradient>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE_NEUTRAL} />
          </marker>
          <marker id="arrow-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE_SELECTED} />
          </marker>
          <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE_HIGHLIGHT} />
          </marker>
        </defs>
        <g transform={transform}>
          {renderEdges.map((r) => (
            <g key={r.e.id} opacity={r.dim ? 0.12 : 1}>
              <path
                d={r.d}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                className={css.lineageEdgeHit}
                style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                onPointerDown={(e) => onEdgePointerDown(e, r.e)}
                tabIndex={0}
                role="button"
                aria-label={`${r.labelText ?? 'Connection'}: ${r.fromLabel} → ${r.toLabel}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectEdge?.(r.e)
                  }
                }}
              />
              <path
                d={r.d}
                fill="none"
                stroke={r.selected ? EDGE_SELECTED : r.hl ? EDGE_HIGHLIGHT : EDGE_NEUTRAL}
                strokeWidth={r.hl || r.selected ? 2.2 : 1.4}
                strokeOpacity={r.hl || r.selected ? 1 : 0.62}
                strokeDasharray={edgeDash(r.e.source)}
                markerEnd={`url(#${r.selected ? 'arrow-selected' : r.hl ? 'arrow-hl' : 'arrow'})`}
                style={{ pointerEvents: 'none' }}
              />
              {r.labelText !== undefined && (
                <g style={{ pointerEvents: 'none' }}>
                  <rect
                    x={r.mx - r.labelWidth / 2}
                    y={r.my - 8}
                    width={r.labelWidth}
                    height={16}
                    rx={8}
                    fill="var(--dsw-alias-bg-layer-1, #ffffff)"
                    stroke="var(--dsw-alias-border-l1, #e2e8f0)"
                    strokeWidth={0.8}
                  />
                  <text
                    x={r.mx}
                    y={r.my + 3}
                    textAnchor="middle"
                    fill="var(--dsw-alias-label-secondary, #475569)"
                    style={{ fontSize: 9.5, fontWeight: 500 }}
                  >
                    {truncate(r.labelText, 16)}
                  </text>
                </g>
              )}
            </g>
          ))}

          {renderNodes.map((r) => (
            <g
              key={r.n.id}
              transform={`translate(${r.x},${r.y})`}
              opacity={r.dim ? 0.18 : 1}
              style={{ cursor: 'pointer', userSelect: 'none', outline: 'none' }}
              onPointerDown={(e) => onNodePointerDown(e, r.n)}
              tabIndex={0}
              role="button"
              aria-label={`${r.n.label} · ${r.style.label}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect?.(r.n)
                }
              }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={16}
                fill="url(#lineage-node-surface)"
                stroke={selectedId === r.n.id ? r.style.color : 'var(--dsw-alias-border-l1, #e2e8f0)'}
                strokeWidth={selectedId === r.n.id ? 1.5 : 1}
                strokeOpacity={selectedId === r.n.id ? 0.34 : 0.8}
                style={{ filter: selectedId === r.n.id
                  ? 'drop-shadow(0 12px 24px rgb(15 23 42 / 0.13))'
                  : 'drop-shadow(0 4px 12px rgb(15 23 42 / 0.06))' }}
              />
              <text x={16} y={24} fill="var(--dsw-alias-label-primary, #1e293b)" style={{ fontSize: 12.5, fontWeight: 650 }}>
                {truncate(r.n.label, 14)}
              </text>
              <rect x={16} y={31} width={r.n.domain === undefined ? 34 : 34} height={16} rx={8} fill={r.style.color} opacity={0.1} style={{ pointerEvents: 'none' }} />
              <text x={33} y={43} textAnchor="middle" fill={r.style.color} style={{ fontSize: 10, fontWeight: 600 }}>
                {r.style.label}
              </text>
              {r.n.domain !== undefined && r.n.domain !== '' && (
                <text x={60} y={43} fill="var(--dsw-alias-label-tertiary, #94a3b8)" style={{ fontSize: 10, fontWeight: 500 }}>
                  {truncate(r.n.domain, 10)}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>

      <div className={css.lineageLegend} aria-label={t('lineageLegend')}>
        <div className={css.lineageLegendTitle}>{t('lineageLegend')}</div>
        <div className={css.lineageLegendGrid}>
          {LINEAGE_TYPE_STYLES.map((item) => (
            <div key={item.type} className={css.lineageLegendItem}>
              <span className={css.lineageLegendDot} style={{ background: item.color }} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        pointerEvents: 'none',
        border: '1px solid var(--dsw-alias-border-l1, #e2e8f0)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.88))',
        backdropFilter: 'blur(12px)',
        padding: '6px 10px',
        font: 'var(--dsw-font-xxxs-11)',
        color: 'var(--dsw-alias-label-tertiary, #94a3b8)',
      }}>
        {t('lineageHint')}
      </div>
    </div>
  )
})
