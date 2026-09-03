import { useEffect, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDatabaseOutline16,
  IconEditOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from './service.ts'
import { api, type DatabaseConnectionInput, type DatabaseQueryResult, type DatabaseSavedConnection, type DbColumnInfo, type DbEngine, type DbIndexInfo, type DbKeyInfo, type DbObjectInfo, type DbObjectKind } from './api.ts'
import { t } from './locales.ts'
import { DATABASE_COMPATIBILITY } from './lineage/database-compatibility.ts'
import css from './sidebar.module.css'

type SavedConnection = DatabaseSavedConnection


const DATABASE_TYPES: { id: string; label: string; color: string; enabled: boolean; versions: string }[] = [
  { id: 'mysql', label: 'MySQL', color: '#5b8ff9', enabled: true, versions: '5.7 / 8.0+' },
  { id: 'postgresql', label: 'PostgreSQL', color: '#4f86c6', enabled: true, versions: '10+' },
  { id: 'dm', label: 'DM', color: '#d64541', enabled: true, versions: 'DM8' },
  { id: 'oracle', label: 'Oracle', color: '#f56a52', enabled: false, versions: '' },
  { id: 'sqlserver', label: 'SQLServer', color: '#cc4b4b', enabled: false, versions: '' },
  { id: 'mariadb', label: 'MariaDB', color: '#2f6f9f', enabled: false, versions: '' },
  { id: 'clickhouse', label: 'ClickHouse', color: '#f7c400', enabled: false, versions: '' },
  { id: 'presto', label: 'Presto', color: '#6d5bd0', enabled: false, versions: '' },
  { id: 'db2', label: 'DB2', color: '#3fae62', enabled: false, versions: '' },
  { id: 'oceanbase', label: 'OceanBase', color: '#2f8fdd', enabled: false, versions: '' },
]

const FOLDER_KINDS: { kind: DbObjectKind; i18n: Parameters<typeof t>[0] }[] = [
  { kind: 'tables', i18n: 'databaseTables' },
  { kind: 'views', i18n: 'databaseViews' },
  { kind: 'functions', i18n: 'databaseFunctions' },
  { kind: 'procedures', i18n: 'databaseProcedures' },
  { kind: 'triggers', i18n: 'databaseTriggers' },
]

function defaultPortFor(engine: DbEngine): number {
  if (engine === 'postgresql') return 5432
  if (engine === 'dm') return 5236
  return 3306
}

function emptyDraft(): SavedConnection {
  return { id: '', name: '', engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' }
}

function isConnection(value: unknown): value is SavedConnection {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.host === 'string'
    && typeof record.port === 'number'
    && typeof record.user === 'string'
    && (record.password === undefined || typeof record.password === 'string')
    && (record.database === undefined || typeof record.database === 'string')
    && (record.engine === undefined || record.engine === 'mysql' || record.engine === 'postgresql' || record.engine === 'dm')
}

async function readSavedConnections(): Promise<SavedConnection[]> {
  try {
    const { connections } = await api.dbConnectionsGet()
    return connections
  } catch {
    return []
  }
}

async function writeSavedConnections(connections: SavedConnection[]): Promise<void> {
  const existing = await readSavedConnections()
  const existingIds = new Set(existing.map((item) => item.id))
  for (const connection of connections) {
    if (!existingIds.has(connection.id)) await api.dbConnectionsSave(connection)
  }
  const targetIds = new Set(connections.map((item) => item.id))
  for (const existing_ of existing) {
    if (!targetIds.has(existing_.id)) await api.dbConnectionsDelete(existing_.id)
  }
}
function EyeIcon({ off }: { off: boolean }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="4" y1="20" x2="20" y2="4" />}
    </svg>
  )
}

