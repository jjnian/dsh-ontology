import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from '../service.ts'
import { api, type DatabaseConnectionInput, type DbColumnInfo, type DbObjectInfo, type SessionScope } from '../api.ts'
import { t } from '../locales.ts'
import { LineageGraph, type LineageGraphHandle } from './LineageGraph.tsx'
import {
  type LineageGraph as LineageGraphData,
  type LineageEdge,
  type LineageHistoryEntry,
  type LineageNode,
  type LineageWorkspaceSummary,
  evidenceTexts,
  mergeEvidence,
} from './lineage-types.ts'
import { typeStyle } from './graph-style.ts'
import { DEMO_LINEAGE } from './lineage-demo.ts'
import { validateOntology, type ValidationIssue } from './ontology-validation.ts'
import { relationDef, nodeTypeDef, nodeLayer, endpointMatchesLayer, ONTOLOGY_RELATIONS, ONTOLOGY_NODE_TYPES } from './ontology-definitions.ts'
import type { LineagePatchEntry } from './lineage-extract.ts'
import { extractOntologyProfile } from './ontology-semantics.ts'
import { reasonOntology } from './ontology-reasoner.ts'
import {
  buildInstanceImport,
  applyGovernanceReview,
  applyGovernanceReviews,
  classifySourceMapping,
  governanceReviews,
  inferInstanceRelations,
  suggestColumnMappings,
  validateInstances,
  type GovernanceReviewItem,
} from './data-integration.ts'
import { analyzeLineageImpact, findLineagePaths, highlightForTrace, lineageHealth, traceLineage } from './graph-analysis.ts'
import { applyLineagePatch } from './lineage-patch.ts'
import { collapseLineageByDomain, layoutDomainGroups } from './domain-collapse.ts'
import css from '../sidebar.module.css'

/** Lineage source badge colors (mirror of EIC-CC's tailwind sourceMeta). */
const SOURCE_COLORS: Record<string, { bg: string; color: string }> = {
  derived:  { bg: '#ecfdf5', color: '#047857' },
  inferred: { bg: '#fffbeb', color: '#b45309' },
  manual:   { bg: '#f0f9ff', color: '#0369a1' },
  preset:   { bg: '#f1f5f9', color: '#475569' },
}

type NodeDetailTab = 'overview' | 'inference' | 'mapping'

const NODE_DETAIL_TABS: { id: NodeDetailTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'inference', label: '推理' },
  { id: 'mapping', label: '映射' },
]

/**
 * The built-in lineage tab: renders a lineage graph (nodes/edges) ported
 * from EIC-CC. Loads from a workspace JSON file (`{ nodes, edges }`) or from
 * the built-in demo dataset, and opens a node detail panel on selection.
 */
/** Grouped toolbar dropdown for the lineage tab. */
function LineageDropdown(
  props: { label: string; open: boolean; onToggle: () => void; children: ReactNode; primary?: boolean },
): ReactNode {
  return (
    <div className={css.lineageDropdownWrap}>
      <button
        type="button"
        className={props.primary === true ? css.lineagePrimaryButton : css.lineageToolbarButton}
        onClick={props.onToggle}
      >
        {props.label}
        <span className={css.lineageDropdownCaret}>{props.open ? '▴' : '▾'}</span>
      </button>
      {props.open && <div className={css.lineageDropdownMenu}>{props.children}</div>}
    </div>
  )
}

