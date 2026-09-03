import { describe, expect, it } from 'vitest'
import { extractLineageGraph, extractLineageHistory, extractLineagePatch } from '../src/client/lineage/lineage-extract.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

function assistant(text: string, seq = 1): SidebarSessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

function toolCall(name: string, args: string, seq = 1): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { name, arguments: args } }
}

function toolCallWith(name: string, args: string, over: Partial<SidebarSessionEvent['data']> = {}, seq = 1): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq * 1000, data: { name, arguments: args, ...over } }
}

const graph = {
  nodes: [{ id: 'a', label: 'A', type: 'class' }],
  edges: [{ id: 'e', from: 'a', to: 'a', label: 'self' }],
}

describe('extractLineageGraph', () => {
  it('pulls a fenced JSON graph out of an assistant message', () => {
    const events = [assistant('Here is the graph:\n```json\n' + JSON.stringify(graph) + '\n```')]
    expect(extractLineageGraph(events)).toEqual(graph)
  })

  it('pulls a bare JSON graph out of an assistant message', () => {
    const events = [assistant(JSON.stringify(graph))]
    expect(extractLineageGraph(events)).toEqual(graph)
  })

  it('pulls a graph from a lineage tool call', () => {
    const events = [toolCall('lineage', JSON.stringify(graph))]
    expect(extractLineageGraph(events)).toEqual(graph)
  })

  it('pulls a graph from the registered lineage_graph tool', () => {
    const events = [toolCall('lineage_graph', JSON.stringify(graph))]
    expect(extractLineageGraph(events)).toEqual(graph)
  })

  it('returns null when no graph is present', () => {
    expect(extractLineageGraph([assistant('nothing to see here')])).toBeNull()
    expect(extractLineageGraph([toolCall('read_file', '{"path":"/x"}')])).toBeNull()
  })

  it('returns the latest graph when several are present', () => {
    const newer = { nodes: [{ id: 'b', label: 'B', type: 'process' }], edges: [] }
    const events = [assistant(JSON.stringify(graph), 1), assistant('```json\n' + JSON.stringify(newer) + '\n```', 2)]
    expect(extractLineageGraph(events)).toEqual(newer)
  })
})

describe('extractLineageHistory', () => {
  it('returns empty history when no graph is present', () => {
    expect(extractLineageHistory([assistant('nothing here')])).toEqual([])
  })

  it('returns snapshots newest-first with source metadata', () => {
    const older = { nodes: [{ id: 'a', label: 'A', type: 'class' }], edges: [] }
    const newer = { nodes: [{ id: 'b', label: 'B', type: 'process' }], edges: [] }
    const events = [
      toolCallWith('lineage', JSON.stringify(older), { turn: 1 }, 1),
      assistant('```json\n' + JSON.stringify(newer) + '\n```', 2),
    ]
    const history = extractLineageHistory(events)
    expect(history).toHaveLength(2)
    expect(history[0]?.graph).toEqual(newer)
    expect(history[0]?.kind).toBe('message')
    expect(history[1]?.graph).toEqual(older)
    expect(history[1]?.kind).toBe('tool')
    expect(history[1]?.name).toBe('lineage')
    expect(history[1]?.turn).toBe(1)
  })

  it('deduplicates identical payloads and keeps the newest occurrence', () => {
    const events = [
      toolCallWith('lineage_graph', JSON.stringify(graph), { turn: 1 }, 1),
      assistant('```json\n' + JSON.stringify(graph) + '\n```', 2),
    ]
    const history = extractLineageHistory(events)
    expect(history).toHaveLength(1)
    expect(history[0]?.seq).toBe(2)
    expect(history[0]?.kind).toBe('message')
  })
})

describe('extractLineagePatch', () => {
  it('pulls the latest registered lineage_patch call', () => {
    const older = { reason: '旧变更', ops: [{ op: 'upsert_node', node: { id: 'old', label: 'Old', type: 'class' } }] }
    const newer = { reason: '补充退款流程', ops: [{ op: 'add_edge', edge: { id: 'e', from: 'a', to: 'b', rel_type: 'depends_on' } }] }
    const events = [
      toolCall('lineage_patch', JSON.stringify(older), 1),
      toolCall('lineage_patch', JSON.stringify(newer), 2),
    ]
    const result = extractLineagePatch(events)
    expect(result?.patch.reason).toBe('补充退款流程')
    expect(result?.patch.ops).toHaveLength(1)
    expect(result?.seq).toBe(2)
  })

  it('returns validation issues for malformed patch operations', () => {
    const events = [toolCall('lineage_patch', JSON.stringify({ ops: [{ op: 'nonsense' }] }))]
    const result = extractLineagePatch(events)
    expect(result?.patch.ops).toHaveLength(0)
    expect(result?.issues).toHaveLength(1)
  })
})