export function DatabaseView(_props: TabComponentProps): ReactNode {
  const [connections, setConnections] = useState<SavedConnection[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [typeListOpen, setTypeListOpen] = useState(false)
  const [typeQuery, setTypeQuery] = useState('')
  const [compatibilityOpen, setCompatibilityOpen] = useState(false)
  const [editing, setEditing] = useState<SavedConnection | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [draftDatabases, setDraftDatabases] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [connOpen, setConnOpen] = useState(false)
  const [serverVersions, setServerVersions] = useState<Record<string, string>>({})
  const [databases, setDatabases] = useState<string[]>([])
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const [tableDetails, setTableDetails] = useState<Record<string, { columns?: DbColumnInfo[]; keys?: DbKeyInfo[]; indexes?: DbIndexInfo[] }>>({})
  const [objectsByDb, setObjectsByDb] = useState<Record<string, Partial<Record<DbObjectKind, DbObjectInfo[]>>>>({})
  const [selected, setSelected] = useState<{ db: string; table: string } | null>(null)
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<DatabaseQueryResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const active = connections.find((item) => item.id === activeId) ?? null
  const serverVersion = activeId !== null ? serverVersions[activeId] ?? '' : ''

  const refreshConnections = async (): Promise<void> => {
    setConnections(await readSavedConnections())
  }

  useEffect(() => {
    void refreshConnections()
  }, [])

  const connectionInput = (connection: SavedConnection): DatabaseConnectionInput => ({
    engine: connection.engine ?? 'mysql',
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    ...(connection.database !== '' ? { database: connection.database } : {}),
  })

  const disconnect = (): void => {
    setActiveId(null)
    setConnOpen(false)
    setDatabases([])
    setExpandedDbs(new Set())
    setObjectsByDb({})
    setExpandedFolders(new Set())
    setExpandedTables(new Set())
    setTableDetails({})
    setSelected(null)
    setResult(null)
    setError(null)
    setNotice(null)
  }

  const connect = async (connection: SavedConnection): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const tested = await api.dbTest(connectionInput(connection))
      const list = await api.dbDatabases(connectionInput(connection))
      setActiveId(connection.id)
      setServerVersions((prev) => ({ ...prev, [connection.id]: tested.serverVersion }))
      setDatabases(list.databases)
      setExpandedDbs(new Set())
      setObjectsByDb({})
      setExpandedFolders(new Set())
      setExpandedTables(new Set())
      setTableDetails({})
      setSelected(null)
      setResult(null)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const loadObjects = async (connection: SavedConnection, db: string, kind: DbObjectKind): Promise<DbObjectInfo[]> => {
    const { objects } = await api.dbObjects({ ...connectionInput(connection), database: db }, db, kind)
    setObjectsByDb((prev) => ({ ...prev, [db]: { ...prev[db], [kind]: objects } }))
    return objects
  }

  const toggleFolder = (db: string, kind: DbObjectKind): void => {
    if (active === null) return
    const key = db + ':' + kind
    const willExpand = !expandedFolders.has(key)
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (willExpand && objectsByDb[db]?.[kind] === undefined) {
      void loadObjects(active, db, kind).catch((e) => setError(e instanceof Error ? e.message : t('databaseLoadError')))
    }
  }

  const toggleTable = async (db: string, tableName: string): Promise<void> => {
    if (active === null) return
    const key = db + ':' + tableName
    const willExpand = !expandedTables.has(key)
    setExpandedTables((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (willExpand && tableDetails[key]?.columns === undefined) {
      try {
        const [columns, keys, indexes] = await Promise.all([
          api.dbColumns({ ...connectionInput(active), database: db }, db, tableName),
          api.dbKeys({ ...connectionInput(active), database: db }, db, tableName),
          api.dbIndexes({ ...connectionInput(active), database: db }, db, tableName),
        ])
        setTableDetails((prev) => ({ ...prev, [key]: { columns: columns.columns, keys: keys.keys, indexes: indexes.indexes } }))
      } catch (e) {
        setError(e instanceof Error ? e.message : t('databaseLoadError'))
      }
    }
  }

  const onConnectionClick = async (connection: SavedConnection): Promise<void> => {
    if (activeId !== connection.id) {
      const ok = await connect(connection)
      if (ok) setConnOpen(true)
    } else {
      setConnOpen((open) => !open)
    }
  }

  const toggleDb = (db: string): void => {
    if (active === null) return
    const willExpand = !expandedDbs.has(db)
    setExpandedDbs((prev) => {
      const next = new Set(prev)
      if (next.has(db)) next.delete(db)
      else next.add(db)
      return next
    })
    if (willExpand && objectsByDb[db]?.tables === undefined) void loadObjects(active, db, 'tables').catch((e) => setError(e instanceof Error ? e.message : t('databaseLoadError')))
  }

  const onTableClick = (db: string, table: string): void => {
    setEditing(null)
    setSelected({ db, table })
    setSql(`SELECT * FROM \`${db}\`.\`${table}\` LIMIT 100`)
    setResult(null)
  }

  const refreshActive = async (): Promise<void> => {
    await refreshConnections()
    if (active === null) return
    setBusy(true)
    setError(null)
    try {
      const list = await api.dbDatabases(connectionInput(active))
      setDatabases(list.databases)
      setObjectsByDb({})
      setExpandedFolders(new Set())
      setExpandedTables(new Set())
      setTableDetails({})
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const deleteConnection = async (connection: SavedConnection): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const saved = connections.filter((item) => item.id !== connection.id)
      await writeSavedConnections(saved)
      setConnections(saved)
      if (activeId === connection.id) disconnect()
      setServerVersions((prev) => {
        const next = { ...prev }
        delete next[connection.id]
        return next
      })
      if (editing?.id === connection.id) setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const updateEditing = (patch: Partial<SavedConnection>): void => setEditing((current) => (current === null ? current : { ...current, ...patch }))

  const saveEditing = async (): Promise<void> => {
    if (editing === null) return
    if (editing.name.trim() === '' || editing.host.trim() === '' || editing.user.trim() === '') return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = editing.id === '' ? { ...editing, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}` } : editing
      const index = connections.findIndex((item) => item.id === next.id)
      const saved = index === -1 ? [...connections, next] : connections.map((item) => (item.id === next.id ? next : item))
      await writeSavedConnections(saved)
      setConnections(saved)
      setEditing(null)
      setNotice(t('databaseSaved'))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const testEditing = async (): Promise<void> => {
    if (editing === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const tested = await api.dbTest(connectionInput(editing))
      setNotice(t('databaseTestOk', { version: tested.serverVersion }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const loadDraftDatabases = async (): Promise<void> => {
    if (editing === null) return
    if (editing.host.trim() === '' || editing.user.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const list = await api.dbDatabases(connectionInput(editing))
      setDraftDatabases(list.databases)
      const current = editing.database ?? ''
      if (list.databases.length > 0 && (current === '' || !list.databases.includes(current))) {
        setEditing((value) => (value === null ? value : { ...value, database: list.databases[0] ?? '' }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const runSql = async (): Promise<void> => {
    if (active === null || selected === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setResult(null)
    try {
      setResult(await api.dbQuery({ ...connectionInput(active), database: selected.db }, sql))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('databaseLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const openNewConnection = (): void => {
    setEditing(emptyDraft())
    setDraftDatabases([])
    setShowPassword(false)
    setMenuOpen(false)
    setTypeListOpen(false)
    setTypeQuery('')
  }

  const visibleTypes = DATABASE_TYPES.filter((type) => type.label.toLowerCase().includes(typeQuery.trim().toLowerCase()))

  return (
    <div className={css.databaseLayout}>
      <div className={css.databaseTree}>
        <div className={css.databaseTreeToolbar}>
          <div className={css.databaseMenuAnchor}>
            <button type="button" className={css.lineageIconButton} title={t('databaseNewConnection')} onClick={() => { setMenuOpen((open) => !open); setTypeListOpen(false) }}>
              <IconPlusOutline16 size={14} />
            </button>
            {menuOpen && (
              <>
                <div className={css.databaseMenuBackdrop} onClick={() => setMenuOpen(false)} />
                <div className={css.databaseMenu}>
                  <button
                    type="button"
                    className={css.databaseMenuItem}
                    onClick={() => { setTypeListOpen((open) => !open); setTypeQuery('') }}
                  >
                    {t('databaseNewConnection')} ›
                  </button>
                  {typeListOpen && (
                    <div className={css.databaseTypeList}>
                      <div className={css.databaseTypeSearch}>
                        <IconSearchOutline16 size={12} />
                        <input value={typeQuery} onChange={(e) => setTypeQuery(e.target.value)} placeholder={t('databaseTypeSearch')} />
                      </div>
                      <div className={css.databaseTypeItems}>
                        {visibleTypes.map((type) => (
                          <button
                            type="button"
                            key={type.id}
                            className={css.databaseTypeItem}
                            disabled={!type.enabled}
                            title={type.enabled ? type.label : t('databaseComingSoon')}
                            onClick={() => { if (type.enabled) { openNewConnection(); setEditing((v) => (v === null ? v : { ...v, engine: type.id as DbEngine, port: defaultPortFor(type.id as DbEngine) })) } }}
                          >
                            <span className={css.databaseTypeDot} style={{ background: type.color }} />
                            <span className={css.databaseTypeLabel}>{type.label}</span>
                            {!type.enabled && <span className={css.databaseTypeSoon}>{t('databaseComingSoon')}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <button type="button" className={css.lineageIconButton} title={t('databaseRefresh')} disabled={busy} onClick={() => void refreshActive()}>
            <IconRefreshOutline16 size={14} />
          </button>
          <span className={css.databaseTreeSpacer} />
          {active !== null && (
            <button type="button" className={css.lineageIconButton} title={t('databaseDisconnect')} onClick={disconnect}>
              <IconCloseOutline16 size={14} />
            </button>
          )}
        </div>

        <div className={css.databaseTreeBody}>
          <button
            type="button"
            className={css.databaseMenuItem}
            style={{ margin: '4px 8px 8px', color: 'var(--dsw-alias-label-secondary, #64748b)' }}
            onClick={() => setCompatibilityOpen((open) => !open)}
          >
            {compatibilityOpen ? '兼容矩阵 ▾' : '兼容矩阵 ▸'}
          </button>
          {compatibilityOpen && DATABASE_COMPATIBILITY.map((item) => (
            <div key={item.engine} className={css.databaseTreeEmpty} style={{ textAlign: 'left', padding: '0 10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <strong>{item.label}</strong>
                <span>{item.versions}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #94a3b8)', marginBottom: 4 }}>
                驱动 {item.driver} · {item.status === 'supported' ? '支持' : '规划中'}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {item.features.map((feature) => <span key={feature} className={css.databaseMiniButton}>{feature}</span>)}
              </div>
              {item.notes.map((note) => <div key={note} style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>· {note}</div>)}
            </div>
          ))}
          {connections.length === 0 && <div className={css.databaseTreeEmpty}>{t('databaseNoConnections')}</div>}
          {connections.map((connection) => (
            <div key={connection.id}>
              <div
                className={`${css.databaseConnRow} ${activeId === connection.id ? css.databaseConnRowActive : ''}`}
                onClick={() => void onConnectionClick(connection)}
              >
                {activeId === connection.id && connOpen
                  ? <IconChevronDownOutline14 size={12} />
                  : <IconChevronRightOutline14 size={12} />}
                <IconDatabaseOutline16 size={14} />
                <span className={css.databaseConnName}>{connection.name}</span>
                <span className={css.databaseConnMeta}>
                  {activeId === connection.id && serverVersions[connection.id] !== undefined
                    ? `${serverVersions[connection.id]}`
                    : activeId === connection.id ? `${databases.length}` : connection.host}
                </span>
                <span className={css.databaseRowActions}>
                  <button
                    type="button"
                    className={css.databaseMiniButton}
                    title={t('databaseEdit')}
                    onClick={(e) => { e.stopPropagation(); setEditing({ ...connection }); setShowPassword(false); setDraftDatabases([]) }}
                  >
                    <IconEditOutline16 size={12} />
                  </button>
                  <button
                    type="button"
                    className={css.databaseMiniButton}
                    title={t('databaseDelete')}
                    onClick={(e) => { e.stopPropagation(); void deleteConnection(connection) }}
                  >
                    <IconTrashOutline16 size={12} />
                  </button>
                </span>
              </div>
              {activeId === connection.id && connOpen && databases.map((db) => (
                <div key={db}>
                  <div className={css.databaseDbRow} onClick={() => toggleDb(db)}>
                    {expandedDbs.has(db) ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
                    <IconDatabaseOutline16 size={13} />
                    <span className={css.databaseConnName}>{db}</span>
                  </div>
                  {expandedDbs.has(db) && FOLDER_KINDS.map(({ kind, i18n }) => {
                    const folderKey = db + ':' + kind
                    const objects = objectsByDb[db]?.[kind] ?? []
                    return (
                      <div key={kind}>
                        <div className={css.databaseFolderRow} onClick={() => toggleFolder(db, kind)}>
                          {expandedFolders.has(folderKey) ? <IconChevronDownOutline14 size={11} /> : <IconChevronRightOutline14 size={11} />}
                          <span className={css.databaseFolderName}>{t(i18n)}</span>
                          {objects.length > 0 && <span className={css.databaseFolderCount}>{objects.length}</span>}
                        </div>
                        {expandedFolders.has(folderKey) && kind === 'tables' && objects.map((obj) => {
                          const tableKey = db + ':' + obj.name
                          const detail = tableDetails[tableKey]
                          return (
                            <div key={obj.name}>
                              <div className={`${css.databaseTableLeaf} ${selected?.db === db && selected?.table === obj.name ? css.databaseConnRowActive : ''}`} onClick={() => onTableClick(db, obj.name)}>
                                <span className={css.databaseTableDot} />
                                <span className={css.databaseConnName}>{obj.name}</span>
                                {obj.comment !== '' && <span className={css.databaseObjectComment}>{obj.comment}</span>}
                                <span className={css.databaseTableExpand} onClick={(e) => { e.stopPropagation(); void toggleTable(db, obj.name) }}>
                                  {expandedTables.has(tableKey) ? <IconChevronDownOutline14 size={10} /> : <IconChevronRightOutline14 size={10} />}
                                </span>
                              </div>
                              {expandedTables.has(tableKey) && detail && (
                                <div className={css.databaseTableSubTree}>
                                  {detail.columns && (<div><div className={css.databaseSubFolder}>{t('databaseColumns')}</div>
                                    {detail.columns.map((col) => (<div key={col.name} className={css.databaseSubLeaf}><span className={css.databaseSubLeafName}>{col.name}</span><span className={css.databaseSubLeafMeta}>{col.dataType}{col.comment ? ' · ' + col.comment : ''}</span></div>))}
                                  </div>)}
                                  {detail.keys && detail.keys.length > 0 && (<div><div className={css.databaseSubFolder}>{t('databaseKeys')}</div>
                                    {detail.keys.map((key) => (<div key={key.name} className={css.databaseSubLeaf}><span className={css.databaseSubLeafName}>{key.name}</span><span className={css.databaseSubLeafMeta}>{key.columns.join(', ')}</span></div>))}
                                  </div>)}
                                  {detail.indexes && detail.indexes.length > 0 && (<div><div className={css.databaseSubFolder}>{t('databaseIndexes')}</div>
                                    {detail.indexes.map((idx) => (<div key={idx.name} className={css.databaseSubLeaf}><span className={css.databaseSubLeafName}>{idx.name}</span><span className={css.databaseSubLeafMeta}>{idx.columns.join(', ')}</span></div>))}
                                  </div>)}
                                </div>
                              )}
                            </div>
                          )
                        })}
                        {expandedFolders.has(folderKey) && kind !== 'tables' && objects.map((obj) => (
                          <div key={obj.name} className={css.databaseSubLeaf}>
                            <span className={css.databaseSubLeafName}>{obj.name}</span>
                            {obj.comment !== '' && <span className={css.databaseSubLeafMeta}>{obj.comment}</span>}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className={css.databaseMain}>
        {error !== null && <div className={css.editorError}>{error}</div>}
        {notice !== null && <div className={css.databaseNotice}>{notice}</div>}

        {editing !== null ? (
          <div className={css.databaseFormPanel}>
            <div className={css.databaseFormHeader}>
              <IconDatabaseOutline16 size={16} />
              <span className={css.databaseFormTitle}>{editing.engine === 'postgresql' ? 'PostgreSQL' : editing.engine === 'dm' ? 'DM' : 'MySQL'}</span>
              <button type="button" className={css.lineageIconButton} title={t('close')} onClick={() => setEditing(null)}>
                <IconCloseOutline16 size={14} />
              </button>
            </div>

            <div className={css.databaseFormBody}>
              <div className={css.databaseFormRow}>
                <span className={css.databaseFormLabel}>{t('databaseName')}</span>
                <div className={css.databaseFormControl}>
                  <input className={css.databaseInput} value={editing.name} onChange={(e) => updateEditing({ name: e.target.value })} />
                </div>
              </div>

              <div className={css.databaseFormRow}>
                <span className={css.databaseFormLabel}>{t('databaseHost')}</span>
                <div className={css.databaseFormControl}>
                  <input className={css.databaseInput} value={editing.host} onChange={(e) => updateEditing({ host: e.target.value })} />
                  <span className={css.databaseFormLabel}>{t('databasePort')}</span>
                  <input className={css.databaseInput} style={{ maxWidth: 110 }} type="number" value={editing.port} onChange={(e) => updateEditing({ port: Number(e.target.value) })} />
                </div>
              </div>

              <div className={css.databaseFormRow}>
                <span className={css.databaseFormLabel}>{t('databaseUser')}</span>
                <div className={css.databaseFormControl}>
                  <input className={css.databaseInput} value={editing.user} onChange={(e) => updateEditing({ user: e.target.value })} />
                </div>
              </div>

              <div className={css.databaseFormRow}>
                <span className={css.databaseFormLabel}>{t('databasePassword')}</span>
                <div className={css.databaseFormControl}>
                  <input className={css.databaseInput} type={showPassword ? 'text' : 'password'} value={editing.password} onChange={(e) => updateEditing({ password: e.target.value })} />
                  <button type="button" className={css.databaseMiniButton} title={t('databaseTogglePassword')} onClick={() => setShowPassword((show) => !show)}>
                    <EyeIcon off={!showPassword} />
                  </button>
                </div>
              </div>

              <div className={css.databaseFormRow}>
                <span className={css.databaseFormLabel}>{t('databaseDatabase')}</span>
                <div className={css.databaseFormControl}>
                  <select className={css.databaseInput} value={editing.database ?? ''} onChange={(e) => updateEditing({ database: e.target.value })}>
                    <option value="">{t('databaseDatabase')}</option>
                    {editing.database !== undefined && editing.database !== '' && !draftDatabases.includes(editing.database) && (
                      <option value={editing.database}>{editing.database}</option>
                    )}
                    {draftDatabases.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <button type="button" className={css.lineageToolbarButton} disabled={busy} onClick={() => void loadDraftDatabases()}>{t('databaseRefresh')}</button>
                </div>
              </div>

              <div className={css.databaseFormRow}>
                <span className={css.databaseFormLabel}>{t('databaseUrl')}</span>
                <div className={css.databaseFormControl}>
                  <input className={css.databaseInput} readOnly value={`${editing.engine === 'postgresql' ? 'jdbc:postgresql' : editing.engine === 'dm' ? 'jdbc:dm' : 'jdbc:mysql'}://${editing.host}:${editing.port}`} />
                </div>
              </div>
            </div>

            <div className={css.databaseFormFooter}>
              <button type="button" className={css.lineageToolbarButton} disabled={busy} onClick={() => void testEditing()}>{t('databaseTest')}</button>
              <span className={css.databaseTreeSpacer} />
              <button type="button" className={css.lineageToolbarButton} onClick={() => setEditing(null)}>{t('cancel')}</button>
              <button type="button" className={css.databasePrimaryButton} disabled={busy} onClick={() => void saveEditing()}>{t('databaseSave')}</button>
            </div>
          </div>
        ) : selected !== null && active !== null ? (
          <div className={css.databaseQueryView}>
            <div className={css.databaseQueryHeader}>
              <span className={css.databaseConnectionName}>{selected.db} · {selected.table}</span>
              {serverVersion !== '' && <span className={css.databaseServerVersion}>{t('databaseServerVersion', { version: serverVersion })}</span>}
              <span className={css.databaseTreeSpacer} />
              <button type="button" className={css.lineageToolbarButton} disabled={busy} onClick={() => void runSql()}>{t('databaseRun')}</button>
            </div>
            <textarea
              className={css.databaseSqlInput}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder={t('databaseSqlPlaceholder')}
              spellCheck={false}
            />
            <DatabaseResult result={result} />
          </div>
        ) : (
          <div className={css.databasePlaceholder}>{t('databasePlaceholder')}</div>
        )}
      </div>
    </div>
  )
}

function DatabaseResult({ result }: { result: DatabaseQueryResult | null }): ReactNode {
  if (result === null) return null
  if (result.kind === 'update') {
    return (
      <div className={css.databaseUpdateResult}>
        {t('databaseUpdateResult', { affectedRows: result.affectedRows })}
        {result.changedRows !== undefined ? ` · ${t('databaseChangedRows', { changedRows: result.changedRows })}` : ''}
      </div>
    )
  }
  if (result.rows.length === 0) return <div className={css.editorPlaceholder}>{t('databaseNoRows')}</div>
  return (
    <div className={css.databaseResultTableWrap}>
      <table className={css.databaseResultTable}>
        <thead>
          <tr>
            {result.columns.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{String(cell ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated && <div className={css.databaseTruncated}>{t('databaseTruncated')}</div>}
    </div>
  )
}
