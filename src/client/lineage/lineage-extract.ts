/**
 * Extract the most recent lineage graph from a session event log (framework-
 * free so the host route, the client, and node tests can share it).
 *
 * The model can emit a graph two ways, both recognized:
 * - An assistant message carrying a fenced (```json … ```) JSON object with
 *   `nodes` + `edges` arrays (or a bare JSON object in the message text).
 * - A tool call whose name is a known lineage tool and whose `arguments`
 *   JSON carries `nodes` + `edges`.
 *
 * The scan walks newest → oldest and returns the FIRST valid graph, so the
 * latest conversation graph wins.
 */
import type { SidebarSessionEvent } from '../../context-types.ts'
import { contentText } from '../../subagent-activity.ts'
import { parseLineageGraph, type LineageGraph, type LineageHistoryEntry } from './lineage-types.ts'
import { validateLineagePatch, type LineagePatch, type LineagePatchIssue } from './lineage-patch.ts'

/** Tool names the model may use to hand over a generated lineage graph. */
const GRAPH_TOOL_NAMES = new Set([
  'lineage',
  'lineage_graph',
  'ontology_graph',
  'graph',
  'save_lineage',
  'render_lineage',
])

/** Try parsing one string as a lineage payload; null when it is not one. */
function tryParseGraph(text: string): LineageGraph | null {
  try {
    return parseLineageGraph(text)
  } catch {
    return null
  }
}

/** Pull the latest valid graph out of free text (fenced JSON first, then bare). */
function graphFromText(text: string): LineageGraph | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const code = fences[index]?.[1]
    if (code !== undefined) {
      const graph = tryParseGraph(code)
      if (graph !== null) return graph
    }
  }
  return tryParseGraph(text)
}

/** Extract a graph from one event's data record, when it carries one. */
function graphFromEvent(type: string, data: Record<string, unknown>): LineageGraph | null {
  if (type === 'assistant/message') {
    const message = data.message as { content?: unknown } | undefined
    const content = message?.content
    const text = contentText(content) ?? (typeof content === 'string' ? content : undefined)
    return text !== undefined ? graphFromText(text) : null
  }
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : ''
    if (!GRAPH_TOOL_NAMES.has(name)) return null
    const args = typeof data.arguments === 'string' ? data.arguments : ''
    return args !== '' ? graphFromText(args) : null
  }
  return null
}

/** Read the turn number recorded on a surface event, when present. */
function turnOf(data: Record<string, unknown>): number | undefined {
  const turn = data.turn
  return typeof turn === 'number' ? turn : undefined
}

/**
 * Every valid lineage graph found in the append-only event log, newest
 * first. Each entry keeps its source metadata (sequence, timestamp, turn,
 * source shape) so the client can offer a history selector. Identical
 * payloads are deduplicated by their JSON representation, keeping the
 * newest occurrence.
 */
export function extractLineageHistory(events: readonly SidebarSessionEvent[]): LineageHistoryEntry[] {
  const entries: LineageHistoryEntry[] = []
  for (const event of events) {
    const type = event.type
    const graph = graphFromEvent(type, event.data)
    if (graph === null) continue
    const kind = type === 'tool/call' ? 'tool' : 'message'
    const name = kind === 'tool' && typeof event.data.name === 'string' ? event.data.name : undefined
    entries.push({
      id: `seq-${event.seq}-${entries.length}`,
      seq: event.seq,
      time: event.time,
      ...(turnOf(event.data) !== undefined ? { turn: turnOf(event.data) } : {}),
      kind,
      ...(name !== undefined ? { name } : {}),
      graph,
    })
  }

  const latestByJson = new Map<string, LineageHistoryEntry>()
  for (const entry of entries) {
    latestByJson.set(JSON.stringify(entry.graph), entry)
  }
  return [...latestByJson.values()].reverse()
}

/** The latest lineage graph found in the append-only event log, or null. */
export function extractLineageGraph(events: readonly SidebarSessionEvent[]): LineageGraph | null {
  return extractLineageHistory(events)[0]?.graph ?? null
}

/** One incremental graph patch found in a session event log. */
export interface LineagePatchEntry {
  id: string
  seq: number
  time: number
  turn?: number
  patch: LineagePatch
  issues: string[]
}

function patchFromText(text: string): { patch: LineagePatch; issues: LineagePatchIssue[] } | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (const code of [fences.at(-1)?.[1], text].filter((item): item is string => item !== undefined)) {
    try {
      const validated = validateLineagePatch(JSON.parse(code) as unknown)
      if (validated.patch.ops.length > 0 || validated.issues.length > 0) return validated
    } catch {
      // The text is usually ordinary prose; only a JSON object is relevant.
    }
  }
  return null
}

function patchFromEvent(event: SidebarSessionEvent): { patch: LineagePatch; issues: LineagePatchIssue[] } | null {
  if (event.type === 'tool/call' && event.data.name === 'lineage_patch') {
    const args = typeof event.data.arguments === 'string' ? event.data.arguments : ''
    if (args === '') return null
    try {
      return validateLineagePatch(JSON.parse(args) as unknown)
    } catch {
      return null
    }
  }
  if (event.type === 'assistant/message') {
    const content = (event.data.message as { content?: unknown } | undefined)?.content
    const text = contentText(content) ?? (typeof content === 'string' ? content : undefined)
    return text === undefined ? null : patchFromText(text)
  }
  return null
}

/** The latest `lineage_patch` call from the session event log, newest first. */
export function extractLineagePatch(events: readonly SidebarSessionEvent[]): LineagePatchEntry | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    const result = patchFromEvent(event)
    if (result === null) continue
    const turn = typeof event.data.turn === 'number' ? event.data.turn : undefined
    return {
      id: `patch-${event.seq}`,
      seq: event.seq,
      time: event.time,
      ...(turn !== undefined ? { turn } : {}),
      patch: result.patch,
      issues: result.issues.map((issue) => `${issue.index + 1}. ${issue.message}`),
    }
  }
  return null
}
