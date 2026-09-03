import { describe, expect, it } from 'vitest'
import { graphViewport, intersectsViewport } from '../src/client/lineage/graph-viewport.ts'

describe('graph viewport', () => {
  it('calculates a graph-space rectangle with margin', () => {
    const rect = graphViewport({ x: 200, y: 100, k: 2 }, { w: 400, h: 200 })
    expect(rect.x).toBeLessThan(-100)
    expect(rect.width).toBeGreaterThan(200)
  })

  it('culls nodes outside the visible rect', () => {
    const rect = graphViewport({ x: 0, y: 0, k: 1 }, { w: 100, h: 100 })
    expect(intersectsViewport({ x: 20, y: 20 }, rect)).toBe(true)
    expect(intersectsViewport({ x: 1000, y: 1000 }, rect)).toBe(false)
  })
})