export function LineageGraphTab(props: TabComponentProps) {
  const { scope, visible } = props
  const [graph, setGraph] = useState<LineageGraphData>(DEMO_LINEAGE)
  const [workspaces, setWorkspaces] = useState<LineageWorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [history, setHistory] = useState<LineageHistoryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<LineageNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<LineageEdge | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [editMode, setEditMode] = useState<'none' | 'addNode' | 'connect'>('none')
  const [addLabel, setAddLabel] = useState('')
  const [addLayer, setAddLayer] = useState<'class' | 'instance'>('class')
  const [addType, setAddType] = useState('entity')
  const [connectSource, setConnectSource] = useState<string | null>(null)
  const [connectTarget, setConnectTarget] = useState<string | null>(null)
  const [connectRelType, setConnectRelType] = useState('depends_on')
  const [assetOpen, setAssetOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [pathFromId, setPathFromId] = useState('')
  const [pathToId, setPathToId] = useState('')
  const [instanceOpen, setInstanceOpen] = useState(false)
  const [instanceLoading, setInstanceLoading] = useState(false)
  const [instanceConnections, setInstanceConnections] = useState<(DatabaseConnectionInput & { id: string; name: string })[]>([])
  const [instanceConnectionId, setInstanceConnectionId] = useState('')
  const [instanceDatabases, setInstanceDatabases] = useState<string[]>([])
  const [instanceDatabase, setInstanceDatabase] = useState('')
  const [instanceTables, setInstanceTables] = useState<DbObjectInfo[]>([])
  const [instanceTable, setInstanceTable] = useState('')
  const [instanceColumns, setInstanceColumns] = useState<string[]>([])
  const [instancePrimaryKey, setInstancePrimaryKey] = useState('')
  const [instanceLabelColumn, setInstanceLabelColumn] = useState('')
  const [instanceLimit, setInstanceLimit] = useState(50)
  const [instanceTargetId, setInstanceTargetId] = useState('')
  const [undoStack, setUndoStack] = useState<LineageGraphData[]>([])
  const [redoStack, setRedoStack] = useState<LineageGraphData[]>([])
  const [pendingPatch, setPendingPatch] = useState<LineagePatchEntry | null>(null)
  const [domainCollapsed, setDomainCollapsed] = useState(false)
  const [expandedDomains, setExpandedDomains] = useState<ReadonlySet<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState<'none' | 'edit'>('none')
  const historyRef = useRef<string | null>(null)

  // Recompute ontology validation whenever the graph changes
  useEffect(() => { setIssues(validateOntology(graph).filter((issue) => issue.severity === 'error')) }, [graph])

  /** Keep a bounded local edit stack so imports, review, and manual edits can be undone. */
  const graphHistorySkipRef = useRef(false)
  const graphHistoryRef = useRef(graph)
  useEffect(() => {
    if (graphHistorySkipRef.current) {
      graphHistorySkipRef.current = false
      graphHistoryRef.current = graph
      return
    }
    if (graphHistoryRef.current === graph) return
    const previous = graphHistoryRef.current
    graphHistoryRef.current = graph
    setUndoStack((current) => [...current.slice(-49), previous])
    setRedoStack([])
  }, [graph])

  /** All low-trust relations, mappings, and imported instances in one governance queue. */
  const reviews = useMemo(() => governanceReviews(graph), [graph])
  const canvasRef = useRef<LineageGraphHandle>(null)
  const trace = useMemo(
    () => selected === null ? null : traceLineage(graph, selected.id),
    [graph, selected],
  )
  const traceHighlight = useMemo(
    () => analysisOpen && selected !== null ? highlightForTrace(trace).nodes : null,
    [analysisOpen, selected, trace],
  )
  const health = useMemo(() => lineageHealth(graph), [graph])
  const collapsedView = useMemo(
    () => layoutDomainGroups(collapseLineageByDomain(graph, expandedDomains), graph),
    [graph, expandedDomains],
  )
  const sourceTags = useMemo(() => {
    const tags = new Map<string, { key: string; icon: string; label: string; title: string }>()
    const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

    for (const item of [...graph.nodes, ...graph.edges]) {
      for (const evidence of item.evidences ?? []) {
        const summary = evidence.summary || evidence.detail || ''
        if (evidence.type === 'file') {
          const label = evidence.sourcePath !== undefined && evidence.sourcePath !== ''
            ? basename(evidence.sourcePath)
            : summary.slice(0, 32)
          const key = `file:${evidence.sourcePath ?? summary}`
          if (label !== '') tags.set(key, { key, icon: '📄', label, title: evidence.sourcePath ?? summary })
        } else if (evidence.type === 'database' || evidence.type === 'ddl' || evidence.type === 'sql') {
          const label = evidence.database !== undefined && evidence.objectName !== undefined
            ? `${evidence.database}.${evidence.objectName}`
            : evidence.database ?? evidence.objectName ?? evidence.connectionId ?? basename(evidence.sourcePath ?? '')
          const key = `db:${evidence.connectionId ?? evidence.database ?? evidence.objectName ?? evidence.sourcePath ?? summary}`
          if (label !== '') tags.set(key, { key, icon: '🗄️', label, title: evidence.detail ?? summary })
        } else if (evidence.type === 'llm') {
          tags.set('llm', { key: 'llm', icon: '✨', label: 'LLM联想', title: summary })
        } else if (evidence.type === 'manual') {
          tags.set('manual', { key: 'manual', icon: '✍️', label: '手动来源', title: summary })
        }
      }
    }
    return [...tags.values()]
  }, [graph])

  const displayGraph = domainCollapsed
    ? { nodes: collapsedView.nodes, edges: collapsedView.edges }
    : graph

  const loadPendingPatch = useCallback(async (): Promise<void> => {
    try {
      const result = await api.lineagePatch(scope)
      setPendingPatch(result.patch)
    } catch {
      // Patch review is progressive; an unavailable event log should not break graph viewing.
    }
  }, [scope.sessionId, scope.cwd])

  const applyWorkspace = useCallback((workspace: { id: string; name: string; nodes: LineageNode[]; edges: LineageEdge[] }): void => {
    setWorkspaceId(workspace.id)
    setWorkspaceName(workspace.name)
    setGraph({ nodes: workspace.nodes, edges: workspace.edges })
    setSelected(null)
    setSelectedEdge(null)
    setPendingPatch(null)
  }, [])

  const loadWorkspace = useCallback(async (id: string): Promise<void> => {
    setWorkspaceLoading(true)
    try {
      const result = await api.lineageWorkspaceGet(scope, id)
      applyWorkspace(result.workspace)
    } catch {
      setError('加载血缘工作区失败')
    } finally {
      setWorkspaceLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  const loadWorkspaceList = useCallback(async (autoLoad = true): Promise<LineageWorkspaceSummary[]> => {
    setWorkspaceLoading(true)
    try {
      const result = await api.lineageWorkspaceList(scope)
      setWorkspaces(result.workspaces)
      if (autoLoad && result.workspaces.length > 0) {
        await loadWorkspace(result.workspaces[0]!.id)
      }
      else if (!autoLoad) {
        setWorkspaceId('')
        setWorkspaceName('')
      }
      return result.workspaces
    } catch {
      setError('加载血缘工作区列表失败')
      return []
    } finally {
      setWorkspaceLoading(false)
    }
  }, [loadWorkspace, scope.sessionId, scope.cwd])

  /** Persist a newly generated conversation snapshot as a switchable graph version. */
  const autoSaveGraph = useCallback(async (entry: LineageHistoryEntry): Promise<void> => {
    if (historyRef.current === entry.id) return
    const savedWorkspaces = await loadWorkspaceList(false)
    if (savedWorkspaces.some((workspace) => workspace.description === entry.id)) {
      historyRef.current = entry.id
      return
    }
    try {
      const result = await api.lineageWorkspaceSave(scope, {
        description: entry.id,
        name: entry.turn !== undefined ? `对话生成 · 第${entry.turn}轮` : `对话生成 · ${new Date(entry.time).toLocaleString()}`,
        graph: entry.graph,
        source: 'llm',
      })
      historyRef.current = entry.id
      applyWorkspace(result.workspace)
      await loadWorkspaceList(false)
    } catch {
      setError('自动保存血缘图版本失败')
    }
  }, [applyWorkspace, loadWorkspaceList, scope.sessionId, scope.cwd])

  /** Pull the latest graph the model generated in the current conversation. */
  const generateFromChat = useCallback(async (silent: boolean): Promise<void> => {
    setChatLoading(true)
    if (!silent) setError(null)
    try {
      const result = await api.lineageHistory(scope)
      if (result.history.length > 0) {
        const latest = result.history[0]
        if (latest === undefined) return
        setHistory(result.history)
        setGraph(latest.graph)
        setSelected(null)
        setSelectedEdge(null)
        await autoSaveGraph(latest)
      } else if (!silent) {
        setError(t('lineageNoGraph'))
      }
    } catch {
      if (!silent) setError(t('lineageLoadError'))
    } finally {
      setChatLoading(false)
    }
  }, [autoSaveGraph, scope.sessionId, scope.cwd])

  const applyPendingPatch = async (): Promise<void> => {
    if (pendingPatch === null) return
    const result = applyLineagePatch(graph, pendingPatch.patch)
    if (result.summary.failed.length > 0) {
      setError(`增量变更未应用：${result.summary.failed[0]?.message ?? '操作无效'}`)
      return
    }
    setGraph(result.graph)
    setPendingPatch(null)
    setError(null)
    if (workspaceId !== '' && workspaceName.trim() !== '') {
      try {
        const saved = await api.lineageWorkspaceSave(scope, { id: workspaceId, name: workspaceName, graph: result.graph })
        applyWorkspace(saved.workspace)
        await loadWorkspaceList(false)
      } catch {
        setError('增量变更已应用，但保存工作区失败')
      }
    }
  }

  const undoGraph = (): void => {
    const previous = undoStack.at(-1)
    if (previous === undefined) return
    setUndoStack((current) => current.slice(0, -1))
    setRedoStack((current) => [graph, ...current].slice(0, 50))
    graphHistorySkipRef.current = true
    setGraph(previous)
  }

  const redoGraph = (): void => {
    const next = redoStack.at(-1)
    if (next === undefined) return
    setRedoStack((current) => current.slice(0, -1))
    setUndoStack((current) => [...current.slice(-49), graph])
    graphHistorySkipRef.current = true
    setGraph(next)
  }

  const confirmReviewEdge = (edge: LineageEdge): void => {
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((candidate) => candidate.id === edge.id
        ? {
            ...candidate,
            confidence: Math.max(candidate.confidence ?? 0.5, 0.9),
            properties: {
              ...candidate.properties,
              reviewStatus: 'confirmed',
              reviewedAt: new Date().toISOString(),
            },
          }
        : candidate),
    }))
    if (selectedEdge?.id === edge.id) {
      setSelectedEdge((current) => current === null ? null : { ...current, properties: { ...current.properties, reviewStatus: 'confirmed' } })
    }
  }

  const rejectReviewEdge = (edge: LineageEdge): void => {
    setGraph((current) => ({ ...current, edges: current.edges.filter((candidate) => candidate.id !== edge.id) }))
    if (selectedEdge?.id === edge.id) setSelectedEdge(null)
  }

  const updateSelectedEdge = (edge: LineageEdge): void => {
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((candidate) => candidate.id === edge.id ? edge : candidate),
    }))
    setSelectedEdge(edge)
  }

  const verifyEdgeContainment = async (edge: LineageEdge): Promise<{ ok: boolean; message: string }> => {
    const childObject = String(edge.properties?.childObject ?? '')
    const parentObject = String(edge.properties?.parentObject ?? '')
    const childColumn = String(edge.properties?.childColumn ?? '')
    const parentColumn = String(edge.properties?.parentColumn ?? '')
    if (childObject === '' || parentObject === '' || childColumn === '' || parentColumn === '') {
      return { ok: false, message: '缺少列级血缘信息，无法佐证' }
    }
    try {
      const view = await api.settingsGet()
      const pluginSettings = (view.value as { pluginSettings?: Record<string, unknown> } | undefined)?.pluginSettings ?? {}
      const blob = pluginSettings.database as { connections?: unknown } | undefined
      const raw = Array.isArray(blob?.connections) ? blob!.connections : []
      const child = graph.nodes.find((node) => node.id === edge.from)
      const parent = graph.nodes.find((node) => node.id === edge.to)
      const childBinding = Array.isArray(child?.properties?.sourceBindings)
        ? (child!.properties!.sourceBindings as Array<Record<string, unknown>>).find((item) => item.objectName === childObject)
        : undefined
      const parentBinding = Array.isArray(parent?.properties?.sourceBindings)
        ? (parent!.properties!.sourceBindings as Array<Record<string, unknown>>).find((item) => item.objectName === parentObject)
        : undefined
      const shared = raw
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          ...item,
          id: String(item.id ?? ''),
          name: String(item.name ?? ''),
          engine: item.engine === 'postgresql' || item.engine === 'dm' ? item.engine : 'mysql',
        })) as (DatabaseConnectionInput & { id: string; name: string })[]
      const connectionId = String(childBinding?.connectionId ?? parentBinding?.connectionId ?? '')
      const connection = shared.find((item) => item.id === connectionId)
      const database = String(childBinding?.database ?? parentBinding?.database ?? '')
      if (connection === undefined || database === '') return { ok: false, message: '缺少数据源映射，请先在节点详情中完成映射' }
      const identifier = (value: string): string => connection.engine === 'mysql' ? `\`${value}\`` : `"${value}"`
      const childName = identifier(childObject)
      const parentName = identifier(parentObject)
      const childColumnId = identifier(childColumn)
      const parentColumnId = identifier(parentColumn)
      const sql = `SELECT COUNT(*) AS total, SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM ${parentName} WHERE ${parentName}.${parentColumnId} = ${childName}.${childColumnId}) THEN 1 ELSE 0 END) AS missing FROM ${childName}`
      const result = await api.dbQuery({ ...connection, database }, sql)
      if (result.kind !== 'rows') return { ok: false, message: 'SQL 返回格式异常' }
      const columnIndex = result.columns.findIndex((column) => /total|total_count/i.test(column))
      const missingIndex = result.columns.findIndex((column) => /missing|invalid/i.test(column))
      const total = Number(result.rows[0]?.[columnIndex] ?? 0)
      const missing = Number(result.rows[0]?.[missingIndex] ?? 0)
      const ok = total > 0 && missing === 0
      const next = {
        ...edge,
        confidence: ok ? Math.max(edge.confidence ?? 0.5, 0.9) : 0.25,
        properties: {
          ...edge.properties,
          reviewStatus: ok ? 'confirmed' : edge.properties?.reviewStatus,
          dataCheck: { total, missing, checkedAt: new Date().toISOString() },
        },
        evidences: [
          ...(edge.evidences ?? []),
          { id: `check:${Date.now()}`, type: 'data-check', summary: `值包含检验：total=${total}，missing=${missing}` },
        ],
      }
      setGraph((current) => ({ ...current, edges: current.edges.map((candidate) => candidate.id === edge.id ? next : candidate) }))
      if (selectedEdge?.id === edge.id) setSelectedEdge(next)
      return { ok, message: ok ? '数据佐证通过' : `数据佐证未通过：缺失 ${missing} / ${total}` }
    } catch {
      return { ok: false, message: '数据源连接失败' }
    }
  }

  // The latest persisted workspace is authoritative after the first load;
  // conversation snapshots remain available through "Generate from chat".
  useEffect(() => {
    if (!visible) return
    void loadWorkspaceList(false).finally(() => {
      void loadPendingPatch()
      void generateFromChat(true)
    })
  }, [visible, loadWorkspaceList, loadPendingPatch, generateFromChat])

  /** Add a node at the clicked canvas position (edit mode). */
  /** Confirm the add-node modal and create the node. */
  const confirmAddNode = (): void => {
    if (addLabel.trim() === '') return
    const id = 'n-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const count = graph.nodes.length
    const x = 80 + (count % 5) * 220
    const y = 40 + Math.floor(count / 5) * 100
    const node: LineageNode = { id, label: addLabel.trim(), layer: addLayer, type: addType, x, y, source: 'manual' }
    setGraph((g) => ({ ...g, nodes: [...g.nodes, node] }))
    setAddLabel('')
    setEditMode('none')
  }

  /** In connect mode: first click sets source, second opens the relation picker. */
  const handleConnectClick = (nodeId: string): void => {
    if (connectSource === null) {
      setConnectSource(nodeId)
      return
    }
    if (connectSource === nodeId) { setConnectSource(null); return }
    setConnectTarget(nodeId)
  }

  /** Confirm the relation picker and create the edge. */
  const confirmConnect = (): void => {
    if (connectSource === null || connectTarget === null) return
    const edgeId = 'e-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    setGraph((g) => ({
      ...g,
      edges: [...g.edges, { id: edgeId, from: connectSource, to: connectTarget, rel_type: connectRelType, source: 'manual' }],
    }))
    setConnectSource(null)
    setConnectTarget(null)
    setEditMode('none')
  }

  /** Delete the currently selected node (and its edges) or edge. */
  const deleteSelected = (): void => {
    if (selectedEdge !== null) {
      setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== selectedEdge.id) }))
      setSelectedEdge(null)
      return
    }
    if (selected !== null) {
      setGraph((g) => ({
        nodes: g.nodes.filter((n) => n.id !== selected.id),
        edges: g.edges.filter((e) => e.from !== selected.id && e.to !== selected.id),
      }))
      setSelected(null)
    }
  }

  /** Merge inferred asset nodes/edges into the current graph without duplicates. */
  const mergeAssetGraph = (incoming: LineageGraphData): void => {
    setGraph((current) => {
      const nodeIds = new Set(current.nodes.map((node) => node.id))
      const edgeIds = new Set(current.edges.map((edge) => edge.id))
      return {
        nodes: [
          ...current.nodes.map((node) => {
            const duplicate = incoming.nodes.find((candidate) => candidate.id === node.id)
            return duplicate === undefined ? node : mergeEvidence(node, duplicate)
          }),
          ...incoming.nodes.filter((node) => !nodeIds.has(node.id)),
        ],
        edges: [
          ...current.edges.map((edge) => {
            const duplicate = incoming.edges.find((candidate) => candidate.id === edge.id)
            return duplicate === undefined ? edge : mergeEvidence(edge, duplicate)
          }),
          ...incoming.edges.filter((edge) => !edgeIds.has(edge.id)),
        ],
      }
    })
  }


  const loadInstanceConnection = async (connectionId: string): Promise<void> => {
    setInstanceConnectionId(connectionId)
    setInstanceDatabases([])
    setInstanceDatabase('')
    setInstanceTables([])
    setInstanceTable('')
    setInstanceColumns([])
    setInstancePrimaryKey('')
    setInstanceLabelColumn('')
    const connection = instanceConnections.find((item) => item.id === connectionId)
    if (connection === undefined) return
    setInstanceLoading(true)
    try {
      const result = await api.dbDatabases(connection)
      setInstanceDatabases(result.databases)
      if (result.databases.length === 1) {
        setInstanceDatabase(result.databases[0]!)
      }
    } catch {
      setError(t('databaseLoadError'))
    } finally {
      setInstanceLoading(false)
    }
  }

  const loadInstanceTables = async (database: string): Promise<void> => {
    setInstanceDatabase(database)
    setInstanceTables([])
    setInstanceTable('')
    setInstanceColumns([])
    setInstancePrimaryKey('')
    setInstanceLabelColumn('')
    const connection = instanceConnections.find((item) => item.id === instanceConnectionId)
    if (connection === undefined || database === '') return
    setInstanceLoading(true)
    try {
      const result = await api.dbObjects({ ...connection, database }, database, 'tables')
      setInstanceTables(result.objects)
    } catch {
      setError(t('databaseLoadError'))
    } finally {
      setInstanceLoading(false)
    }
  }

  const loadInstanceColumns = async (table: string): Promise<void> => {
    setInstanceTable(table)
    setInstanceColumns([])
    setInstancePrimaryKey('')
    setInstanceLabelColumn('')
    const connection = instanceConnections.find((item) => item.id === instanceConnectionId)
    if (connection === undefined || instanceDatabase === '' || table === '') return
    setInstanceLoading(true)
    try {
      const result = await api.dbColumns({ ...connection, database: instanceDatabase }, instanceDatabase, table)
      const columns = result.columns.map((column) => column.name)
      setInstanceColumns(columns)
      setInstancePrimaryKey(columns[0] ?? '')
      const labelColumn = columns.find((column) => /name|title|label/i.test(column))
      setInstanceLabelColumn(labelColumn ?? columns[0] ?? '')
    } catch {
      setError(t('databaseLoadError'))
    } finally {
      setInstanceLoading(false)
    }
  }

  const openInstanceImport = async (): Promise<void> => {
    setInstanceOpen(true)
    setInstanceLoading(true)
    setError(null)
    try {
      const view = await api.settingsGet()
      const pluginSettings = (view.value as { pluginSettings?: Record<string, unknown> } | undefined)?.pluginSettings ?? {}
      const blob = pluginSettings.database as { connections?: unknown } | undefined
      const raw = Array.isArray(blob?.connections) ? blob!.connections : []
      const connections = raw
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .filter((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.host === 'string')
        .map((item) => ({
          ...item,
          engine: item.engine === 'postgresql' || item.engine === 'dm' ? item.engine : 'mysql',
          port: typeof item.port === 'number' ? item.port : 3306,
          user: typeof item.user === 'string' ? item.user : '',
          password: typeof item.password === 'string' ? item.password : '',
        })) as (DatabaseConnectionInput & { id: string; name: string })[]
      setInstanceConnections(connections)
      setInstanceConnectionId('')
      setInstanceTargetId(graph.nodes.find((node) => node.type === 'class')?.id ?? '')
    } catch {
      setError(t('databaseLoadError'))
    } finally {
      setInstanceLoading(false)
    }
  }

  const importInstances = async (): Promise<void> => {
    const connection = instanceConnections.find((item) => item.id === instanceConnectionId)
    if (connection === undefined || instanceDatabase === '' || instanceTable === '' || instanceTargetId === '' || instancePrimaryKey === '') return
    setInstanceLoading(true)
    setError(null)
    try {
      const identifier = connection.engine === 'postgresql' ? `"${instanceTable}"` : instanceTable
      const sql = connection.engine === 'dm'
        ? `SELECT * FROM ${identifier} WHERE ROWNUM <= ${instanceLimit}`
        : `SELECT * FROM ${connection.engine === 'mysql' ? '`' + instanceTable + '`' : identifier} LIMIT ${instanceLimit}`
      const result = await api.dbQuery({ ...connection, database: instanceDatabase }, sql)
      if (result.kind !== 'rows') return
      const records = result.rows.map((row) => {
        const record: Record<string, unknown> = {}
        result.columns.forEach((column, index) => { record[column] = row[index] })
        return record
      })
      const binding = {
        connectionId: connection.id,
        connectionName: connection.name,
        engine: connection.engine,
        database: instanceDatabase,
        objectKind: 'table',
        objectName: instanceTable,
        primaryKey: instancePrimaryKey,
      }
      const candidates = records.map((record) => buildInstanceImport(record, {
        classId: instanceTargetId,
        binding,
        labelColumn: instanceLabelColumn !== '' ? instanceLabelColumn : instancePrimaryKey,
      })).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      setGraph((current) => {
        const nodes = [...current.nodes]
        const edges = [...current.edges]
        const edgeIds = new Set(edges.map((edge) => edge.id))
        for (const candidate of candidates) {
          const nodeIndex = nodes.findIndex((node) => node.id === candidate.node.id)
          if (nodeIndex >= 0) {
            const existing = nodes[nodeIndex]!
            nodes[nodeIndex] = {
              ...existing,
              label: existing.label || candidate.node.label,
              properties: {
                ...existing.properties,
                primaryKey: candidate.node.properties?.primaryKey,
                values: candidate.node.properties?.values,
                sourceBinding: candidate.node.properties?.sourceBinding,
              },
            }
          } else {
            nodes.push(candidate.node)
          }
          if (!edgeIds.has(candidate.edge.id)) {
            edges.push(candidate.edge)
            edgeIds.add(candidate.edge.id)
          }
        }
        const relationIds = new Set(edges.map((edge) => edge.id))
        for (const candidate of candidates) {
          const instance = nodes.find((node) => node.id === candidate.node.id)
          if (instance === undefined) continue
          for (const relation of inferInstanceRelations({ nodes, edges }, instance, candidate.businessKey)) {
            const edgeId = `edge:${relation.fromInstanceId}:${relation.relationType}:${relation.toInstanceId}:${relation.sourceColumn}`
            if (relationIds.has(edgeId)) continue
            edges.push({
              id: edgeId,
              from: relation.fromInstanceId,
              to: relation.toInstanceId,
              label: relation.relationType === 'is_a' ? '继承实例' : '依赖',
              rel_type: relation.relationType,
              source: 'inferred',
              confidence: relation.confidence,
              evidence: `${instanceTable}.${relation.sourceColumn}`,
              properties: { reviewStatus: 'pending', sourceColumn: relation.sourceColumn },
            })
            relationIds.add(edgeId)
          }
        }
        return { nodes, edges }
      })
      setInstanceOpen(false)
    } catch {
      setError(t('databaseLoadError'))
    } finally {
      setInstanceLoading(false)
    }
  }
  return (
    <div className={css.editor}>
      <div className={`${css.editorHeader} ${css.lineageHeader}`}>
        <select
          aria-label="血缘图版本"
          className={css.lineageSelect}
          value={workspaceId}
          disabled={workspaceLoading}
          onChange={(event) => {
            const id = event.target.value
            if (id !== '') void loadWorkspace(id)
          }}
        >
          <option value="">当前会话图</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} · {workspace.nodeCount}N/{workspace.edgeCount}E
            </option>
          ))}
        </select>
        <LineageDropdown label="编辑" open={menuOpen === 'edit'} onToggle={() => setMenuOpen(menuOpen === 'edit' ? 'none' : 'edit')}>
          <button type="button" className={css.lineageDropdownItem} disabled={domainCollapsed} onClick={() => { setMenuOpen('none'); setEditMode(editMode === 'addNode' ? 'none' : 'addNode'); setSelected(null); setSelectedEdge(null) }}>
            {editMode === 'addNode' ? t('lineageCancelEdit') : t('lineageAddNode')}
          </button>
          <button type="button" className={css.lineageDropdownItem} disabled={domainCollapsed} onClick={() => { setMenuOpen('none'); setEditMode(editMode === 'connect' ? 'none' : 'connect'); setSelected(null); setSelectedEdge(null) }}>
            {editMode === 'connect' ? t('lineageCancelEdit') : t('lineageConnect')}
          </button>
          <button type="button" className={css.lineageDropdownItem} disabled={domainCollapsed || (selected === null && selectedEdge === null)} onClick={() => { setMenuOpen('none'); deleteSelected() }}>
            {t('lineageDelete')}
          </button>
          <button type="button" className={css.lineageDropdownItem} disabled={domainCollapsed} onClick={() => {
            setMenuOpen('none')
            const next = !domainCollapsed
            setDomainCollapsed(next)
            if (next) setExpandedDomains(new Set())
          }}>
            {domainCollapsed ? '展开领域' : '领域折叠'}
          </button>
          <button type="button" className={css.lineageDropdownItem} disabled={undoStack.length === 0} onClick={() => { setMenuOpen('none'); undoGraph() }}>撤销</button>
          <button type="button" className={css.lineageDropdownItem} disabled={redoStack.length === 0} onClick={() => { setMenuOpen('none'); redoGraph() }}>重做</button>
        </LineageDropdown>
        <span className={css.lineageHeaderSpacer} />
        <input
          className={css.lineageSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('lineageSearchPlaceholder')}
        />
        <button type="button" className={css.lineageIconButton} title={t('lineageZoomOut')} onClick={() => canvasRef.current?.zoomOut()}>−</button>
        <button type="button" className={css.lineageIconButton} title={t('lineageZoomIn')} onClick={() => canvasRef.current?.zoomIn()}>+</button>
        <button type="button" className={css.lineageToolbarButton} title={t('lineageFit')} onClick={() => canvasRef.current?.fit()}>{t('lineageFit')}</button>
        {sourceTags.length > 0 && (
          <div className={css.lineageSourceTags} aria-label="血缘图来源">
            {sourceTags.map((tag) => (
              <span key={tag.key} className={css.lineageSourceTag} title={tag.title}>
                {tag.icon} {tag.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={css.editorBody} style={{ position: 'relative', overflow: 'hidden' }}>
        <div className={css.lineageFloatActions}>
          <button
            type="button"
            className={css.lineageFloatButton}
            onClick={() => setAnalysisOpen((current) => !current)}
            title="血缘分析"
          >
            分析
          </button>
          <button
            type="button"
            className={css.lineageFloatButton}
            onClick={() => setReviewOpen(true)}
            title="审核队列"
          >
            审核{reviews.length > 0 ? ' · ' + reviews.length : ''}
          </button>
        </div>
        <div className={css.editorMain}>
          {pendingPatch !== null && (
            <div className={css.lineageValidationBanner}>
              <div className={css.lineageValidationWarning}>
                <strong>对话增量变更</strong>
                <span> · {pendingPatch.patch.reason ?? '模型请求更新当前血缘图'}</span>
              </div>
              <div className={css.lineageValidationWarning}>
                {pendingPatch.patch.ops.map((operation, index) => (
                  <span key={`${operation.op}-${index}`} style={{ marginRight: 8 }}>
                    {operation.op}
                  </span>
                ))}
              </div>
              {pendingPatch.issues.length > 0 && (
                <div className={css.lineageValidationError}>{pendingPatch.issues.join('；')}</div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" className={css.lineagePrimaryButton} onClick={() => void applyPendingPatch()}>
                  确认应用
                </button>
                <button type="button" className={css.lineageToolbarButton} onClick={() => setPendingPatch(null)}>
                  忽略
                </button>
              </div>
            </div>
          )}
          {issues.length > 0 && (
            <div className={css.lineageValidationBanner}>
              {issues.slice(0, 5).map((issue, index) => (
                <div
                  key={index}
                  className={issue.severity === 'error' ? css.lineageValidationError : css.lineageValidationWarning}
                >
                  <strong>{issue.category ?? '冲突'}</strong> · {issue.message}
                </div>
              ))}
              {issues.length > 5 && (
                <div className={css.lineageValidationWarning}>还有 {issues.length - 5} 个冲突</div>
              )}
            </div>
          )}
          {error !== null && <div className={css.editorError}>{error}</div>}
          {error === null && graph.nodes.length === 0 && <div className={css.editorPlaceholder}>{t('lineageEmpty')}</div>}
          {error === null && graph.nodes.length > 0 && (
            <LineageGraph
              ref={canvasRef}
              nodes={displayGraph.nodes}
              edges={displayGraph.edges}
              selectedId={selected?.id}
              selectedEdgeId={selectedEdge?.id}
              highlight={traceHighlight}
              query={query}
              onSelect={(node) => {
                if (node === null) return
                if (domainCollapsed && node.type === 'domain') {
                  const domain = node.domain ?? node.label
                  setExpandedDomains((current) => {
                    const next = new Set(current)
                    if (next.has(domain)) next.delete(domain)
                    else next.add(domain)
                    return next
                  })
                  setSelected(null)
                  setSelectedEdge(null)
                  return
                }
                setSelectedEdge(null)
                setSelected(node)
              }}
              onSelectEdge={(edge) => {
                setSelected(null)
                setSelectedEdge(edge)
              }}
            />
          )}
        </div>
        {selected !== null && (
          <NodeDetailPanel
            node={selected}
            graph={graph}
            onSelectNode={(node) => {
              setSelectedEdge(null)
              setSelected(node)
            }}
            onClose={() => setSelected(null)}
            onUpdateNode={(node) => {
              setGraph((current) => ({ ...current, nodes: current.nodes.map((candidate) => candidate.id === node.id ? node : candidate) }))
              setSelected(node)
            }}
          />
        )}

        {analysisOpen && (
          <LineageDetailShell>
            <div className={css.lineageDetailHeader}>
              <div className={css.lineageDetailTitleWrap}>
                <span className={css.lineageDetailTitle}>血缘分析</span>
                <div className={css.lineageDetailBadges}>
                  <span className={css.lineageBadgeSecondary}>{health.nodeCount} 节点</span>
                  <span className={css.lineageBadgeSecondary}>{health.edgeCount} 关系</span>
                  <span className={css.lineageBadgeSecondary}>证据覆盖 {Math.round(health.evidenceCoverage * 100)}%</span>
                </div>
              </div>
              <button type="button" onClick={() => setAnalysisOpen(false)} className={css.lineageDetailClose} title={t('close')}>
                <IconCloseOutline16 size={14} />
              </button>
            </div>

            <div className={css.lineageDetailBody}>
              <div className={css.lineageDetailSection}>
                <div className={css.lineageDetailLabel}>健康体检</div>
                <div className={css.lineagePropertyRow}>
                  <span className={css.lineagePropertyKey}>孤立节点</span>
                  <span className={css.lineagePropertyValue}>{health.isolatedNodes}</span>
                </div>
                <div className={css.lineagePropertyRow}>
                  <span className={css.lineagePropertyKey}>待审核推断</span>
                  <span className={css.lineagePropertyValue}>{health.pendingReviews}</span>
                </div>
                <div className={css.lineagePropertyRow}>
                  <span className={css.lineagePropertyKey}>连通分量</span>
                  <span className={css.lineagePropertyValue}>{health.components}</span>
                </div>
                {health.issues.map((issue) => (
                  <div key={issue} className={css.lineageDetailText}>{issue}</div>
                ))}
              </div>

              {selected !== null && (
                <div className={css.lineageDetailSection}>
                  <div className={css.lineageDetailLabel}>当前节点血缘</div>
                  <div className={css.lineagePropertyRow}>
                    <span className={css.lineagePropertyKey}>上游</span>
                    <span className={css.lineagePropertyValue}>{trace?.upstream.length ?? 0}</span>
                  </div>
                  <div className={css.lineagePropertyRow}>
                    <span className={css.lineagePropertyKey}>下游</span>
                    <span className={css.lineagePropertyValue}>{trace?.downstream.length ?? 0}</span>
                  </div>
                </div>
              )}

              <div className={css.lineageDetailSection}>
                <div className={css.lineageDetailLabel}>路径查询</div>
                <div className={css.lineageAssetActions}>
                  <select className={css.lineageSelect} value={pathFromId} onChange={(event) => setPathFromId(event.target.value)}>
                    <option value="">起点</option>
                    {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
                  </select>
                  <select className={css.lineageSelect} value={pathToId} onChange={(event) => setPathToId(event.target.value)}>
                    <option value="">终点</option>
                    {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
                  </select>
                </div>
                {pathFromId !== '' && pathToId !== '' && (() => {
                  const paths = findLineagePaths(graph, pathFromId, pathToId)
                  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]))
                  return paths.length === 0
                    ? <div className={css.lineageDetailText}>未找到血缘路径</div>
                    : paths.map((path, index) => (
                      <div key={index} className={css.lineageDetailText}>
                        {path.nodeIds.map((id) => labels.get(id) ?? id).join(' → ')}
                      </div>
                    ))
                })()}
              </div>
            </div>
          </LineageDetailShell>
        )}
        {selectedEdge !== null && (
          <EdgeDetailPanel
            edge={selectedEdge}
            fromLabel={graph.nodes.find((node) => node.id === selectedEdge.from)?.label ?? selectedEdge.from}
            toLabel={graph.nodes.find((node) => node.id === selectedEdge.to)?.label ?? selectedEdge.to}
            onClose={() => setSelectedEdge(null)}
            onConfirm={(edge) => confirmReviewEdge(edge)}
            onReject={(edge) => rejectReviewEdge(edge)}
            onVerify={(edge) => verifyEdgeContainment(edge)}
            onUpdateEdge={updateSelectedEdge}
          />
        )}

        {/* Add node modal */}
        {editMode === 'addNode' && (
          <div className={css.lineageModalBackdrop} onClick={() => setEditMode('none')}>
            <div className={css.lineageModal} onClick={(e) => e.stopPropagation()}>
              <div className={css.lineageModalTitle}>{t('lineageAddNode')}</div>
              <div className={css.lineageModalBody}>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineageNodeName')}</span>
                  <input autoFocus value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder={t('lineageNodeNamePlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') confirmAddNode() }} />
                </label>
                <label className={css.lineageModalLabel}>
                  <span>层级</span>
                  <select value={addLayer} onChange={(e) => setAddLayer(e.target.value === 'instance' ? 'instance' : 'class')}>
                    <option value="class">类</option>
                    <option value="instance">实例</option>
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineageNodeType')}</span>
                  <select value={addType} onChange={(e) => setAddType(e.target.value)}>
                    {ONTOLOGY_NODE_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
                  </select>
                </label>
              </div>
              <div className={css.lineageModalFooter}>
                <button type="button" className={css.lineageToolbarButton} onClick={() => setEditMode('none')}>{t('cancel')}</button>
                <button type="button" className={css.lineagePrimaryButton} disabled={addLabel.trim() === ''} onClick={confirmAddNode}>{t('lineageConfirm')}</button>
              </div>
            </div>
          </div>
        )}

        {assetOpen && (
          <AssetWorkbench
            scope={scope}
            onClose={() => setAssetOpen(false)}
            onAccept={(incoming) => {
              mergeAssetGraph(incoming)
              setAssetOpen(false)
            }}
          />
        )}

        {reviewOpen && (
          <ReviewQueuePanel
            graph={graph}
            onClose={() => setReviewOpen(false)}
            reviews={reviews}
            onConfirm={(review) => setGraph(applyGovernanceReview(graph, review, 'confirmed'))}
            onReject={(review) => setGraph(applyGovernanceReview(graph, review, 'rejected'))}
            onConfirmMany={(selected) => setGraph(applyGovernanceReviews(graph, selected, 'confirmed'))}
            onRejectMany={(selected) => setGraph(applyGovernanceReviews(graph, selected, 'rejected'))}
          />
        )}

        {instanceOpen && (
          <div className={css.lineageModalBackdrop} onClick={() => setInstanceOpen(false)}>
            <div className={css.lineageModal} onClick={(e) => e.stopPropagation()}>
              <div className={css.lineageModalTitle}>{t('lineageImportInstances')}</div>
              <div className={css.lineageModalBody}>
                <label className={css.lineageModalLabel}>
                  <span>{t('databaseConnections')}</span>
                  <select value={instanceConnectionId} onChange={(e) => void loadInstanceConnection(e.target.value)}>
                    <option value="">{t('databaseTypeSearch')}</option>
                    {instanceConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('databaseDatabase')}</span>
                  <select value={instanceDatabase} onChange={(e) => void loadInstanceTables(e.target.value)} disabled={instanceConnectionId === ''}>
                    <option value="">{t('databaseTypeSearch')}</option>
                    {instanceDatabases.map((database) => <option key={database} value={database}>{database}</option>)}
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('databaseTables')}</span>
                  <select value={instanceTable} onChange={(e) => void loadInstanceColumns(e.target.value)} disabled={instanceDatabase === ''}>
                    <option value="">{t('databaseTypeSearch')}</option>
                    {instanceTables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineageTargetClass')}</span>
                  <select value={instanceTargetId} onChange={(e) => setInstanceTargetId(e.target.value)}>
                    <option value="">{t('databaseTypeSearch')}</option>
                    {graph.nodes.filter((node) => node.type === 'class').map((node) => (
                      <option key={node.id} value={node.id}>{node.label}</option>
                    ))}
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineagePrimaryKey')}</span>
                  <select value={instancePrimaryKey} onChange={(e) => setInstancePrimaryKey(e.target.value)} disabled={instanceTable === ''}>
                    <option value="">{t('databaseTypeSearch')}</option>
                    {instanceColumns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineageLabelColumn')}</span>
                  <select value={instanceLabelColumn} onChange={(e) => setInstanceLabelColumn(e.target.value)} disabled={instanceTable === ''}>
                    <option value="">{t('databaseTypeSearch')}</option>
                    {instanceColumns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineageInstanceLimit')}</span>
                  <select value={instanceLimit} onChange={(e) => setInstanceLimit(Number(e.target.value))}>
                    <option value={10}>10</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
              </div>
              <div className={css.lineageModalFooter}>
                <button type="button" className={css.lineageToolbarButton} onClick={() => setInstanceOpen(false)}>{t('cancel')}</button>
                <button
                  type="button"
                  className={css.lineagePrimaryButton}
                  disabled={instanceLoading || instanceConnectionId === '' || instanceDatabase === '' || instanceTable === '' || instanceTargetId === '' || instancePrimaryKey === ''}
                  onClick={() => void importInstances()}
                >
                  {instanceLoading ? t('loading') : t('lineageImport')}
                </button>
              </div>
            </div>
          </div>
        )}

        {editMode === 'connect' && connectSource !== null && connectTarget !== null && (
          <div className={css.lineageModalBackdrop} onClick={() => setConnectTarget(null)}>
            <div className={css.lineageModal} onClick={(e) => e.stopPropagation()}>
              <div className={css.lineageModalTitle}>{t('lineageConnect')}</div>
              <div className={css.lineageModalBody}>
                <div className={css.lineageConnectPreview}>
                  <span className={css.lineageConnectNode}>{graph.nodes.find((n) => n.id === connectSource)?.label ?? connectSource}</span>
                  <span className={css.lineageConnectArrow}>→</span>
                  <span className={css.lineageConnectNode}>{graph.nodes.find((n) => n.id === connectTarget)?.label ?? connectTarget}</span>
                </div>
                <label className={css.lineageModalLabel}>
                  <span>{t('lineageRelationType')}</span>
                  <select value={connectRelType} onChange={(e) => setConnectRelType(e.target.value)}>
                    {ONTOLOGY_RELATIONS.filter((relation) =>
                      (relation.domain === undefined || relation.domain.some((selector) => endpointMatchesLayer(graph.nodes.find((node) => node.id === connectSource), selector)))
                      && (relation.range === undefined || relation.range.some((selector) => endpointMatchesLayer(graph.nodes.find((node) => node.id === connectTarget), selector)))
                    ).map((relation) => <option key={relation.id} value={relation.id}>{relation.label}</option>)}
                  </select>
                </label>
              </div>
              <div className={css.lineageModalFooter}>
                <button type="button" className={css.lineageToolbarButton} onClick={() => setConnectTarget(null)}>{t('cancel')}</button>
                <button type="button" className={css.lineagePrimaryButton} onClick={confirmConnect}>{t('lineageConfirm')}</button>
              </div>
            </div>
          </div>
        )}

        {/* Connect mode hint */}
        {editMode === 'connect' && connectSource !== null && connectTarget === null && (
          <div className={css.lineageConnectHint}>{t('lineageConnectHint')}</div>
        )}
      </div>
    </div>
  )
}

function AssetWorkbench({ scope, onClose, onAccept }: {
  scope: SessionScope
  onClose: () => void
  onAccept: (graph: LineageGraphData) => void
}): ReactNode {
  const [loading, setLoading] = useState(true)
  const [assets, setAssets] = useState<string[]>([])
  const [selectedAssets, setSelectedAssets] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [parsed, setParsed] = useState<LineageGraphData | null>(null)
  const [parseErrors, setParseErrors] = useState<{ path: string; message: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [nodeSelection, setNodeSelection] = useState<string[]>([])
  const [edgeSelection, setEdgeSelection] = useState<string[]>([])
  const [ddlConnections, setDdlConnections] = useState<(DatabaseConnectionInput & { id: string; name: string })[]>([])
  const [ddlConnectionId, setDdlConnectionId] = useState('')
  const [ddlDatabases, setDdlDatabases] = useState<string[]>([])
  const [ddlDatabase, setDdlDatabase] = useState('')
  const [ddlTables, setDdlTables] = useState<DbObjectInfo[]>([])
  const [ddlTable, setDdlTable] = useState('')
  const [ddlLoading, setDdlLoading] = useState(false)
  const [ddlMessage, setDdlMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await api.lineageAssets(scope)
        if (!cancelled) {
          setAssets(result.assets)
          setSelectedAssets([])
          setTruncated(result.truncated)
        }
      } catch {
        if (!cancelled) setError(t('lineageLoadError'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const view = await api.settingsGet()
        const pluginSettings = (view.value as { pluginSettings?: Record<string, unknown> } | undefined)?.pluginSettings ?? {}
        const blob = pluginSettings.database as { connections?: unknown } | undefined
        const raw = Array.isArray(blob?.connections) ? blob!.connections : []
        const connections = raw
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .filter((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.host === 'string')
          .map((item) => ({
            ...item,
            engine: item.engine === 'postgresql' || item.engine === 'dm' ? item.engine : 'mysql',
            port: typeof item.port === 'number' ? item.port : 3306,
            user: typeof item.user === 'string' ? item.user : '',
            password: typeof item.password === 'string' ? item.password : '',
          })) as (DatabaseConnectionInput & { id: string; name: string })[]
        if (!cancelled) setDdlConnections(connections)
      } catch {
        if (!cancelled) setDdlConnections([])
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const loadDdlConnection = async (connectionId: string): Promise<void> => {
    setDdlConnectionId(connectionId)
    setDdlDatabases([])
    setDdlDatabase('')
    setDdlTables([])
    setDdlTable('')
    const connection = ddlConnections.find((item) => item.id === connectionId)
    if (connection === undefined) return
    setDdlLoading(true)
    try {
      const result = await api.dbDatabases(connection)
      setDdlDatabases(result.databases)
      if (result.databases.length === 1) setDdlDatabase(result.databases[0]!)
    } catch {
      setDdlMessage(t('databaseLoadError'))
    } finally {
      setDdlLoading(false)
    }
  }

  const loadDdlTables = async (database: string): Promise<void> => {
    setDdlDatabase(database)
    setDdlTables([])
    setDdlTable('')
    const connection = ddlConnections.find((item) => item.id === ddlConnectionId)
    if (connection === undefined || database === '') return
    setDdlLoading(true)
    try {
      const result = await api.dbObjects({ ...connection, database }, database, 'tables')
      setDdlTables(result.objects)
    } catch {
      setDdlMessage(t('databaseLoadError'))
    } finally {
      setDdlLoading(false)
    }
  }

  const extractDatabaseDdl = async (): Promise<void> => {
    const connection = ddlConnections.find((item) => item.id === ddlConnectionId)
    if (connection === undefined || ddlDatabase === '' || ddlTable === '') return
    setDdlLoading(true)
    setDdlMessage(null)
    try {
      const result = await api.dbDdl({ ...connection, database: ddlDatabase }, ddlDatabase, ddlTable)
      const source = `${connection.name}/${ddlDatabase}/${ddlTable}.sql`
      const parsedResult = await api.lineageExtractDdl(source, result.ddl)
      setParsed((current) => {
        const nodes = current === null ? parsedResult.graph.nodes : [...current.nodes, ...parsedResult.graph.nodes.filter((node) => !current.nodes.some((candidate) => candidate.id === node.id))]
        const edges = current === null ? parsedResult.graph.edges : [...current.edges, ...parsedResult.graph.edges.filter((edge) => !current.edges.some((candidate) => candidate.id === edge.id))]
        return { nodes, edges }
      })
      setNodeSelection((current) => [...current, ...parsedResult.graph.nodes.map((node) => node.id)])
      setEdgeSelection((current) => [...current, ...parsedResult.graph.edges.map((edge) => edge.id)])
      setDdlMessage(t('lineageDdlExtracted'))
    } catch {
      setDdlMessage(t('databaseLoadError'))
    } finally {
      setDdlLoading(false)
    }
  }

  const parseAssets = async (): Promise<void> => {
    if (selectedAssets.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.lineageExtractAssets(scope, selectedAssets)
      if (result.graph.nodes.length === 0 && result.graph.edges.length === 0) {
        setError(t('lineageNoCandidates'))
      }
      setParsed(result.graph)
      setParseErrors(result.errors)
      setNodeSelection(result.graph.nodes.map((node) => node.id))
      setEdgeSelection(result.graph.edges.map((edge) => edge.id))
    } catch {
      setError(t('lineageLoadError'))
    } finally {
      setLoading(false)
    }
  }

  const accept = (): void => {
    if (parsed === null) return
    const reviewedAt = new Date().toISOString()
    const nodeIds = new Set(nodeSelection)
    const edgeIds = new Set(edgeSelection)
    const selectedNodes = parsed.nodes.filter((node) => nodeIds.has(node.id)).map((node) => ({
      ...node,
      properties: { ...node.properties, reviewStatus: 'confirmed', reviewedAt },
    }))
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.id))
    const selectedEdges = parsed.edges.filter((edge) =>
      edgeIds.has(edge.id) && selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)).map((edge) => ({
      ...edge,
      properties: { ...edge.properties, reviewStatus: 'confirmed', reviewedAt },
    }))
    onAccept({ nodes: selectedNodes, edges: selectedEdges })
  }

  return (
    <LineageDetailShell>
      <div className={css.lineageDetailHeader}>
        <div className={css.lineageDetailTitleWrap}>
          <span className={css.lineageDetailTitle}>{t('lineageAssetExtract')}</span>
          <div className={css.lineageDetailBadges}>
            <span className={css.lineageBadgeSecondary}>{assets.length} 资料文件</span>
            {parsed !== null && <span className={css.lineageBadgeSecondary}>{parsed.nodes.length} 候选节点</span>}
            {parsed !== null && <span className={css.lineageBadgeSecondary}>{parsed.edges.length} 候选关系</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} className={css.lineageDetailClose} title={t('close')}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>
      <div className={css.lineageDetailBody}>
        {error !== null && <div className={css.lineageDetailText}>{error}</div>}
        <div className={css.lineageAssetColumns}>
          <div className={css.lineageAssetPanel}>
            <div className={css.lineageDetailLabel}>{t('lineageDatabaseDdl')}</div>
            <label className={css.lineageModalLabel}>
              <span>{t('databaseConnections')}</span>
              <select value={ddlConnectionId} onChange={(e) => void loadDdlConnection(e.target.value)}>
                <option value="">{t('databaseTypeSearch')}</option>
                {ddlConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
              </select>
            </label>
            <label className={css.lineageModalLabel}>
              <span>{t('databaseDatabase')}</span>
              <select value={ddlDatabase} onChange={(e) => void loadDdlTables(e.target.value)} disabled={ddlConnectionId === ''}>
                <option value="">{t('databaseTypeSearch')}</option>
                {ddlDatabases.map((database) => <option key={database} value={database}>{database}</option>)}
              </select>
            </label>
            <label className={css.lineageModalLabel}>
              <span>{t('databaseTables')}</span>
              <select value={ddlTable} onChange={(e) => setDdlTable(e.target.value)} disabled={ddlDatabase === ''}>
                <option value="">{t('databaseTypeSearch')}</option>
                {ddlTables.map((table) => <option key={table.name} value={table.name}>{table.name}{table.comment !== '' ? ` · ${table.comment}` : ''}</option>)}
              </select>
            </label>
            <button
              type="button"
              className={css.lineagePrimaryButton}
              disabled={ddlLoading || ddlConnectionId === '' || ddlDatabase === '' || ddlTable === ''}
              onClick={() => void extractDatabaseDdl()}
            >
              {ddlLoading ? t('loading') : t('lineageExtractDdl')}
            </button>
            {ddlMessage !== null && <div className={css.lineageModalHint}>{ddlMessage}</div>}

            <div className={css.lineageDetailLabel}>选择资料</div>
            <div className={css.lineageAssetList}>
              {loading && <div className={css.lineageDetailText}>{t('loading')}</div>}
              {!loading && assets.length === 0 && <div className={css.lineageDetailText}>{t('lineageNoAssets')}</div>}
              {assets.map((path) => (
                <label key={path} className={css.lineageAssetRow} title={path}>
                  <input
                    type="checkbox"
                    checked={selectedAssets.includes(path)}
                    onChange={(e) => setSelectedAssets((current) => e.target.checked
                      ? [...current, path]
                      : current.filter((candidate) => candidate !== path))}
                  />
                  <span>{path}</span>
                </label>
              ))}
            </div>
            {truncated && <div className={css.lineageModalHint}>资料较多，仅显示前 200 个</div>}
            <button
              type="button"
              className={css.lineagePrimaryButton}
              disabled={loading || selectedAssets.length === 0}
              onClick={() => void parseAssets()}
            >
              {loading ? t('loading') : t('lineageParse')}
            </button>
          </div>
          <div className={css.lineageAssetPanel}>
            <div className={css.lineageDetailLabel}>候选本体</div>
            <div className={css.lineageAssetList}>
              {parsed === null && <div className={css.lineageDetailText}>先解析资料，再确认候选节点和关系。</div>}
              {parsed !== null && parsed.nodes.length === 0 && <div className={css.lineageDetailText}>{t('lineageNoCandidates')}</div>}
              {parsed?.nodes.map((candidate) => {
                const def = nodeTypeDef(candidate.type)
                return (
                  <label key={candidate.id} className={css.lineageAssetRow}>
                    <input
                      type="checkbox"
                      checked={nodeSelection.includes(candidate.id)}
                      onChange={(e) => setNodeSelection((current) => e.target.checked
                        ? [...current, candidate.id]
                        : current.filter((id) => id !== candidate.id))}
                    />
                    <span className={css.lineageAssetCandidate}>
                      <span className={css.lineageBadge} style={{ background: def?.bg, color: def?.color }}>{def?.label ?? candidate.type}</span>
                      <strong>{candidate.label}</strong>
                      {candidate.properties?.description !== undefined && <small>{String(candidate.properties.description)}</small>}
                    </span>
                  </label>
                )
              })}
              {parsed?.edges.map((candidate) => {
                const fromLabel = parsed.nodes.find((node) => node.id === candidate.from)?.label ?? candidate.from
                const toLabel = parsed.nodes.find((node) => node.id === candidate.to)?.label ?? candidate.to
                const relation = relationDef(candidate.rel_type)?.label ?? candidate.label ?? candidate.rel_type ?? '关系'
                return (
                  <label key={candidate.id} className={css.lineageAssetRow}>
                    <input
                      type="checkbox"
                      checked={edgeSelection.includes(candidate.id)}
                      onChange={(e) => setEdgeSelection((current) => e.target.checked
                        ? [...current, candidate.id]
                        : current.filter((id) => id !== candidate.id))}
                    />
                    <span className={css.lineageAssetCandidate}>
                      <strong>{fromLabel}</strong>
                      <span className={css.lineageConnectArrow}>→</span>
                      <strong>{toLabel}</strong>
                      <small>{relation}{candidate.source !== undefined ? ` · ${candidate.source}` : ''}</small>
                    </span>
                  </label>
                )
              })}
            </div>
            {parseErrors.length > 0 && (
              <div className={css.lineageAssetErrors}>
                {parseErrors.map((item) => <div key={item.path}>{item.path}: {item.message}</div>)}
              </div>
            )}
            <button
              type="button"
              className={css.lineagePrimaryButton}
              disabled={parsed === null || (nodeSelection.length === 0 && edgeSelection.length === 0)}
              onClick={accept}
            >
              {t('lineageAcceptCandidates')}
            </button>
          </div>
        </div>
      </div>
    </LineageDetailShell>
  )
}

function ReviewQueuePanel({ reviews, graph, onClose, onConfirm, onReject, onConfirmMany, onRejectMany }: {
  graph: LineageGraphData
  onClose: () => void
  reviews: GovernanceReviewItem[]
  onConfirm: (review: GovernanceReviewItem) => void
  onReject: (review: GovernanceReviewItem) => void
  onConfirmMany: (reviews: GovernanceReviewItem[]) => void
  onRejectMany: (reviews: GovernanceReviewItem[]) => void
}): ReactNode {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedReviews = reviews.filter((review) => selectedIds.includes(review.id))
  const allSelected = reviews.length > 0 && selectedIds.length === reviews.length

  return (
    <LineageDetailShell>
      <div className={css.lineageDetailHeader}>
        <div className={css.lineageDetailTitleWrap}>
          <span className={css.lineageDetailTitle}>人工审核队列</span>
          <div className={css.lineageDetailBadges}>
            <span className={css.lineageBadgeSecondary}>{reviews.length} 项待确认</span>
            {selectedIds.length > 0 && <span className={css.lineageBadgeSecondary}>已选 {selectedIds.length}</span>}
          </div>
        </div>
        <div className={css.lineageAssetActions}>
          <button
            type="button"
            className={css.lineageToolbarButton}
            disabled={reviews.length === 0}
            onClick={() => setSelectedIds(allSelected ? [] : reviews.map((review) => review.id))}
          >
            {allSelected ? '清空选择' : '全选'}
          </button>
          <button
            type="button"
            className={css.lineageToolbarButton}
            disabled={selectedReviews.length === 0}
            onClick={() => onRejectMany(selectedReviews)}
          >
            批量否决
          </button>
          <button
            type="button"
            className={css.lineagePrimaryButton}
            disabled={selectedReviews.length === 0}
            onClick={() => onConfirmMany(selectedReviews)}
          >
            批量确认
          </button>
        </div>
        <button type="button" onClick={onClose} className={css.lineageDetailClose} title={t('close')}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>

      <div className={css.lineageDetailBody}>
        <div className={css.lineageAssetList}>
          {reviews.length === 0 && (
            <div className={css.lineageDetailText}>当前没有待审核的本体变更。</div>
          )}
          {reviews.map((review) => {
            return (
              <div key={review.id} className={css.lineageAssetRow}>
                <div className={css.lineageAssetCandidate}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(review.id)}
                    onChange={(event) => setSelectedIds((current) => event.target.checked
                      ? [...current, review.id]
                      : current.filter((id) => id !== review.id))}
                  />
                  <strong>{review.label}</strong>
                  <span className={css.lineageBadgeSecondary}>
                    {review.kind === 'relation' ? '关系' : review.kind === 'mapping' ? '映射' : '实例'}
                  </span>
                  <small>{review.detail}{review.confidence !== undefined ? ` · 置信度 ${review.confidence}` : ''}</small>
                </div>
                <div className={css.lineageModalFooter}>
                  <button type="button" className={css.lineageToolbarButton} onClick={() => onReject(review)}>
                    否决
                  </button>
                  <button type="button" className={css.lineagePrimaryButton} onClick={() => onConfirm(review)}>
                    确认
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </LineageDetailShell>
  )
}

function LineageDetailShell({ children }: { children: ReactNode }): ReactNode {
  const [height, setHeight] = useState<number | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startY: number; startHeight: number; maxHeight: number } | null>(null)

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const shell = shellRef.current
    if (!shell?.parentElement) return
    e.preventDefault()
    e.stopPropagation()
    const shellRect = shell.getBoundingClientRect()
    const parentRect = shell.parentElement.getBoundingClientRect()
    const maxHeight = Math.max(160, parentRect.height - 48)
    dragRef.current = { startY: e.clientY, startHeight: shellRect.height, maxHeight }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const next = Math.min(drag.maxHeight, Math.max(160, drag.startHeight + (drag.startY - e.clientY)))
    setHeight(next)
  }

  const onHandlePointerEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div
      ref={shellRef}
      className={css.lineageDetail}
      style={height === null ? undefined : { height, maxHeight: 'none' }}
    >
      <div
        className={css.lineageDetailHandle}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerEnd}
        onPointerCancel={onHandlePointerEnd}
      >
        <span className={css.lineageDetailHandleBar} />
      </div>
      {children}
    </div>
  )
}

function NodeDetailPanel({ node, graph, onSelectNode, onClose, onUpdateNode }: {
  node: LineageNode
  graph: LineageGraphData
  onSelectNode: (node: LineageNode) => void
  onClose: () => void
  onUpdateNode: (node: LineageNode) => void
}): ReactNode {
  const style = typeStyle(node.type)
  const source = SOURCE_COLORS[node.source || ''] ?? { bg: '#f1f5f9', color: '#64748b' }
  const sourceLabel = node.source || '未知'
  const [editing, setEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(node.label)
  const [editLayer, setEditLayer] = useState<'class' | 'instance'>(nodeLayer(node))
  const [editType, setEditType] = useState(node.type)
  const [editDomain, setEditDomain] = useState(node.domain ?? '')
  const [editDescription, setEditDescription] = useState(typeof node.properties?.description === 'string' ? node.properties.description : '')
  const [editAliases, setEditAliases] = useState(Array.isArray(node.properties?.aliases) ? (node.properties!.aliases as unknown[]).join(', ') : '')
  const [editUri, setEditUri] = useState(typeof node.properties?.uri === 'string' ? node.properties.uri : '')
  const [editIdentifierKey, setEditIdentifierKey] = useState(typeof node.properties?.identifierKey === 'string' ? node.properties.identifierKey : '')
  const [editDataType, setEditDataType] = useState(typeof node.properties?.dataType === 'string' ? node.properties.dataType : '')
  const [editRequired, setEditRequired] = useState(node.properties?.required === true || node.properties?.nullable === false)
  const [editUnique, setEditUnique] = useState(node.properties?.unique === true || node.properties?.primaryKey === true)
  const [mappingStrategy, setMappingStrategy] = useState('')
  const [mappingStrategyReason, setMappingStrategyReason] = useState('')
  const [mappingConnections, setMappingConnections] = useState<(DatabaseConnectionInput & { id: string; name: string })[]>([])
  const [mappingConnectionId, setMappingConnectionId] = useState('')
  const [mappingDatabases, setMappingDatabases] = useState<string[]>([])
  const [mappingDatabase, setMappingDatabase] = useState('')
  const [mappingTables, setMappingTables] = useState<DbObjectInfo[]>([])
  const [mappingTable, setMappingTable] = useState('')
  const [mappingColumns, setMappingColumns] = useState<DbColumnInfo[]>([])
  const [mappingColumnMatches, setMappingColumnMatches] = useState<Record<string, string>>({})
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingMessage, setMappingMessage] = useState<string | null>(null)
  const [driftMessages, setDriftMessages] = useState<Record<number, string>>({})
  const [detailTab, setDetailTab] = useState<NodeDetailTab>('overview')
  const detailBodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setEditing(false)
    setEditLabel(node.label)
    setEditLayer(nodeLayer(node))
    setEditType(node.type)
    setEditDomain(node.domain ?? '')
    setEditDescription(typeof node.properties?.description === 'string' ? node.properties.description : '')
    setEditAliases(Array.isArray(node.properties?.aliases) ? (node.properties!.aliases as unknown[]).join(', ') : '')
    setEditUri(typeof node.properties?.uri === 'string' ? node.properties.uri : '')
    setEditIdentifierKey(typeof node.properties?.identifierKey === 'string' ? node.properties.identifierKey : '')
    setEditDataType(typeof node.properties?.dataType === 'string' ? node.properties.dataType : '')
    setEditRequired(node.properties?.required === true || node.properties?.nullable === false)
    setEditUnique(node.properties?.unique === true || node.properties?.primaryKey === true)
    setMappingStrategy('')
    setMappingStrategyReason('')
    setMappingMessage(null)
    const binding = Array.isArray(node.properties?.sourceBindings)
      ? (node.properties!.sourceBindings as Array<Record<string, unknown>>)[0]
      : undefined
    if (typeof binding?.connectionId === 'string') {
      setMappingConnectionId(binding.connectionId)
      setMappingDatabase(typeof binding.database === 'string' ? binding.database : '')
      setMappingTable(typeof binding.objectName === 'string' ? binding.objectName : '')
      void loadMappingConnection(binding.connectionId)
    }
    setDetailTab('overview')
    detailBodyRef.current?.scrollTo({ top: 0 })
  }, [node.id])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const view = await api.settingsGet()
        const pluginSettings = (view.value as { pluginSettings?: Record<string, unknown> } | undefined)?.pluginSettings ?? {}
        const blob = pluginSettings.database as { connections?: unknown } | undefined
        const raw = Array.isArray(blob?.connections) ? blob!.connections : []
        const connections = raw
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .filter((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.host === 'string')
          .map((item) => ({
            ...item,
            engine: item.engine === 'postgresql' || item.engine === 'dm' ? item.engine : 'mysql',
            port: typeof item.port === 'number' ? item.port : 3306,
            user: typeof item.user === 'string' ? item.user : '',
            password: typeof item.password === 'string' ? item.password : '',
          })) as (DatabaseConnectionInput & { id: string; name: string })[]
        if (!cancelled) setMappingConnections(connections)
      } catch {
        if (!cancelled) setMappingConnections([])
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const loadMappingConnection = async (connectionId: string): Promise<void> => {
    setMappingConnectionId(connectionId)
    setMappingDatabases([])
    setMappingDatabase('')
    setMappingTables([])
    setMappingTable('')
    setMappingColumns([])
    setMappingColumnMatches({})
    const connection = mappingConnections.find((item) => item.id === connectionId)
    if (connection === undefined) return
    setMappingLoading(true)
    try {
      const result = await api.dbDatabases(connection)
      setMappingDatabases(result.databases)
      if (result.databases.length === 1) setMappingDatabase(result.databases[0]!)
    } catch {
      setMappingMessage(t('databaseLoadError'))
    } finally {
      setMappingLoading(false)
    }
  }

  const loadMappingTables = async (database: string): Promise<void> => {
    setMappingDatabase(database)
    setMappingTables([])
    setMappingTable('')
    setMappingColumns([])
    setMappingColumnMatches({})
    const connection = mappingConnections.find((item) => item.id === mappingConnectionId)
    if (connection === undefined || database === '') return
    setMappingLoading(true)
    try {
      const result = await api.dbObjects({ ...connection, database }, database, 'tables')
      setMappingTables(result.objects)
      if (typeof database === 'string') setMappingDatabase(database)
    } catch {
      setMappingMessage(t('databaseLoadError'))
    } finally {
      setMappingLoading(false)
    }
  }

  const loadMappingColumns = async (table: string): Promise<void> => {
    setMappingTable(table)
    setMappingColumns([])
    setMappingColumnMatches({})
    const connection = mappingConnections.find((item) => item.id === mappingConnectionId)
    if (connection === undefined || mappingDatabase === '' || table === '') return
    setMappingLoading(true)
    try {
      const result = await api.dbColumns({ ...connection, database: mappingDatabase }, mappingDatabase, table)
      const normalized = (value: string): string => value.trim().toLowerCase().replace(/[_\s-]/g, '')
      const attributes = graph.edges
        .filter((edge) => edge.to === node.id && edge.rel_type === 'attribute_of')
        .map((edge) => graph.nodes.find((candidate) => candidate.id === edge.from))
        .filter((candidate): candidate is LineageNode => candidate !== undefined)
      const matches: Record<string, string> = {}
      for (const attribute of attributes) {
        const key = attribute.label
        const expected = normalized(key)
        const matched = result.columns.find((column) =>
          normalized(column.name) === expected
          || normalized(column.comment) === expected
          || (column.comment !== '' && key !== '' && (column.comment.includes(key) || key.includes(column.comment))))
        if (matched !== undefined) matches[key] = matched.name
      }
      setMappingColumns(result.columns)
      setMappingColumnMatches(matches)
      const tableInfo = mappingTables.find((candidate) => candidate.name === table)
      if (tableInfo !== undefined) {
        const candidate = classifySourceMapping({
          name: tableInfo.name,
          type: tableInfo.type,
          comment: tableInfo.comment,
          columns: result.columns,
        }, graph, { classId: node.id })
        setMappingStrategy(candidate.strategy)
        setMappingStrategyReason(candidate.reason.join(' · '))
        setMappingColumnMatches((current) => {
          const suggested = suggestColumnMappings(
            attributes.map((attribute) => ({
              id: attribute.id,
              label: attribute.label,
              aliases: Array.isArray(attribute.properties?.aliases) ? (attribute.properties!.aliases as unknown[]).map(String) : [],
            })),
            result.columns,
          )
          const merged: Record<string, string> = { ...suggested }
          for (const [key, value] of Object.entries(current)) {
            if (value !== '') merged[key] = value
          }
          return merged
        })
      }
    } catch {
      setMappingMessage(t('databaseLoadError'))
    } finally {
      setMappingLoading(false)
    }
  }

  const autoMapDatabase = async (): Promise<void> => {
    let database = mappingDatabase
    const connection = mappingConnections.find((item) => item.id === mappingConnectionId)
    if (connection === undefined) return
    setMappingLoading(true)
    setMappingMessage(null)
    try {
      if (database === '') {
        const result = await api.dbDatabases(connection)
        setMappingDatabases(result.databases)
        database = result.databases[0] ?? ''
        setMappingDatabase(database)
      }
      if (database === '') return
      const result = await api.dbObjects({ ...connection, database }, database, 'tables')
      setMappingTables(result.objects)
      const label = node.label.trim().toLowerCase()
      const normalizedLabel = label.replace(/[_\s-]/g, '')
      const candidates = result.objects.map((table) => {
        const normalizedTable = table.name.toLowerCase().replace(/[_\s-]/g, '')
        let score = 0
        const reason: string[] = []
        if (normalizedTable === normalizedLabel) { score += 0.85; reason.push('表名一致') }
        else if (normalizedTable.includes(normalizedLabel) || normalizedLabel.includes(normalizedTable)) { score += 0.65; reason.push('表名近似') }
        if (table.comment !== '' && (table.comment.includes(node.label) || node.label.includes(table.comment))) { score += 0.2; reason.push('注释一致') }
        return { table, score, reason: reason.join(' · ') }
      }).sort((left, right) => right.score - left.score)
      const matched = candidates.find((candidate) => candidate.score >= 0.65)?.table
      if (matched === undefined) {
        setMappingMessage(t('lineageAutoMapNotFound'))
        return
      }
      setMappingTable(matched.name)
      setMappingMessage(`${t('lineageAutoMapMatched')}: ${matched.name}`)
      await loadMappingColumns(matched.name)
    } catch {
      setMappingMessage(t('databaseLoadError'))
    } finally {
      setMappingLoading(false)
    }
  }

  const saveOntologyEdit = (): void => {
    const properties = { ...(node.properties ?? {}) }
    if (editDescription.trim() === '') delete properties.description
    else properties.description = editDescription.trim()
    const aliases = editAliases.split(',').map((item) => item.trim()).filter((item) => item !== '')
    if (aliases.length === 0) delete properties.aliases
    else properties.aliases = aliases
    if (editUri.trim() === '') delete properties.uri
    else properties.uri = editUri.trim()
    if (editIdentifierKey.trim() === '') delete properties.identifierKey
    else properties.identifierKey = editIdentifierKey.trim()
    if (node.type === 'attribute') {
      if (editDataType.trim() === '') delete properties.dataType
      else properties.dataType = editDataType.trim()
      if (editRequired) properties.required = true
      else delete properties.required
      if (editUnique) properties.unique = true
      else delete properties.unique
    }
    onUpdateNode({ ...node, label: editLabel.trim() || node.label, layer: editLayer, type: editType, domain: editDomain.trim() === '' ? undefined : editDomain.trim(), properties })
    setEditing(false)
  }

  const saveMapping = (): void => {
    const connection = mappingConnections.find((item) => item.id === mappingConnectionId)
    if (connection === undefined || mappingDatabase === '' || mappingTable === '') return
    const bindings = Array.isArray(node.properties?.sourceBindings) ? node.properties!.sourceBindings as Array<Record<string, unknown>> : []
    const binding = {
      connectionId: connection.id,
      connectionName: connection.name,
      engine: connection.engine,
      database: mappingDatabase,
      objectKind: 'table',
      objectName: mappingTable,
      mappingStrategy: mappingStrategy === '' ? undefined : mappingStrategy,
      columnMappings: mappingColumnMatches,
      reviewStatus: 'pending',
      mappedAt: new Date().toISOString(),
    }
    const isDuplicate = bindings.some((item) =>
      item.connectionId === binding.connectionId
      && item.database === binding.database
      && item.objectName === binding.objectName)
    if (isDuplicate) {
      setMappingMessage('该表映射已存在')
      return
    }
    const next = { ...node, source: node.source ?? 'derived', properties: { ...node.properties, sourceBindings: [...bindings, {
      ...binding,
    }] } }
    onUpdateNode(next)
    setMappingMessage(t('databaseSaved'))
  }

  const checkSchemaDrift = async (binding: Record<string, unknown>, index: number): Promise<void> => {
    const connection = mappingConnections.find((item) => item.id === binding.connectionId)
    const database = String(binding.database ?? '')
    const objectName = String(binding.objectName ?? '')
    if (connection === undefined || database === '' || objectName === '') return
    setMappingLoading(true)
    try {
      const result = await api.dbColumns({ ...connection, database }, database, objectName)
      const existing = new Set(result.columns.map((column) => column.name))
      const mappings = (binding.columnMappings ?? {}) as Record<string, string>
      const missing = Object.values(mappings).filter((column) => column !== '' && !existing.has(column))
      setDriftMessages((current) => ({
        ...current,
        [index]: missing.length === 0
          ? `结构正常 · ${objectName}`
          : `${objectName} 漂移：缺失 ${missing.join('、')}`,
      }))
    } catch {
      setDriftMessages((current) => ({ ...current, [index]: `${objectName} 漂移检查失败` }))
    } finally {
      setMappingLoading(false)
    }
  }
  const properties = node.properties !== undefined && typeof node.properties === 'object' && node.properties !== null
    ? Object.entries(node.properties as Record<string, unknown>)
    : []
  const nodeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]))
  const impact = useMemo(() => analyzeLineageImpact(graph, new Set([node.id])), [graph, node.id])
  const outgoing = graph.edges
    .filter((edge) => edge.from === node.id)
    .map((edge) => ({ edge, neighbor: nodeById.get(edge.to) }))
    .filter((item): item is { edge: LineageEdge; neighbor: LineageNode } => item.neighbor !== undefined)
  const incoming = graph.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => ({ edge, neighbor: nodeById.get(edge.from) }))
    .filter((item): item is { edge: LineageEdge; neighbor: LineageNode } => item.neighbor !== undefined)

  // Ontology-aware property grouping: pull known semantic/governance/technical
  // fields from the properties blob into labeled sections; remaining keys go
  // to the generic properties section.
  const prop = (key: string): string | undefined => {
    const value = properties.find(([k]) => k === key)?.[1]
    if (value === undefined || value === null || value === '') return undefined
    return String(value)
  }
  const knownKeys = new Set([
    'description', 'uri', 'aliases', 'parentClass', 'equivalentTo',
    'schema', 'dataType', 'primaryKey', 'nullable',
    'owner', 'sensitivity', 'version', 'tags', 'updatedAt',
  ])
  const otherProperties = properties.filter(([key]) => !knownKeys.has(key))
  const ontologySections: { title: string; rows: [string, string][] }[] = []

  const semantic: [string, string][] = []
  const semanticFields: [string, string][] = [
    ['定义', 'description'],
    ['本体 URI', 'uri'],
    ['同义词', 'aliases'],
    ['父类', 'parentClass'],
    ['等价类', 'equivalentTo'],
  ]
  for (const [label, key] of semanticFields) {
    const value = prop(key)
    if (value !== undefined) semantic.push([label, value])
  }
  if (semantic.length > 0) ontologySections.push({ title: '本体语义', rows: semantic })

  const technical: [string, string][] = []
  const technicalFields: [string, string][] = [
    ['Schema', 'schema'],
    ['数据类型', 'dataType'],
    ['主键', 'primaryKey'],
    ['可空', 'nullable'],
  ]
  for (const [label, key] of technicalFields) {
    const value = prop(key)
    if (value !== undefined) technical.push([label, value])
  }
  if (technical.length > 0) ontologySections.push({ title: '技术属性', rows: technical })

  const governance: [string, string][] = []
  const governanceFields: [string, string][] = [
    ['负责人', 'owner'],
    ['敏感级别', 'sensitivity'],
    ['版本', 'version'],
    ['标签', 'tags'],
    ['更新时间', 'updatedAt'],
  ]
  for (const [label, key] of governanceFields) {
    const value = prop(key)
    if (value !== undefined) governance.push([label, value])
  }
  if (governance.length > 0) ontologySections.push({ title: '治理信息', rows: governance })

  // Blood lineage stats
  if (incoming.length > 0 || outgoing.length > 0) {
    ontologySections.push({
      title: '血缘统计',
      rows: [
        ['上游依赖', String(incoming.length)],
        ['下游影响', String(outgoing.length)],
      ],
    })
  }

  const ontologyReasoning = useMemo(() => reasonOntology(graph, node.id), [graph, node.id])
  const ontologyProfile = useMemo(() => extractOntologyProfile(graph), [graph])
  const instanceQuality = useMemo(() => validateInstances(graph, ontologyProfile), [graph, ontologyProfile])
  const inheritanceChain = ontologyReasoning?.ancestors ?? []
  const equivalentClasses = ontologyReasoning?.equivalentClasses ?? []
  const effectiveAttributes = ontologyReasoning?.effectiveAttributes ?? []
  const classConstraints = ontologyProfile.constraints.filter((constraint) =>
    constraint.classId === node.id || constraint.attributeId === node.id
    || effectiveAttributes.some((attribute) => attribute.id === constraint.attributeId))
  const parentAttributes = (ontologyReasoning?.inheritedAttributes ?? []).reduce<{
    parent: LineageNode
    attributes: { id: string; label: string }[]
  }[]>((groups, inherited) => {
    const parent = nodeById.get(inherited.fromClassId)
    if (parent === undefined) return groups
    const group = groups.find((candidate) => candidate.parent.id === parent.id)
    const row = group ?? { parent, attributes: [] }
    if (!row.attributes.some((attribute) => attribute.id === inherited.attribute.id)) {
      row.attributes.push({ id: inherited.attribute.id, label: inherited.attribute.label })
    }
    if (group === undefined) groups.push(row)
    return groups
  }, [])

  const sourceBindings = Array.isArray(node.properties?.sourceBindings)
    ? node.properties!.sourceBindings as Array<Record<string, unknown>>
    : []

  const relatedRow = (edge: LineageEdge, neighbor: LineageNode, direction: 'in' | 'out'): ReactNode => (
    <button
      type="button"
      key={`${direction}-${edge.id}-${neighbor.id}`}
      className={css.lineageRelatedNode}
      onClick={() => onSelectNode(neighbor)}
    >
      <span className={css.lineageRelationDirection}>{direction === 'out' ? '→' : '←'}</span>
      <span className={css.lineageRelatedMarker} style={{ background: typeStyle(neighbor.type).color }} />
      <span className={css.lineageRelatedNodeName}>{neighbor.label}</span>
      <span className={css.lineageRelatedNodeType}>{typeStyle(neighbor.type).label}</span>
      <span className={css.lineageRelationType} title={relationDef(edge.rel_type)?.description}>{relationDef(edge.rel_type)?.label ?? edge.label ?? '—'}</span>
    </button>
  )

  return (
    <LineageDetailShell>
      <div className={css.lineageDetailHeader}>
        <div className={css.lineageDetailTitleWrap}>
          <span className={css.lineageDetailTitle}>{node.label}</span>
          <div className={css.lineageDetailBadges}>
            <span className={css.lineageBadge} style={{ background: style.bg, color: style.color }}>{style.label}</span>
            {node.domain !== undefined && <span className={css.lineageBadgeSecondary}>{node.domain}</span>}
            <span className={css.lineageBadgeSecondary} style={{ background: source.bg, color: source.color }}>{sourceLabel}</span>
          </div>
        </div>
        <button type='button' onClick={onClose} className={css.lineageDetailClose} title={t('close')}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>

      <div className={css.lineageDetailTabs} role="tablist" aria-label="节点详情视图">
        {NODE_DETAIL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={detailTab === tab.id}
            className={detailTab === tab.id ? css.lineageDetailTabActive : css.lineageDetailTab}
            onClick={() => {
              setDetailTab(tab.id)
              detailBodyRef.current?.scrollTo({ top: 0 })
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 本体与数据源映射设置 */}
      <div className={css.lineageDetailBody} style={detailTab === 'inference' ? { display: 'none' } : undefined}>
        {detailTab === 'overview' && (
        <div className={css.lineageDetailSection}>
          <div className={css.lineageDetailLabel}>{t('lineageOntologyEditor')}</div>
          {!editing ? (
            <>
              <div className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{t('lineageNodeName')}</span>
                <span className={css.lineagePropertyValue}>{node.label}</span>
              </div>
              <div className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{t('lineageNodeType')}</span>
                <span className={css.lineagePropertyValue}>{style.label}</span>
              </div>
              <div className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>层级</span>
                <span className={css.lineagePropertyValue}>{nodeLayer(node) === 'class' ? '类' : '实例'}</span>
              </div>
              <div className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>领域</span>
                <span className={css.lineagePropertyValue}>{node.domain ?? '—'}</span>
              </div>
              <div className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{t('lineageDetailDescription')}</span>
                <span className={css.lineagePropertyValue}>{typeof node.properties?.description === 'string' ? node.properties.description : '—'}</span>
              </div>
              <button type="button" className={css.lineageToolbarButton} onClick={() => setEditing(true)}>{t('edit')}</button>
            </>
          ) : (
            <>
              <label className={css.lineageModalLabel}>
                <span>{t('lineageNodeName')}</span>
                <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
              </label>
              <label className={css.lineageModalLabel}>
                <span>层级</span>
                <select value={editLayer} onChange={(e) => setEditLayer(e.target.value === 'instance' ? 'instance' : 'class')}>
                  <option value="class">类</option>
                  <option value="instance">实例</option>
                </select>
              </label>
              <label className={css.lineageModalLabel}>
                <span>{t('lineageNodeType')}</span>
                <select value={editType} onChange={(e) => setEditType(e.target.value)}>
                  {ONTOLOGY_NODE_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
                </select>
              </label>
              <label className={css.lineageModalLabel}>
                <span>领域</span>
                <input value={editDomain} onChange={(e) => setEditDomain(e.target.value)} />
              </label>
              <label className={css.lineageModalLabel}>
                <span>{t('lineageDetailDescription')}</span>
                <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
              </label>
              <label className={css.lineageModalLabel}>
                <span>同义词</span>
                <input value={editAliases} onChange={(e) => setEditAliases(e.target.value)} placeholder="别名 A, 别名 B" />
              </label>
              <label className={css.lineageModalLabel}>
                <span>本体 URI</span>
                <input value={editUri} onChange={(e) => setEditUri(e.target.value)} />
              </label>
              {nodeLayer(node) === 'class' && (
                <label className={css.lineageModalLabel}>
                  <span>业务键</span>
                  <input value={editIdentifierKey} onChange={(e) => setEditIdentifierKey(e.target.value)} />
                </label>
              )}
              {node.type === 'attribute' && (
                <>
                  <label className={css.lineageModalLabel}>
                    <span>数据类型</span>
                    <input value={editDataType} onChange={(e) => setEditDataType(e.target.value)} />
                  </label>
                  <label className={css.lineageModalLabel}>
                    <span>约束</span>
                    <span style={{ display: 'flex', gap: 10 }}>
                      <label><input type="checkbox" checked={editRequired} onChange={(e) => setEditRequired(e.target.checked)} /> 必填</label>
                      <label><input type="checkbox" checked={editUnique} onChange={(e) => setEditUnique(e.target.checked)} /> 唯一</label>
                    </span>
                  </label>
                </>
              )}
              <div className={css.lineageAssetActions}>
                <button type="button" className={css.lineageToolbarButton} onClick={() => setEditing(false)}>{t('cancel')}</button>
                <button type="button" className={css.lineagePrimaryButton} onClick={saveOntologyEdit}>{t('save')}</button>
              </div>
            </>
          )}
        </div>
        )}

        {detailTab === 'mapping' && (
        <div className={css.lineageDetailSection}>
          <div className={css.lineageDetailLabel}>{t('lineageDatabaseMapping')}</div>
          <label className={css.lineageModalLabel}>
            <span>{t('databaseConnections')}</span>
            <select value={mappingConnectionId} onChange={(e) => void loadMappingConnection(e.target.value)}>
              <option value="">{t('databaseTypeSearch')}</option>
              {mappingConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
            </select>
          </label>
          <label className={css.lineageModalLabel}>
            <span>{t('databaseDatabase')}</span>
            <select value={mappingDatabase} onChange={(e) => void loadMappingTables(e.target.value)} disabled={mappingConnectionId === ''}>
              <option value="">{t('databaseTypeSearch')}</option>
              {mappingDatabases.map((database) => <option key={database} value={database}>{database}</option>)}
            </select>
          </label>
          <div className={css.lineageAssetActions}>
            <button
              type="button"
              className={css.lineagePrimaryButton}
              disabled={mappingLoading || mappingConnectionId === ''}
              onClick={() => void autoMapDatabase()}
            >
              {t('lineageAutoMap')}
            </button>
          </div>
          <label className={css.lineageModalLabel}>
            <span>{t('databaseTables')}</span>
            <select value={mappingTable} onChange={(e) => void loadMappingColumns(e.target.value)} disabled={mappingDatabase === ''}>
              <option value="">{t('databaseTypeSearch')}</option>
              {mappingTables.map((table) => <option key={table.name} value={table.name}>{table.name}{table.comment !== '' ? ` · ${table.comment}` : ''}</option>)}
            </select>
          </label>
          {mappingMessage !== null && <div className={css.lineageModalHint}>{mappingMessage}</div>}
          {mappingStrategy !== '' && (
            <div className={css.lineageModalHint}>
              映射策略：{mappingStrategy}
              {mappingStrategyReason !== '' ? ` · ${mappingStrategyReason}` : ''}
            </div>
          )}
          {mappingColumns.length > 0 && (
            <div className={css.lineageDetailSection}>
              <div className={css.lineageDetailLabel}>列映射</div>
              {graph.edges.filter((edge) => edge.to === node.id && edge.rel_type === 'attribute_of').map((edge) => {
                const attribute = graph.nodes.find((candidate) => candidate.id === edge.from)
                if (attribute === undefined) return null
                return (
                  <label key={edge.id} className={css.lineageModalLabel}>
                    <span>{attribute.label}</span>
                    <select
                      value={mappingColumnMatches[attribute.label] ?? ''}
                      onChange={(event) => setMappingColumnMatches((current) => ({
                        ...current,
                        [attribute.label]: event.target.value,
                      }))}
                    >
                      <option value="">未映射</option>
                      {mappingColumns.map((column) => (
                        <option key={column.name} value={column.name}>{column.name} · {column.dataType}</option>
                      ))}
                    </select>
                  </label>
                )
              })}
            </div>
          )}
          <button
            type="button"
            className={css.lineagePrimaryButton}
            disabled={mappingLoading || mappingConnectionId === '' || mappingDatabase === '' || mappingTable === ''}
            onClick={saveMapping}
          >
            {t('databaseSave')}
          </button>
          {sourceBindings.length > 0 && (
            <div className={css.lineageAssetErrors}>
              {sourceBindings.map((binding, index) => (
                <div key={index}>
                  {String(binding.connectionName ?? binding.connectionId ?? '')} · {String(binding.database ?? '')} · {String(binding.objectName ?? '')}
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      <div ref={detailBodyRef} className={css.lineageDetailBody} style={detailTab === 'mapping' ? { display: 'none' } : undefined}>
        {/* 含义（description） */}
        {detailTab === 'overview' && prop('description') !== undefined && (
          <div className={css.lineageDetailDescription}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailDescription')}</div>
            <div className={css.lineageDetailText}>{prop('description')}</div>
          </div>
        )}

        {/* 本体推理 */}
        {detailTab === 'inference' && (inheritanceChain.length > 0 || equivalentClasses.length > 0) && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>本体推理</div>
            {inheritanceChain.length > 0 && (
              <div className={css.lineageInheritanceChain}>
                <span className={css.lineageInheritanceLabel}>继承链</span>
                {inheritanceChain.map((parent) => (
                  <button key={parent.id} type="button" className={css.lineageRelatedNode} onClick={() => onSelectNode(parent)}>
                    <span className={css.lineageRelatedNodeName}>{parent.label}</span>
                  </button>
                ))}
              </div>
            )}
            {equivalentClasses.length > 0 && (
              <div className={css.lineageInheritanceChain}>
                <span className={css.lineageInheritanceLabel}>等价类</span>
                {equivalentClasses.map((eq) => (
                  <button key={eq.id} type="button" className={css.lineageRelatedNode} onClick={() => onSelectNode(eq)}>
                    <span className={css.lineageRelatedNodeName}>{eq.label}</span>
                  </button>
                ))}
              </div>
            )}
            {parentAttributes.map(({ parent, attributes }) => (
              attributes.length > 0 && (
                <div key={parent.id} className={css.lineageParentAttributes}>
                  <span className={css.lineageInheritanceLabel}>{parent.label} 的属性</span>
                  {attributes.map((attr) => (
                    <span key={attr.id} className={css.lineageParentAttribute}>{attr.label}</span>
                  ))}
                </div>
              )
            ))}
          </div>
        )}

        {detailTab === 'inference' && effectiveAttributes.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>有效属性</div>
            {effectiveAttributes.map((attribute) => (
              <button
                key={attribute.id}
                type="button"
                className={css.lineageRelatedNode}
                onClick={() => {
                  const target = graph.nodes.find((candidate) => candidate.id === attribute.id)
                  if (target !== undefined) onSelectNode(target)
                }}
              >
                <span className={css.lineageRelatedNodeName}>{attribute.label}</span>
                <span className={css.lineageRelationType}>
                  {[attribute.dataType, attribute.required ? '必填' : '', attribute.unique ? '唯一' : '', attribute.identifier ? '标识' : ''].filter(Boolean).join(' · ') || '约束未定义'}
                </span>
              </button>
            ))}
          </div>
        )}

        {detailTab === 'inference' && classConstraints.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>机器可读约束</div>
            {classConstraints.map((constraint) => (
              <div key={constraint.id} className={css.lineageDetailText}>{constraint.label}</div>
            ))}
          </div>
        )}

        {detailTab === 'inference' && instanceQuality.classes.filter((report) => report.classId === node.id || report.instanceCount > 0).length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>数据接入质量</div>
            {instanceQuality.classes
              .filter((report) => report.classId === node.id || report.instanceCount > 0)
              .slice(0, 8)
              .map((report) => (
                <div key={report.classId} className={css.lineageDetailText}>
                  {report.classLabel}: {report.instanceCount} 实例 · 覆盖率 {(report.coverage * 100).toFixed(0)}%
                  {report.duplicateCount > 0 ? ` · 重复 ${report.duplicateCount}` : ''}
                  {report.requiredMissingCount > 0 ? ` · 必填缺失 ${report.requiredMissingCount}` : ''}
                  {report.relationMissingCount > 0 ? ` · 关系缺失 ${report.relationMissingCount}` : ''}
                </div>
              ))}
            {instanceQuality.classes
              .filter((report) => report.classId === node.id || report.instanceCount > 0)
              .flatMap((report) => report.issues.slice(0, 3).map((issue) => `${report.classLabel}: ${issue.message}`))
              .slice(0, 8)
              .map((message) => <div key={message} className={css.lineageModalHint}>{message}</div>)}
          </div>
        )}

        {detailTab === 'inference' && (ontologyReasoning?.modelGaps.length ?? 0) > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>建模缺口</div>
            {ontologyReasoning?.modelGaps.map((gap) => (
              <div key={gap} className={css.lineageDetailText}>{gap}</div>
            ))}
          </div>
        )}
        {/* 技术属性 */}
        {detailTab === 'mapping' && sourceBindings.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>数据源映射</div>
            {sourceBindings.map((binding, index) => (
              <div key={index}>
                <div className={css.lineagePropertyRow}>
                  <span className={css.lineagePropertyKey}>
                    {String(binding.connectionName ?? binding.connectionId ?? '数据库')} · {String(binding.database ?? '')}
                  </span>
                  <span className={css.lineagePropertyValue}>{String(binding.objectName ?? '')}</span>
                </div>
                <div className={css.lineageAssetActions}>
                  <button
                    type="button"
                    className={css.lineageToolbarButton}
                    disabled={mappingLoading}
                    onClick={() => void checkSchemaDrift(binding, index)}
                  >
                    检查漂移
                  </button>
                </div>
                {driftMessages[index] !== undefined && (
                  <div className={css.lineageModalHint}>{driftMessages[index]}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {detailTab === 'mapping' && technical.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailTechnical')}</div>
            {technical.map(([key, value]) => (
              <div key={key} className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{key}</span>
                <span className={css.lineagePropertyValue}>{value}</span>
              </div>
            ))}
          </div>
        )}

        {/* 治理信息 */}
        {detailTab === 'mapping' && governance.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailGovernance')}</div>
            {governance.map(([key, value]) => (
              <div key={key} className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{key}</span>
                <span className={css.lineagePropertyValue}>{value}</span>
              </div>
            ))}
          </div>
        )}

        {/* 本体语义（除 description 外的） */}
        {detailTab === 'mapping' && semantic.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailSemantic')}</div>
            {semantic.map(([key, value]) => (
              <div key={key} className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{key}</span>
                <span className={css.lineagePropertyValue}>{value}</span>
              </div>
            ))}
          </div>
        )}

        {/* 上下节点 */}
        {detailTab === 'overview' && (
        <div className={css.lineageDetailSection}>
          <div className={css.lineageDetailLabel}>{t('lineageNodeRelated')}</div>
          {incoming.length === 0 && outgoing.length === 0 && (
            <div className={css.lineageDetailText}>—</div>
          )}
          {incoming.length > 0 && (
            <div className={css.lineageRelationGroup}>
              <div className={css.lineageRelationGroupLabel}>{t('lineageNodeIncoming')} <span className={css.lineageRelationCount}>{incoming.length}</span></div>
              {incoming.map(({ edge, neighbor }) => relatedRow(edge, neighbor, 'in'))}
            </div>
          )}
          {outgoing.length > 0 && (
            <div className={css.lineageRelationGroup}>
              <div className={css.lineageRelationGroupLabel}>{t('lineageNodeOutgoing')} <span className={css.lineageRelationCount}>{outgoing.length}</span></div>
          {outgoing.map(({ edge, neighbor }) => relatedRow(edge, neighbor, 'out'))}
            </div>
          )}
        </div>
        )}
        {detailTab === 'overview' && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>删除影响</div>
            <div className={css.lineagePropertyRow}>
              <span className={css.lineagePropertyKey}>断开关系</span>
              <span className={css.lineagePropertyValue}>{impact.removedEdges.length}</span>
            </div>
            <div className={css.lineagePropertyRow}>
              <span className={css.lineagePropertyKey}>孤立节点</span>
              <span className={css.lineagePropertyValue}>{impact.orphanedNodes.filter((id) => id !== node.id).length}</span>
            </div>
            <div className={css.lineagePropertyRow}>
              <span className={css.lineagePropertyKey}>上游影响</span>
              <span className={css.lineagePropertyValue}>{impact.upstreamNodes.length}</span>
            </div>
            <div className={css.lineagePropertyRow}>
              <span className={css.lineagePropertyKey}>下游影响</span>
              <span className={css.lineagePropertyValue}>{impact.downstreamNodes.length}</span>
            </div>
            <div className={css.lineagePropertyRow}>
              <span className={css.lineagePropertyKey}>剩余分量</span>
              <span className={css.lineagePropertyValue}>{impact.disconnectedComponents}</span>
            </div>
          </div>
        )}

        {/* 证据 */}
        {detailTab === 'overview' && evidenceTexts(node).length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailEvidence')}</div>
            {evidenceTexts(node).map((evidence, index) => (
              <div key={index} className={css.lineageDetailText}>{evidence}</div>
            ))}
          </div>
        )}

        {/* 通用属性 */}
        {detailTab === 'overview' && otherProperties.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailProperties')}</div>
            {otherProperties.map(([key, value]) => (
              <div key={key} className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{key}</span>
                <span className={css.lineagePropertyValue}>{String(value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </LineageDetailShell>
  )
}

function EdgeDetailPanel({ edge, fromLabel, toLabel, onClose, onConfirm, onReject, onVerify, onUpdateEdge }: {
  edge: LineageEdge
  fromLabel: string
  toLabel: string
  onClose: () => void
  onConfirm: (edge: LineageEdge) => void
  onReject: (edge: LineageEdge) => void
  onVerify: (edge: LineageEdge) => Promise<{ ok: boolean; message: string }>
  onUpdateEdge: (edge: LineageEdge) => void
}): ReactNode {
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editRelation, setEditRelation] = useState(edge.rel_type ?? '')
  const [editLabel, setEditLabel] = useState(edge.label ?? '')
  const [editRequired, setEditRequired] = useState(edge.properties?.required === true)
  const [editMinCardinality, setEditMinCardinality] = useState(typeof edge.properties?.minCardinality === 'number' ? String(edge.properties.minCardinality) : '')
  const [editMaxCardinality, setEditMaxCardinality] = useState(typeof edge.properties?.maxCardinality === 'number' ? String(edge.properties.maxCardinality) : '')
  useEffect(() => {
    setEditing(false)
    setEditRelation(edge.rel_type ?? '')
    setEditLabel(edge.label ?? '')
    setEditRequired(edge.properties?.required === true)
    setEditMinCardinality(typeof edge.properties?.minCardinality === 'number' ? String(edge.properties.minCardinality) : '')
    setEditMaxCardinality(typeof edge.properties?.maxCardinality === 'number' ? String(edge.properties.maxCardinality) : '')
  }, [edge.id])
  const source = SOURCE_COLORS[edge.source || ''] ?? { bg: '#f1f5f9', color: '#64748b' }
  const sourceLabel = edge.source || '未知'
  const relation = edge.rel_type || edge.label || '—'
  const known = new Set(['id', 'from', 'to', 'label', 'source', 'rel_type', 'evidence', 'evidences', 'confidence'])
  const properties = [
    ...(edge.confidence !== undefined ? [['confidence', edge.confidence] as const] : []),
    ...Object.entries(edge as Record<string, unknown>)
      .filter(([key, value]) => !known.has(key) && value !== undefined),
  ]

  return (
    <LineageDetailShell>
      <div className={css.lineageDetailHeader}>
        <div className={css.lineageDetailTitleWrap}>
          <span className={css.lineageDetailTitle}>{fromLabel} → {toLabel}</span>
          <div className={css.lineageDetailBadges}>
            <span className={css.lineageBadge} style={{ background: source.bg, color: source.color }}>{sourceLabel}</span>
            <span className={css.lineageBadge} style={{ background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)' }}>{relation}</span>
            {edge.properties?.reviewStatus !== undefined && (
              <span className={css.lineageBadgeSecondary}>{String(edge.properties.reviewStatus)}</span>
            )}
          </div>
        </div>
        <button type="button" onClick={onClose} className={css.lineageDetailClose} title={t('close')}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>

      <div className={css.lineageDetailBody}>
        <div className={css.lineageDetailSection}>
          <div className={css.lineageDetailLabel}>关系定义</div>
          <div className={css.lineagePropertyRow}>
            <span className={css.lineagePropertyKey}>起点</span>
            <span className={css.lineagePropertyValue}>{fromLabel}</span>
          </div>
          <div className={css.lineagePropertyRow}>
            <span className={css.lineagePropertyKey}>终点</span>
            <span className={css.lineagePropertyValue}>{toLabel}</span>
          </div>
          <div className={css.lineagePropertyRow}>
            <span className={css.lineagePropertyKey}>语义类型</span>
            <span className={css.lineagePropertyValue}>
              {edge.rel_type !== undefined ? `${relationDef(edge.rel_type)?.label ?? edge.rel_type} · ${edge.rel_type}` : '未指定'}
            </span>
          </div>
          <div className={css.lineagePropertyRow}>
            <span className={css.lineagePropertyKey}>显示名称</span>
            <span className={css.lineagePropertyValue}>{edge.label ?? '—'}</span>
          </div>
          {relationDef(edge.rel_type) !== undefined && (
            <div className={css.lineageDetailText}>{relationDef(edge.rel_type)?.description}</div>
          )}
        </div>

        {evidenceTexts(edge).length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailEvidence')}</div>
            {evidenceTexts(edge).map((evidence, index) => (
              <div key={index} className={css.lineageDetailText}>{evidence}</div>
            ))}
          </div>
        )}

        {edge.properties?.reviewStatus !== 'confirmed' && (
          <div className={css.lineageModalFooter}>
            <button type="button" className={css.lineageToolbarButton} onClick={() => onReject(edge)}>否决</button>
            <button
              type="button"
              className={css.lineageToolbarButton}
              disabled={verifying}
              onClick={async () => {
                setVerifying(true)
                setVerifyMessage(null)
                const result = await onVerify(edge)
                setVerifyMessage(result.message)
                setVerifying(false)
              }}
            >
              {verifying ? '佐证中…' : '数据佐证'}
            </button>
            <button type="button" className={css.lineagePrimaryButton} onClick={() => onConfirm(edge)}>确认</button>
          </div>
        )}
        {!editing ? (
          <div className={css.lineageDetailSection}>
            <button type="button" className={css.lineageToolbarButton} onClick={() => setEditing(true)}>编辑关系</button>
          </div>
        ) : (
          <div className={css.lineageDetailSection}>
            <label className={css.lineageModalLabel}>
              <span>关系类型</span>
              <select value={editRelation} onChange={(event) => setEditRelation(event.target.value)}>
                <option value="">未指定</option>
                {ONTOLOGY_RELATIONS.map((relation) => (
                  <option key={relation.id} value={relation.id}>{relation.label} ({relation.id})</option>
                ))}
              </select>
            </label>
            <label className={css.lineageModalLabel}>
              <span>显示名称</span>
              <input value={editLabel} onChange={(event) => setEditLabel(event.target.value)} />
            </label>
            <label className={css.lineageModalLabel}>
              <span>约束</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label><input type="checkbox" checked={editRequired} onChange={(event) => setEditRequired(event.target.checked)} /> 必填</label>
              </span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label className={css.lineageModalLabel}>
                <span>最小基数</span>
                <input type="number" min={0} value={editMinCardinality} onChange={(event) => setEditMinCardinality(event.target.value)} />
              </label>
              <label className={css.lineageModalLabel}>
                <span>最大基数</span>
                <input type="number" min={0} value={editMaxCardinality} onChange={(event) => setEditMaxCardinality(event.target.value)} />
              </label>
            </div>
            <div className={css.lineageAssetActions}>
              <button type="button" className={css.lineageToolbarButton} onClick={() => setEditing(false)}>取消</button>
              <button
                type="button"
                className={css.lineagePrimaryButton}
                onClick={() => {
                  const properties = { ...(edge.properties ?? {}) }
                  if (editRequired) properties.required = true
                  else delete properties.required
                  if (editMinCardinality === '') delete properties.minCardinality
                  else properties.minCardinality = Number(editMinCardinality)
                  if (editMaxCardinality === '') delete properties.maxCardinality
                  else properties.maxCardinality = Number(editMaxCardinality)
                  onUpdateEdge({
                    ...edge,
                    ...(editRelation !== '' ? { rel_type: editRelation } : { rel_type: undefined }),
                    ...(editLabel.trim() !== '' ? { label: editLabel.trim() } : { label: undefined }),
                    properties,
                  })
                  setEditing(false)
                }}
              >
                保存
              </button>
            </div>
          </div>
        )}
        {verifyMessage !== null && <div className={css.lineageModalHint}>{verifyMessage}</div>}

        {properties.length > 0 && (
          <div className={css.lineageDetailSection}>
            <div className={css.lineageDetailLabel}>{t('lineageDetailProperties')}</div>
            {properties.map(([key, value]) => (
              <div key={key} className={css.lineagePropertyRow}>
                <span className={css.lineagePropertyKey}>{key}</span>
                <span className={css.lineagePropertyValue}>{String(value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </LineageDetailShell>
  )
}
