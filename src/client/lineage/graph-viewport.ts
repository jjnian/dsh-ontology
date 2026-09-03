import { NODE_H, NODE_W, type XY } from './graph-layout.ts'

export interface ViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export function graphViewport(view: { x: number; y: number; k: number }, size: { w: number; h: number }): ViewportRect {
  const margin = NODE_W
  return {
    x: -view.x / view.k - margin,
    y: -view.y / view.k - margin,
    width: size.w / view.k + margin * 2,
    height: size.h / view.k + margin * 2,
  }
}

export function intersectsViewport(position: XY, rect: ViewportRect): boolean {
  return position.x + NODE_W >= rect.x
    && position.x <= rect.x + rect.width
    && position.y + NODE_H >= rect.y
    && position.y <= rect.y + rect.height
}
