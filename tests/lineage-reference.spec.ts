import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerLineageReferenceSource } from '../src/client/lineage/lineage-reference.ts'
import type { Context } from '../src/context-types.ts'

const lineageGraph = vi.hoisted(() => vi.fn())

vi.mock('../src/client/api.ts', () => ({
  api: { lineageGraph },
}))

const graph = {
  nodes: [{ id: 'a', label: 'A', type: 'class' }],
  edges: [{ id: 'e', from: 'a', to: 'a', label: 'self' }],
}

describe('registerLineageReferenceSource', () => {
  beforeEach(() => {
    lineageGraph.mockReset()
  })

  it('waits for inputTriggers via ctx.inject and registers a working @ source', async () => {
    let registered: {
      trigger: string
      name: string
      candidates: (session: { sessionId: string }, req: { query: string; signal: AbortSignal }) =>
        Promise<Array<{ name: string; value?: string }>>
      onPick: (pick: { candidate: { value?: string; name?: string } }) =>
        | { insert?: { source: string; ref: string; label: string; clipboardText: string } }
        | undefined
    } | undefined
    const unregister = vi.fn()
    const dispose = vi.fn()
    const ctx = {
      inject(_deps: string[], callback: (scope: unknown) => void) {
        const scope = {
          inputTriggers: {
            registerSource: (source: unknown) => {
              registered = source as typeof registered
              return unregister
            },
          },
          effect(callback: () => unknown) {
            callback()
            return () => {}
          },
        }
        callback(scope)
        return { dispose }
      },
    } as unknown as Context

    const disposer = registerLineageReferenceSource(ctx)
    expect(registered).toBeDefined()
    expect(registered?.trigger).toBe('@')
    expect(registered?.name).toBe('lineage')

    lineageGraph.mockResolvedValue({ graph })
    const items = await registered!.candidates(
      { sessionId: 's1' },
      { query: '', signal: new AbortController().signal },
    )
    expect(items).toHaveLength(3)
    expect(items[0]?.name).toContain('1 / 1')

    const outcome = registered!.onPick({ candidate: { value: items[0]?.value, name: items[0]?.name } })
    expect(outcome?.insert?.source).toBe('lineage')
    expect(outcome?.insert?.clipboardText).toMatch(/^@图谱:/)
    expect(outcome?.insert?.clipboardText).not.toContain('```json')
    disposer()
    expect(dispose).toHaveBeenCalled()
  })
})
