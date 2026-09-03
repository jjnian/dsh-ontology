import type { ReactNode } from 'react'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { t } from '../locales.ts'

/** Minimal block view for the keyed `lineage_graph` tool row. */
interface LineageToolBlock {
  callId: string
  argsRaw?: string
  call?: { name?: string; argsRaw?: string } | null
}

interface LineageInfo {
  name: string | undefined
  nodes: number
  edges: number
}

function parseInfo(block: LineageToolBlock): LineageInfo | null {
  const settled = block.call !== undefined
  const raw = settled ? block.call?.argsRaw : block.argsRaw
  if (raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0
    const edges = Array.isArray(parsed.edges) ? parsed.edges.length : 0
    const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : undefined
    return { name, nodes, edges }
  } catch {
    return null
  }
}

/**
 * Replace the generic `lineage_graph` tool card with a compact lineage row:
 * clicking it opens the current session's right-side lineage tab, where the
 * latest graph is loaded from the session event log.
 */
export function registerLineageToolView(ctx: Context): () => void {
  const LineageGraphToolRow = ({ block }: { block: LineageToolBlock }): ReactNode => {
    const info = parseInfo(block)
    const label = info === null ? t('lineage') : (info.name ?? ('Lineage (' + info.nodes + ' / ' + info.edges + ')'))
    const open = (): void => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      if (sessionId === undefined) return
      ctx.get('betterSidebar')?.openTab({ type: 'lineage', forcePanel: true }, { sessionId })
    }
    return (
      <button
        type="button"
        onClick={open}
        title={t('lineage')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          maxWidth: '100%',
          minHeight: 28,
          padding: '0 10px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          font: 'var(--dsw-font-xxs-12)',
          cursor: 'pointer',
        }}
      >
        <IconDataOutline16 size={14} />
        <span>{label}</span>
      </button>
    )
  }

  return ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'lineage_graph',
  }, LineageGraphToolRow))
}
