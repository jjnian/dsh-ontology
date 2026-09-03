import type { Context } from '../../context-types.ts'
import { api } from '../api.ts'
import { t } from '../locales.ts'
import type { LineageGraph } from './lineage-types.ts'

/**
 * Minimal structural mirrors of the host input-trigger contract this
 * feature touches. The runtime service comes from
 * `@deepseek-ai/dsh-client-ui-input-trigger` via `ctx.inject(['inputTriggers'])`;
 * the client bundle deliberately does not value-import that package, so the
 * host contract is mirrored here instead.
 */
interface LineageReferenceCandidate {
  readonly name: string
  readonly description?: string
  readonly section?: string
  readonly value?: string
}

type ReferenceKind = 'graph' | 'node' | 'edge'

interface LineageReferencePick {
  readonly candidate: LineageReferenceCandidate
}

type LineageReferenceOutcome =
  | { readonly insert: { readonly source: string; readonly ref: string; readonly label: string; readonly clipboardText: string } }
  | undefined

interface LineageReferenceSource {
  readonly trigger: '@' | '/'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  readonly codec?: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
  candidates(
    session: { readonly sessionId: string },
    req: { readonly query: string; readonly signal: AbortSignal },
  ): Promise<readonly LineageReferenceCandidate[]>
  onPick(pick: LineageReferencePick): LineageReferenceOutcome
}

interface LineageInputTriggersService {
  registerSource(source: LineageReferenceSource): () => void
}

/** Scope projection carrying the input-trigger service after it becomes available. */
interface LineageInputTriggersScope {
  readonly inputTriggers: LineageInputTriggersService
}


function graphDigest(graph: LineageGraph): string {
  const source = JSON.stringify(graph)
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function matchesQuery(query: string, candidate: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return candidate.toLowerCase().includes(needle)
}

/**
 * Register the `@lineage` reference source. It offers the latest lineage
 * graph of the active conversation; picking it inserts a compact reference
 * chip, not the graph payload.
 */
export function registerLineageReferenceSource(ctx: Context): () => void {
  /** Graph snapshots keyed by a short digest; picked candidates stay stable. */
  const graphSnapshots = new Map<string, LineageGraph>()
  const nodeSnapshots = new Map<string, { graphDigest: string; nodeId: string; label: string }>()
  const edgeSnapshots = new Map<string, { graphDigest: string; edgeId: string; label: string }>()

  const source: LineageReferenceSource = {
    trigger: '@',
    name: 'lineage',
    order: -10,
    showGroupTitle: false,
    codec: {
      clipboardText: ref => `@lineage:${ref}`,
      serialize: ref => Promise.resolve(`@lineage:${ref}`),
    },
    async candidates({ sessionId }, { query, signal }) {
      if (signal.aborted) return []
      try {
        const result = await api.lineageGraph({ sessionId }, signal)
        if (signal.aborted || result.graph === null) return []
        const digest = graphDigest(result.graph)
        graphSnapshots.set(digest, result.graph)
        const name = `${t('lineage')} (${result.graph.nodes.length} / ${result.graph.edges.length})`
        const candidates: LineageReferenceCandidate[] = []
        if (matchesQuery(query, name)) {
          candidates.push({ name, section: t('lineage'), value: `graph:${digest}` })
        }
        for (const node of result.graph.nodes) {
          const label = node.label || node.id
          if (!matchesQuery(query, label)) continue
          const id = `node:${node.id}`
          nodeSnapshots.set(id, { graphDigest: digest, nodeId: node.id, label })
          candidates.push({ name: label, description: `节点 · ${node.type}`, section: '节点', value: id })
        }
        for (const edge of result.graph.edges) {
          const from = result.graph.nodes.find((node) => node.id === edge.from)?.label ?? edge.from
          const to = result.graph.nodes.find((node) => node.id === edge.to)?.label ?? edge.to
          const label = `${from} → ${to}`
          if (!matchesQuery(query, label)) continue
          const id = `edge:${edge.id}`
          edgeSnapshots.set(id, { graphDigest: digest, edgeId: edge.id, label })
          candidates.push({ name: label, description: `关系 · ${edge.rel_type ?? '关系'}`, section: '关系', value: id })
        }
        return candidates.slice(0, 40)
      } catch {
        // A transient session-log / route failure must not break the menu.
        return []
      }
    },
    onPick({ candidate }) {
      const digest = candidate.value
      if (digest === undefined) return undefined
      const [kindRaw = '', reference = ''] = digest.split(':')
      const kind: ReferenceKind = kindRaw === 'node' ? 'node' : kindRaw === 'edge' ? 'edge' : 'graph'
      const graph = graphSnapshots.get(kind === 'graph' ? reference : kind === 'node' ? nodeSnapshots.get(digest)?.graphDigest ?? '' : edgeSnapshots.get(digest)?.graphDigest ?? '')
      if (graph === undefined) return undefined
      const label = kind === 'graph'
        ? candidate.name
        : kind === 'node'
          ? nodeSnapshots.get(digest)?.label ?? candidate.name
          : edgeSnapshots.get(digest)?.label ?? candidate.name
      return {
        insert: {
          source: 'lineage',
          ref: reference,
          label,
          clipboardText: kind === 'graph' ? `@图谱:${label}` : kind === 'node' ? `@节点:${label}` : `@关系:${label}`,
        },
      }
    },
  }

  // The input-trigger service is optional and can arrive after this plugin:
  // wait on it with `ctx.inject` (the same seam the host ui-reference uses)
  // rather than declaring it as a hard root dependency, which would leave
  // the whole client half pending in compositions without that service.
  const fiber = ctx.inject(['inputTriggers'], (scope) => {
    const inputTriggers = (scope as unknown as LineageInputTriggersScope).inputTriggers
    scope.effect(() => inputTriggers.registerSource(source))
  })
  return () => {
    void fiber.dispose()
    graphSnapshots.clear()
    nodeSnapshots.clear()
    edgeSnapshots.clear()
  }
}
