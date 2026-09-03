/**
 * Multi-engine database explorer/query routes for the database tab.
 *
 * The browser only ever sends connection parameters and SQL; the host opens
 * the database connection, so credentials never leave the plugin host process.
 * Connections are created per request and closed immediately — the tab is an
 * inspection surface, not a long-lived connection pool.
 */
import mysql from 'mysql2/promise'
import pg from 'pg'
import dmdb from 'dmdb'
import { requireString, SidebarError } from './wire.ts'

export type DbEngine = 'mysql' | 'postgresql' | 'dm'

interface DatabaseConnectionInput {
  engine: DbEngine
  host: string
  port: number
  user: string
  password: string
  database?: string
}

interface DbObjectInfo {
  name: string
  type: string
  comment: string
}

interface DbColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string
  comment: string
}

interface DbKeyInfo {
  name: string
  type: string
  columns: string[]
}

interface DbIndexInfo {
  name: string
  unique: boolean
  columns: string[]
}

interface DatabaseDdlResult {
  kind: 'table' | 'view' | 'function' | 'procedure' | 'trigger'
  ddl: string
}

type DbObjectKind = 'tables' | 'views' | 'functions' | 'procedures' | 'triggers'

interface DatabaseColumnsResult {
  kind: 'rows'
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

interface DatabaseUpdateResult {
  kind: 'update'
  affectedRows: number
  changedRows: number
  insertId: number
}

type DatabaseQueryResult = DatabaseColumnsResult | DatabaseUpdateResult

function optionalString(payload: unknown, key: string): string | undefined {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function engineOf(payload: unknown): DbEngine {
  const engine = optionalString(payload, 'engine')
  if (engine === 'postgresql' || engine === 'dm') return engine
  return 'mysql'
}

function defaultPort(engine: DbEngine): number {
  if (engine === 'postgresql') return 5432
  if (engine === 'dm') return 5236
  return 3306
}

function connectionInputOf(payload: unknown, requireDatabase: boolean): DatabaseConnectionInput {
  const engine = engineOf(payload)
  const host = requireString(payload, 'host')
  const user = requireString(payload, 'user')
  const record = payload as Record<string, unknown> | null
  const portValue = record?.port
  const port = typeof portValue === 'number' && Number.isInteger(portValue) && portValue > 0 && portValue <= 65535
    ? portValue
    : defaultPort(engine)
  const password = typeof record?.password === 'string' ? record.password : ''
  const database = optionalString(payload, 'database')
  if (requireDatabase && database === undefined) {
    throw new SidebarError('bad-request', 'missing or invalid "database"')
  }
  return { engine: engine ?? 'mysql', host, port, user, password, database }
}

function errorOf(error: unknown): SidebarError {
  const message = error instanceof Error ? error.message : String(error)
  return new SidebarError('db-error', message, 400)
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `[BLOB ${value.length} bytes]`
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return value
}

function s(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function b(value: unknown): boolean {
  return value === 'YES' || value === true || value === 'true' || value === 1
}

interface DbDriver {
  test(input: DatabaseConnectionInput): Promise<{ serverVersion: string }>
  databases(input: DatabaseConnectionInput): Promise<string[]>
  objects(input: DatabaseConnectionInput, database: string, kind: DbObjectKind): Promise<DbObjectInfo[]>
  columns(input: DatabaseConnectionInput, database: string, object: string): Promise<DbColumnInfo[]>
  keys(input: DatabaseConnectionInput, database: string, object: string): Promise<DbKeyInfo[]>
  indexes(input: DatabaseConnectionInput, database: string, object: string): Promise<DbIndexInfo[]>
  ddl(input: DatabaseConnectionInput, database: string, object: string): Promise<DatabaseDdlResult>
  query(input: DatabaseConnectionInput, database: string, sql: string): Promise<DatabaseQueryResult>
}

/** Build portable DDL when a database does not expose native definition SQL. */
async function syntheticDdl(
  driver: Pick<DbDriver, 'columns' | 'keys' | 'indexes' | 'objects'>,
  input: DatabaseConnectionInput,
  database: string,
  object: string,
  kind: DatabaseDdlResult['kind'],
): Promise<DatabaseDdlResult> {
  if (kind !== 'table') {
    return { kind, ddl: `-- Native definition for ${kind} ${object} is not available.` }
  }
  const [columns, keys, indexes] = await Promise.all([
    driver.columns(input, database, object),
    driver.keys(input, database, object),
    driver.indexes(input, database, object),
  ])
  const lines = columns.map((column) => {
    const nullable = column.nullable ? '' : ' NOT NULL'
    const defaultValue = column.defaultValue === '' ? '' : ` DEFAULT ${column.defaultValue}`
    return `  ${column.name} ${column.dataType}${nullable}${defaultValue}`
  })
  for (const key of keys.filter((item) => item.type.toUpperCase().includes('PRIMARY'))) {
    lines.push(`  PRIMARY KEY (${key.columns.map((column) => column).join(', ')})`)
  }
  for (const key of keys.filter((item) => item.type.toUpperCase().includes('UNIQUE') && !item.type.toUpperCase().includes('PRIMARY'))) {
    lines.push(`  UNIQUE ${key.name} (${key.columns.join(', ')})`)
  }
  const body = lines.map((line) => line.replace(/\s+$/, '')).join(',\n')
  const comments = columns.filter((column) => column.comment !== '')
    .map((column) => `COMMENT ON COLUMN ${object}.${column.name} IS '${column.comment.replace(/'/g, "''")}'`)
    .join('\n')
  return {
    kind,
    ddl: `CREATE TABLE ${object} (\n${body}\n);${comments === '' ? '' : `\n\n${comments};`}`,
  }
}

/* ------------------------------- MySQL --------------------------------- */

async function withMysql<T>(input: DatabaseConnectionInput, database: string | undefined, fn: (connection: mysql.Connection) => Promise<T>): Promise<T> {
  const connection = await mysql.createConnection({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    ...(database !== undefined && database !== '' ? { database } : {}),
    connectTimeout: 10_000,
    multipleStatements: false,
  })
  try {
    return await fn(connection)
  } finally {
    await connection.end().catch(() => {})
  }
}

const mysqlDriver: DbDriver = {
  async test(input) {
    return withMysql(input, undefined, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version')
      return { serverVersion: `MySQL ${s(rows[0]?.version)}` }
    })
  },
  async databases(input) {
    return withMysql(input, undefined, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW DATABASES')
      return rows.map((row) => s(row.Database ?? row.database)).filter((name) => name !== '')
    })
  },
  async objects(input, database, kind) {
    if (kind === 'functions' || kind === 'procedures') {
      const routineType = kind === 'functions' ? 'FUNCTION' : 'PROCEDURE'
      return withMysql(input, database, async (connection) => {
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME',
          [database, routineType],
        )
        return rows.map((row) => ({ name: s(row.name), type: s(row.type), comment: s(row.comment) }))
      })
    }
    if (kind === 'triggers') {
      return withMysql(input, database, async (connection) => {
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT TRIGGER_NAME AS name, 'TRIGGER' AS type, '' AS comment FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
          [database],
        )
        return rows.map((row) => ({ name: s(row.name), type: s(row.type), comment: s(row.comment) }))
      })
    }
    const tableType = kind === 'tables' ? 'BASE TABLE' : 'VIEW'
    return withMysql(input, database, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
        [database, tableType],
      )
      return rows.map((row) => ({ name: s(row.name), type: s(row.type), comment: s(row.comment) }))
    })
  },
  async columns(input, database, object) {
    return withMysql(input, database, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS dataType, IS_NULLABLE AS nullable, COALESCE(COLUMN_DEFAULT, '') AS defaultValue, COALESCE(COLUMN_COMMENT, '') AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, object],
      )
      return rows.map((row) => ({ name: s(row.name), dataType: s(row.dataType), nullable: b(row.nullable), defaultValue: s(row.defaultValue), comment: s(row.comment) }))
    })
  },
  async keys(input, database, object) {
    return withMysql(input, database, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type, kcu.COLUMN_NAME AS columnName FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION',
        [database, object],
      )
      const map = new Map<string, DbKeyInfo>()
      for (const row of rows) {
        const name = s(row.name)
        const existing = map.get(name)
        if (existing) existing.columns.push(s(row.columnName))
        else map.set(name, { name, type: s(row.type), columns: [s(row.columnName)] })
      }
      return [...map.values()]
    })
  },
  async indexes(input, database, object) {
    return withMysql(input, database, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
        [database, object],
      )
      const map = new Map<string, DbIndexInfo>()
      for (const row of rows) {
        const name = s(row.name)
        const existing = map.get(name)
        if (existing) existing.columns.push(s(row.columnName))
        else map.set(name, { name, unique: !b(row.nonUnique), columns: [s(row.columnName)] })
      }
      return [...map.values()]
    })
  },
  async ddl(input, database, object) {
    return withMysql(input, database, async (connection) => {
      const [types] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [database, object],
      )
      const tableType = s(types[0]?.type).toUpperCase()
      if (tableType === 'BASE TABLE') {
        const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW CREATE TABLE `' + object + '`')
        const ddl = s(rows[0]?.['Create Table'])
        if (ddl !== '') return { kind: 'table' as const, ddl }
      }
      if (tableType === 'VIEW') {
        const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW CREATE VIEW `' + object + '`')
        const ddl = s(rows[0]?.['Create View'])
        if (ddl !== '') return { kind: 'view' as const, ddl }
      }
      return syntheticDdl(mysqlDriver, input, database, object, 'table')
    })
  },
  async query(input, database, sql) {
    return withMysql(input, database, async (connection) => {
      const [result, fields] = await connection.query({ sql, timeout: 30_000, values: [] })
      if (Array.isArray(result)) {
        const columns = fields === undefined ? [] : (fields as mysql.FieldPacket[]).map((field) => field.name)
        const rows = (result as mysql.RowDataPacket[]).slice(0, 500).map((row) =>
          Object.values(row as Record<string, unknown>).map(normalizeCell),
        )
        return { kind: 'rows' as const, columns, rows, truncated: result.length > 500 }
      }
      const header = result as mysql.ResultSetHeader
      return { kind: 'update' as const, affectedRows: header.affectedRows, changedRows: header.changedRows ?? 0, insertId: header.insertId }
    })
  },
}

