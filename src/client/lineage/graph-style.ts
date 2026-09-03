/**
 * Unified visual encoding for lineage node types, ported 1:1 from EIC-CC's
 * `src/app/lib/graphStyle.ts`. The type palette is domain-semantic (like a
 * syntax-highlight theme), not sidebar chrome — it is intentionally kept
 * identical to EIC-CC so the graph looks the same.
 */

export interface TypeStyle { color: string; bg: string; label: string }

const TYPE_STYLES: Record<string, TypeStyle> = {
  class:      { color: '#2563eb', bg: '#eff6ff', label: '类' },
  entity:     { color: '#0d9488', bg: '#f0fdfa', label: '实例' },
  process:    { color: '#059669', bg: '#ecfdf5', label: '流程' },
  event:      { color: '#d97706', bg: '#fff7ed', label: '事件' },
  rule:       { color: '#db2777', bg: '#fdf2f8', label: '规则' },
  metric:     { color: '#7c3aed', bg: '#f5f3ff', label: '指标' },
  attribute:  { color: '#0891b2', bg: '#ecfeff', label: '属性' },
  constraint: { color: '#dc2626', bg: '#fef2f2', label: '约束' },
  domain:     { color: '#475569', bg: '#f8fafc', label: '领域' },
}

const FALLBACK: TypeStyle = { color: '#475569', bg: '#f1f5f9', label: '节点' }

/** Ordered list of the built-in node types for legend/overlay chrome. */
export const LINEAGE_TYPE_STYLES: ReadonlyArray<TypeStyle & { type: string }> =
  Object.entries(TYPE_STYLES).map(([type, style]) => ({ type, ...style }))

export function typeStyle(type?: string): TypeStyle {
  return TYPE_STYLES[type || ''] || FALLBACK
}

export function typeLabel(type?: string): string {
  return (TYPE_STYLES[type || ''] || FALLBACK).label
}

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  derived:  { label: '派生', cls: 'bg-emerald-50 text-emerald-700' },
  inferred: { label: '推断', cls: 'bg-amber-50 text-amber-700' },
  manual:   { label: '人工', cls: 'bg-sky-50 text-sky-700' },
  preset:   { label: '预置', cls: 'bg-slate-100 text-slate-600' },
}

export function sourceMeta(source?: string): { label: string; cls: string } {
  return SOURCE_META[source || ''] || { label: source || '未知', cls: 'bg-slate-100 text-slate-500' }
}
