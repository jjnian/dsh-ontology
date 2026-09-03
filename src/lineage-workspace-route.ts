/**
 * Project-level lineage workspace persistence. Workspaces are stored beside
 * the session project so an ontology graph remains editable after the chat
 * that created it. The storage file is intentionally small and JSON-readable:
 * users can inspect or back it up without a database service.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SidebarError, requireString } from './wire.ts'
import type { LineageGraph, LineageNode, LineageEdge } from './client/lineage/lineage-types.ts'

export interface LineageWorkspace {
  readonly id: string
  name: string
  description?: string
  readonly createdAt: string
  updatedAt: string
  sourceAssets?: string[]
  nodes: LineageNode[]
  edges: LineageEdge[]
  revisions?: LineageRevision[]
}

export interface LineageRevision {
  id: string
  createdAt: string
  source: 'save' | 'import' | 'llm' | 'manual' | string
  nodes: LineageNode[]
  edges: LineageEdge[]
}

export interface LineageWorkspaceSummary {
  readonly id: string
  name: string
  description?: string
  readonly createdAt: string
  updatedAt: string
  nodeCount: number
  edgeCount: number
}

interface LineageWorkspaceStore {
  version: 1
  workspaces: LineageWorkspace[]
}

const EMPTY_STORE: LineageWorkspaceStore = { version: 1, workspaces: [] }

type CwdResolver = (payload: unknown) => Promise<{ cwd: string }>

function storagePathFor(cwd: string): string {
  return join(cwd, '.dsh', 'lineage-workspaces.json')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asGraph(value: unknown): LineageGraph {
  const record = asRecord(value)
  return {
    nodes: Array.isArray(record.nodes) ? record.nodes as LineageNode[] : [],
    edges: Array.isArray(record.edges) ? record.edges as LineageEdge[] : [],
  }
}

function parseStore(raw: string): LineageWorkspaceStore {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new SidebarError('fs-error', `lineage workspace storage is invalid: ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  const record = asRecord(value)
  const workspaces = Array.isArray(record.workspaces) ? record.workspaces : []
  return {
    version: 1,
    workspaces: workspaces.map((item) => {
      const workspace = asRecord(item)
      const graph = asGraph(workspace)
      return {
        id: asString(workspace.id),
        name: asString(workspace.name, '未命名血缘图'),
        description: asString(workspace.description),
        createdAt: asString(workspace.createdAt),
        updatedAt: asString(workspace.updatedAt),
        sourceAssets: Array.isArray(workspace.sourceAssets) ? workspace.sourceAssets.map(String) : undefined,
        nodes: graph.nodes,
        edges: graph.edges,
        revisions: Array.isArray(workspace.revisions) ? workspace.revisions as LineageRevision[] : [],
      }
    }).filter((workspace) => workspace.id !== ''),
  }
}

async function readStore(cwd: string): Promise<LineageWorkspaceStore> {
  const path = storagePathFor(cwd)
  try {
    return parseStore(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SidebarError) throw error
    return { ...EMPTY_STORE, workspaces: [] }
  }
}

async function writeStore(cwd: string, store: LineageWorkspaceStore): Promise<void> {
  const path = storagePathFor(cwd)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

function summaryOf(workspace: LineageWorkspace): LineageWorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    nodeCount: workspace.nodes.length,
    edgeCount: workspace.edges.length,
  }
}

function normalizeGraphPayload(payload: unknown): LineageGraph {
  const record = asRecord(asRecord(payload).graph)
  return asGraph(record)
}

export function buildLineageWorkspaceApi(cwdOf: CwdResolver): Record<string, (payload: unknown) => Promise<unknown>> {
  return {
    'lineage.workspace.list': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const store = await readStore(cwd)
      return {
        workspaces: store.workspaces
          .map(summaryOf)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      }
    },

    'lineage.workspace.get': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const id = requireString(payload, 'id')
      const store = await readStore(cwd)
      const workspace = store.workspaces.find((item) => item.id === id)
      if (workspace === undefined) throw new SidebarError('not-found', 'lineage workspace not found', 404)
      return { workspace }
    },

    'lineage.workspace.save': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const record = asRecord(payload)
      const id = asString(record.id)
      const name = asString(record.name).trim() || '未命名血缘图'
      const description = asString(record.description)
      const sourceAssets = Array.isArray(record.sourceAssets) ? record.sourceAssets.map(String) : undefined
      const graph = normalizeGraphPayload(payload)
      const now = new Date().toISOString()
      const store = await readStore(cwd)
      const revision: LineageRevision = {
        id: `rev-${randomUUID()}`,
        createdAt: now,
        source: asString(record.source, 'manual'),
        nodes: graph.nodes,
        edges: graph.edges,
      }

      if (id === '') {
        const workspace: LineageWorkspace = {
          id: `lw-${randomUUID()}`,
          name,
          description: description === '' ? undefined : description,
          createdAt: now,
          updatedAt: now,
          ...(sourceAssets !== undefined ? { sourceAssets } : {}),
          nodes: graph.nodes,
          edges: graph.edges,
          revisions: [revision],
        }
        store.workspaces.push(workspace)
        await writeStore(cwd, store)
        return { workspace }
      }

      const index = store.workspaces.findIndex((item) => item.id === id)
      if (index < 0) throw new SidebarError('not-found', 'lineage workspace not found', 404)
      const previous = store.workspaces[index]!
      const revisions = [...(previous.revisions ?? []), revision].slice(-20)
      const updated: LineageWorkspace = {
        ...previous,
        name,
        description: description === '' ? undefined : description,
        updatedAt: now,
        ...(sourceAssets !== undefined ? { sourceAssets } : {}),
        nodes: graph.nodes,
        edges: graph.edges,
        revisions,
      }
      store.workspaces[index] = updated
      await writeStore(cwd, store)
      return { workspace: updated }
    },

    'lineage.workspace.delete': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const id = requireString(payload, 'id')
      const store = await readStore(cwd)
      const next = store.workspaces.filter((item) => item.id !== id)
      if (next.length === store.workspaces.length) throw new SidebarError('not-found', 'lineage workspace not found', 404)
      await writeStore(cwd, { version: 1, workspaces: next })
      return { ok: true }
    },

    'lineage.workspace.restore': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const record = asRecord(payload)
      const id = requireString(payload, 'id')
      const revisionId = requireString(payload, 'revisionId')
      const store = await readStore(cwd)
      const index = store.workspaces.findIndex((item) => item.id === id)
      if (index < 0) throw new SidebarError('not-found', 'lineage workspace not found', 404)
      const workspace = store.workspaces[index]!
      const revision = (workspace.revisions ?? []).find((item) => item.id === revisionId)
      if (revision === undefined) throw new SidebarError('not-found', 'lineage revision not found', 404)
      const restored: LineageWorkspace = {
        ...workspace,
        updatedAt: new Date().toISOString(),
        nodes: revision.nodes,
        edges: revision.edges,
        revisions: [...(workspace.revisions ?? []), {
          id: `rev-${randomUUID()}`,
          createdAt: new Date().toISOString(),
          source: 'restore',
          nodes: revision.nodes,
          edges: revision.edges,
        }].slice(-20),
      }
      store.workspaces[index] = restored
      await writeStore(cwd, store)
      return { workspace: restored }
    },

    'lineage.workspace.storage': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const path = storagePathFor(cwd)
      const info = await stat(path).catch(() => undefined)
      return { path, exists: info !== undefined, size: info?.size ?? 0 }
    },
  }
}