/* ----------------------------- PostgreSQL -------------------------------- */

async function withPg<T>(input: DatabaseConnectionInput, database: string | undefined, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    ...(database !== undefined && database !== '' ? { database } : {}),
    connectionTimeoutMillis: 10_000,
  })
  try {
    await client.connect()
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

const pgDriver: DbDriver = {
  async test(input) {
    return withPg(input, undefined, async (client) => {
      const { rows } = await client.query('SELECT version() AS version')
      return { serverVersion: s(rows[0]?.version).split(' ').slice(0, 2).join(' ') }
    })
  },
  async databases(input) {
    return withPg(input, undefined, async (client) => {
      const { rows } = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname')
      return rows.map((row) => s(row.datname))
    })
  },
  async objects(input, database, kind) {
    return withPg(input, database, async (client) => {
      if (kind === 'tables' || kind === 'views') {
        const tableType = kind === 'tables' ? 'BASE TABLE' : 'VIEW'
        const { rows } = await client.query(
          `SELECT t.table_name AS name, COALESCE(obj_description((quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass, 'pg_class'), '') AS comment FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = $1 ORDER BY t.table_name`,
          [tableType],
        )
        return rows.map((row) => ({ name: s(row.name), type: tableType, comment: s(row.comment) }))
      }
      if (kind === 'functions' || kind === 'procedures') {
        const routineType = kind === 'functions' ? 'FUNCTION' : 'PROCEDURE'
        const { rows } = await client.query(
          `SELECT routine_name AS name, '' AS comment FROM information_schema.routines WHERE routine_schema = 'public' AND routine_type = $1 ORDER BY routine_name`,
          [routineType],
        )
        return rows.map((row) => ({ name: s(row.name), type: routineType, comment: s(row.comment) }))
      }
      const { rows } = await client.query(
        `SELECT trigger_name AS name, '' AS comment FROM information_schema.triggers WHERE trigger_schema = 'public' ORDER BY trigger_name`,
      )
      return rows.map((row) => ({ name: s(row.name), type: 'TRIGGER', comment: s(row.comment) }))
    })
  },
  async columns(input, database, object) {
    return withPg(input, database, async (client) => {
      const { rows } = await client.query(
        `SELECT c.column_name AS name, c.data_type AS "dataType", c.is_nullable AS nullable, COALESCE(c.column_default, '') AS "defaultValue", COALESCE(col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position), '') AS comment FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = $1 ORDER BY c.ordinal_position`,
        [object],
      )
      return rows.map((row) => ({ name: s(row.name), dataType: s(row.dataType), nullable: b(row.nullable), defaultValue: s(row.defaultValue), comment: s(row.comment) }))
    })
  },
  async keys(input, database, object) {
    return withPg(input, database, async (client) => {
      const { rows } = await client.query(
        `SELECT tc.constraint_name AS name, tc.constraint_type AS type, kcu.column_name AS "columnName" FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.table_schema = 'public' AND tc.table_name = $1 ORDER BY tc.constraint_name, kcu.ordinal_position`,
        [object],
      )
      const map = new Map<string, DbKeyInfo>()
      for (const row of rows) {
        const name = s(row.name)
        const existing = map.get(name)
        if (existing) existing.columns.push(s(row.columnName))
        else map.set(name, { name, type: s(row.type), columns: [s(row.columnName)] })
      }
      return [...map.values()]
    })
  },
  async indexes(input, database, object) {
    return withPg(input, database, async (client) => {
      const { rows } = await client.query(
        `SELECT indexname AS name, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
        [object],
      )
      return rows.map((row) => {
        const def = s(row.indexdef)
        const colMatch = def.match(/\((.+)\)/)
        return { name: s(row.name), unique: def.toUpperCase().includes('UNIQUE'), columns: colMatch ? colMatch[1]!.split(',').map((c) => c.trim().replace(/"/g, '')) : [] }
      })
    })
  },
  async ddl(input, database, object) {
    return withPg(input, database, async (client) => {
      const { rows: objects } = await client.query(
        'SELECT table_type FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
        ['public', object],
      )
      const tableType = s(objects[0]?.table_type).toUpperCase()
      if (tableType === 'VIEW') {
        const { rows } = await client.query(
          'SELECT pg_get_viewdef($1::regclass, true) AS ddl',
          [`public.${object}`],
        )
        return { kind: 'view' as const, ddl: `CREATE VIEW ${object} AS\n${s(rows[0]?.ddl)}` }
      }
      if (tableType === 'BASE TABLE') {
        return syntheticDdl(pgDriver, input, database, object, 'table')
      }
      const { rows: routines } = await client.query(
        'SELECT routine_type FROM information_schema.routines WHERE routine_schema = $1 AND routine_name = $2',
        ['public', object],
      )
      if (routines.length > 0) return { kind: 'function' as const, ddl: `-- Native definition for ${object} is not available.` }
      return syntheticDdl(pgDriver, input, database, object, 'table')
    })
  },
  async query(input, database, sql) {
    return withPg(input, database, async (client) => {
      const result = await client.query(sql)
      if (result.fields && result.fields.length > 0) {
        return {
          kind: 'rows' as const,
          columns: result.fields.map((field) => field.name),
          rows: result.rows.slice(0, 500).map((row: Record<string, unknown>) => Object.values(row).map(normalizeCell)),
          truncated: result.rows.length > 500,
        }
      }
      return { kind: 'update' as const, affectedRows: result.rowCount ?? 0, changedRows: 0, insertId: 0 }
    })
  },
}

/* -------------------------------- DM8 ------------------------------------ */

async function withDm<T>(input: DatabaseConnectionInput, fn: (connection: dmdb.Connection) => Promise<T>): Promise<T> {
  const connection = await dmdb.getConnection({
    user: input.user,
    password: input.password,
    connectString: `${input.host}:${input.port}`,
    connectTimeout: 10_000,
    outFormat: dmdb.OUT_FORMAT_OBJECT,
  })
  try {
    return await fn(connection)
  } finally {
    await connection.close().catch(() => {})
  }
}

const dmDriver: DbDriver = {
  async test(input) {
    return withDm(input, async (connection) => {
      const result = await connection.execute('SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1', [])
      const rows = result.rows as Record<string, unknown>[] | undefined
      return { serverVersion: `DM ${s(rows?.[0]?.BANNER ?? '')}` }
    })
  },
  async databases(input) {
    return withDm(input, async (connection) => {
      const result = await connection.execute('SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME', [])
      const rows = result.rows as Record<string, unknown>[] | undefined
      return (rows ?? []).map((row) => s(row.USERNAME)).filter((name) => name !== '')
    })
  },
  async objects(input, database, kind) {
    const schema = database || input.user.toUpperCase()
    const typeMap: Record<DbObjectKind, string> = {
      tables: 'TABLE',
      views: 'VIEW',
      functions: 'FUNCTION',
      procedures: 'PROCEDURE',
      triggers: 'TRIGGER',
    }
    return withDm(input, async (connection) => {
      const result = await connection.execute(
        'SELECT object_name AS NAME, object_type AS TYPE FROM ALL_OBJECTS WHERE owner = :1 AND object_type = :2 ORDER BY object_name',
        [schema, typeMap[kind]],
      )
      const rows = result.rows as Record<string, unknown>[] | undefined
      return (rows ?? []).map((row) => ({ name: s(row.NAME), type: s(row.TYPE), comment: '' }))
    })
  },
  async columns(input, database, object) {
    const schema = database || input.user.toUpperCase()
    return withDm(input, async (connection) => {
      const result = await connection.execute(
        `SELECT c.column_name AS NAME, c.data_type AS DATA_TYPE, c.nullable AS NULLABLE, COALESCE(c.data_default, '') AS DATA_DEFAULT, COALESCE(cc.comments, '') AS COMMENTS FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id`,
        [schema, object],
      )
      const rows = result.rows as Record<string, unknown>[] | undefined
      return (rows ?? []).map((row) => ({ name: s(row.NAME), dataType: s(row.DATA_TYPE), nullable: s(row.NULLABLE) === 'Y', defaultValue: s(row.DATA_DEFAULT), comment: s(row.COMMENTS) }))
    })
  },
  async keys(input, database, object) {
    const schema = database || input.user.toUpperCase()
    return withDm(input, async (connection) => {
      const result = await connection.execute(
        'SELECT c.constraint_name AS NAME, c.constraint_type AS TYPE, col.column_name AS COLUMN_NAME FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS col ON c.owner = col.owner AND c.constraint_name = col.constraint_name WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.constraint_name, col.position',
        [schema, object],
      )
      const rows = result.rows as Record<string, unknown>[] | undefined
      const map = new Map<string, DbKeyInfo>()
      for (const row of rows ?? []) {
        const name = s(row.NAME)
        const existing = map.get(name)
        if (existing) existing.columns.push(s(row.COLUMN_NAME))
        else map.set(name, { name, type: s(row.TYPE), columns: [s(row.COLUMN_NAME)] })
      }
      return [...map.values()]
    })
  },
  async indexes(input, database, object) {
    const schema = database || input.user.toUpperCase()
    return withDm(input, async (connection) => {
      const result = await connection.execute(
        'SELECT i.index_name AS NAME, i.uniqueness AS UNIQUENESS, ic.column_name AS COLUMN_NAME FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic ON i.owner = ic.index_owner AND i.index_name = ic.index_name WHERE i.owner = :1 AND i.table_name = :2 ORDER BY i.index_name, ic.column_position',
        [schema, object],
      )
      const rows = result.rows as Record<string, unknown>[] | undefined
      const map = new Map<string, DbIndexInfo>()
      for (const row of rows ?? []) {
        const name = s(row.NAME)
        const existing = map.get(name)
        if (existing) existing.columns.push(s(row.COLUMN_NAME))
        else map.set(name, { name, unique: s(row.UNIQUENESS) === 'UNIQUE', columns: [s(row.COLUMN_NAME)] })
      }
      return [...map.values()]
    })
  },
  async ddl(input, database, object) {
    const schema = database || input.user.toUpperCase()
    return withDm(input, async (connection) => {
      try {
        const result = await connection.execute(
          'SELECT DBMS_METADATA.GET_DDL(\'TABLE\', :1, :2) AS DDL FROM DUAL',
          [object, schema],
        )
        const rows = result.rows as Record<string, unknown>[] | undefined
        const ddl = s(rows?.[0]?.DDL)
        if (ddl !== '') return { kind: 'table' as const, ddl }
      } catch {
        return syntheticDdl(dmDriver, input, database, object, 'table')
      }
      return syntheticDdl(dmDriver, input, database, object, 'table')
    })
  },
  async query(input, database, sql) {
    void database
    return withDm(input, async (connection) => {
      const result = await connection.execute(sql, [], { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 501 })
      const rows = result.rows as Record<string, unknown>[] | undefined
      if (rows && rows.length > 0) {
        const columns = ((result.metaData ?? []) as { name: string }[]).map((m) => s(m.name))
        return {
          kind: 'rows' as const,
          columns,
          rows: rows.slice(0, 500).map((row) => Object.values(row).map(normalizeCell)),
          truncated: rows.length > 500,
        }
      }
      if (result.metaData && result.metaData.length > 0) {
        return { kind: 'rows' as const, columns: ((result.metaData ?? []) as { name: string }[]).map((m) => s(m.name)), rows: [], truncated: false }
      }
      return { kind: 'update' as const, affectedRows: result.rowsAffected ?? 0, changedRows: 0, insertId: 0 }
    })
  },
}

function driverFor(engine: DbEngine): DbDriver {
  if (engine === 'postgresql') return pgDriver
  if (engine === 'dm') return dmDriver
  return mysqlDriver
}

/* ------------------------------- Routes ---------------------------------- */

export function buildDatabaseApi(): Record<string, (payload: unknown) => Promise<unknown>> {
  return {
    'db.test': async (payload) => {
      const input = connectionInputOf(payload, false)
      try {
        return await driverFor(input.engine).test(input)
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.databases': async (payload) => {
      const input = connectionInputOf(payload, false)
      try {
        return { databases: await driverFor(input.engine).databases(input) }
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.objects': async (payload) => {
      const input = connectionInputOf(payload, true)
      const kind = optionalString(payload, 'kind') as DbObjectKind | undefined
      const validKinds = new Set<DbObjectKind>(['tables', 'views', 'functions', 'procedures', 'triggers'])
      if (kind === undefined || !validKinds.has(kind)) {
        throw new SidebarError('bad-request', 'missing or invalid "kind"')
      }
      try {
        return { objects: await driverFor(input.engine).objects(input, input.database ?? '', kind) }
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.columns': async (payload) => {
      const input = connectionInputOf(payload, true)
      const object = requireString(payload, 'object')
      try {
        return { columns: await driverFor(input.engine).columns(input, input.database ?? '', object) }
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.keys': async (payload) => {
      const input = connectionInputOf(payload, true)
      const object = requireString(payload, 'object')
      try {
        return { keys: await driverFor(input.engine).keys(input, input.database ?? '', object) }
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.indexes': async (payload) => {
      const input = connectionInputOf(payload, true)
      const object = requireString(payload, 'object')
      try {
        return { indexes: await driverFor(input.engine).indexes(input, input.database ?? '', object) }
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.ddl': async (payload) => {
      const input = connectionInputOf(payload, true)
      const object = requireString(payload, 'object')
      try {
        return await driverFor(input.engine).ddl(input, input.database ?? '', object)
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.tables': async (payload) => {
      const input = connectionInputOf(payload, true)
      try {
        const objects = await driverFor(input.engine).objects(input, input.database ?? '', 'tables')
        return { tables: objects.map((o) => ({ name: o.name, type: o.type, rows: null, comment: o.comment })) }
      } catch (error) {
        throw errorOf(error)
      }
    },

    'db.query': async (payload) => {
      const input = connectionInputOf(payload, true)
      const sql = requireString(payload, 'sql').trim()
      if (sql === '') throw new SidebarError('bad-request', 'SQL must not be empty')
      try {
        return await driverFor(input.engine).query(input, input.database ?? '', sql)
      } catch (error) {
        throw errorOf(error)
      }
    },
  }
}
