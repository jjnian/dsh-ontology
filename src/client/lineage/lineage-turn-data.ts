/**
 * Turn-scoped lineage deliverable Definition and selector. Client-only:
 * the vocabulary comes from successful `lineage_graph` tool calls, never
 * presentation data. Mirrors ui-deliverables' Definition shape but tracks
 * the lineage tool instead of file mutations.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Immutable lineage facts published against one Turn. */
export interface LineageTurnData {
  readonly hasLineage: boolean
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** `lineage_graph` calls accumulated in this Turn. */
    lineage: LineageTurnData
  }
}

interface LineageState extends LineageTurnData {
  readonly turn: number
  readonly callIds: ReadonlySet<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Claim the turn-tail chain's lineage chip when the closing turn produced a
 * lineage graph via a successful `lineage_graph` call.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns true when the turn published lineage data, false otherwise.
 */
/** Structural TurnTailOwnerProps face (avoids the dsh-client-ui-chat type dependency). */
interface TurnTailOwnerLike {
  turn: { data: { get: (key: string) => unknown } }
  seq: number
}

export function selectLineage(owner: TurnTailOwnerLike): boolean {
  const data = owner.turn.data.get('lineage') as LineageTurnData | undefined
  return data?.hasLineage === true
}

/** Turn-local lineage_graph call accumulator; it publishes no view Node. */
export const lineageDefinition: ConversationNodeDefinition<LineageState> = {
  kind: 'lineage-deliverables',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String((event.data as { turn: number }).turn), role: 'update' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String((event.data as { turn: number }).turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('lineage start requires turn/start')
    return { turn: match.event.data.turn, callIds: new Set<string>(), hasLineage: false }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      if (match.event.data.name !== 'lineage_graph') return context.state
      const callIds = new Set(context.state.callIds)
      callIds.add(String(match.event.data.callId))
      return { ...context.state, callIds }
    }
    if (match.event.type !== 'tool/result') return context.state
    const result = match.event.data.message.content[0]
    if (result.isError === true) return context.state
    const callId = String(match.event.data.message.source.callId)
    if (!context.state.callIds.has(callId)) return context.state
    return { ...context.state, hasLineage: true }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'lineage'
      && previous.value.hasLineage === context.state.hasLineage) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'lineage',
      value: { hasLineage: context.state.hasLineage },
    }
  },
}
