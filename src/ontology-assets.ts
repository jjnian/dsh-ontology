/**
 * Workspace asset ingestion for the ontology lineage graph.
 *
 * The first pass is intentionally conservative: PDF/Word/Excel documents are
 * turned into text/tables, and only obvious headings, definitions, attributes,
 * and rules become ontology candidates. Rows and unstructured prose are not
 * promoted to classes automatically.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import type { LineageEdge, LineageGraph, LineageNode } from './client/lineage/lineage-types.ts'

export type AssetKind = 'pdf' | 'word' | 'sheet' | 'text' | 'sql'

export interface WorkspaceAssetListing {
  assets: string[]
  truncated: boolean
}

export interface AssetExtractionResult {
  graph: LineageGraph
  errors: { path: string; message: string }[]
}

const ASSET_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.md', '.txt', '.sql'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache'])

function normalizeAsset(relativePath: string): { path: string; kind: AssetKind } | undefined {
  const extension = extname(relativePath).toLowerCase()
  if (!ASSET_EXTENSIONS.has(extension)) return undefined
  const kind: AssetKind = extension === '.pdf'
    ? 'pdf'
    : extension === '.docx'
      ? 'word'
      : extension === '.sql'
        ? 'sql'
        : extension === '.xlsx' || extension === '.xls' || extension === '.csv'
        ? 'sheet'
        : 'text'
  return { path: relativePath.split(sep).join('/'), kind }
}

/** List supported workspace documents in path-stable order. */
export async function listWorkspaceAssets(root: string, maxAssets = 200): Promise<WorkspaceAssetListing> {
  const assets = new Set<string>()
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (assets.size >= maxAssets) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        await walk(join(dir, entry.name))
        if (truncated) return
        continue
      }
      if (!entry.isFile()) continue
      const candidate = normalizeAsset(relative(root, join(dir, entry.name)))
      if (candidate !== undefined) assets.add(candidate.path)
    }
  }

  await walk(root)
  return { assets: [...assets].sort(), truncated }
}

function idFor(prefix: string, source: string, label: string): string {
  return `${prefix}:${Buffer.from(`${source}#${label}`, 'utf8').toString('base64url')}`
}

function pushNode(nodes: LineageNode[], node: LineageNode): void {
  if (nodes.some((existing) => existing.id === node.id)) return
  nodes.push(node)
}

function pushEdge(edges: LineageEdge[], edge: LineageEdge): void {
  if (edges.some((existing) => existing.id === edge.id)) return
  edges.push(edge)
}

function nodeTypeForHeading(label: string): string {
  return /流程|步骤|pipeline|process/i.test(label) ? 'process' : 'class'
}

function isRuleLine(line: string): boolean {
  return /必须|应当|不得|禁止|不能|不允许|仅限|should|must|must not/i.test(line)
}

function definitionOf(line: string): { label: string; description: string } | undefined {
  const match = line.match(/^\s*([^\s：:，,。]{1,30})\s*(?:是指|指的是|定义[:：])\s*(.{4,})$/)
  if (match === null) return undefined
  return { label: match[1]!.trim(), description: match[2]!.trim() }
}

function quotedIdentifier(identifier: string): string {
  return identifier.replace(/^[`"[]+|[`"\]]+$/g, '')
}

function identifierHead(identifier: string): string {
  const clean = quotedIdentifier(identifier)
  const dotIndex = clean.lastIndexOf('.')
  return dotIndex >= 0 ? clean.slice(dotIndex + 1) : clean
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/#[^\r\n]*/g, ' ')
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!
    if (quote !== undefined) {
      current += character
      if (character === quote) {
        const next = sql[index + 1]
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      current += character
      continue
    }
    if (character === ';') {
      if (current.trim() !== '') statements.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (current.trim() !== '') statements.push(current.trim())
  return statements
}

function ensureSqlNode(
  nodes: LineageNode[],
  label: string,
  type: string,
  source: string,
  properties: Record<string, unknown> = {},
): string {
  const id = idFor(type, source, label)
  pushNode(nodes, {
    id,
    label,
    type,
    source: 'derived',
    domain: 'SQL',
    evidence: source,
    properties: { sourceAsset: source, ...properties },
  })
  return id
}

function cteNames(statement: string): Set<string> {
  const names = new Set<string>()
  const withMatch = statement.match(/^\s*WITH\s+(?:RECURSIVE\s+)?([\s\S]+?)\s+(?:SELECT|INSERT|UPDATE|DELETE)\b/i)
  if (withMatch === null) return names
  for (const match of withMatch[1]!.matchAll(/([`"[]?[\w$]+[`"\]]?)\s*\(/g)) {
    names.add(identifierHead(match[1]!).toLowerCase())
  }
  return names
}

function referencedSourceTables(statement: string): string[] {
  const excluded = cteNames(statement)
  const found = new Set<string>()
  const sourcePatterns = [
    /(?:\bFROM\b|\bJOIN\b|\bUSING\b)\s+[`"[]?([\w$.]+)[`"\]]?/gi,
    /\bUPDATE\s+[`"[]?([\w$.]+)[`"\]]?\s+FROM\b/gi,
  ]
  for (const pattern of sourcePatterns) {
    for (const match of statement.matchAll(pattern)) {
      const name = identifierHead(match[1]!)
      if (name === '' || /^(select|where|on|and|or|set|values|lateral|unnest|dual)$/i.test(name)) continue
      if (excluded.has(name.toLowerCase())) continue
      found.add(name)
    }
  }
  return [...found]
}

function targetTableOf(statement: string): string | undefined {
  const patterns = [
    /CREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW\s+[`"[]?([\w$.]+)[`"\]]?/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+[`"[]?([\w$.]+)[`"\]]?/i,
    /CREATE\s+(?:GLOBAL\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w$.]+)[`"\]]?/i,
    /INSERT\s+INTO\s+[`"[]?([\w$.]+)[`"\]]?/i,
    /MERGE\s+INTO\s+[`"[]?([\w$.]+)[`"\]]?/i,
    /UPDATE\s+[`"[]?([\w$.]+)[`"\]]?/i,
    /DELETE\s+FROM\s+[`"[]?([\w$.]+)[`"\]]?/i,
  ]
  for (const pattern of patterns) {
    const match = statement.match(pattern)
    if (match !== null) return identifierHead(match[1]!)
  }
  return undefined
}

/** Extract deterministic table-to-table lineage from executable SQL. */
export function extractOntologyFromSql(sql: string, source: string): LineageGraph {
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const statements = splitSqlStatements(stripSqlComments(sql))

  for (const statement of statements) {
    const target = targetTableOf(statement)
    if (target === undefined) continue
    const targetId = ensureSqlNode(nodes, target, 'class', source, {
      derivedKind: /^CREATE/i.test(statement) ? 'ddl' : 'sql-target',
    })
    const sources = referencedSourceTables(statement)
    for (const table of sources) {
      const tableId = ensureSqlNode(nodes, table, 'class', source)
      pushEdge(edges, {
        id: idFor('edge', source, `${table}|flows_to|${target}`),
        from: tableId,
        to: targetId,
        label: '数据流向',
        rel_type: 'flows_to',
        source: 'derived',
        confidence: 1,
        evidence: source,
        properties: { statement: statement.slice(0, 500) },
      })
    }
  }
  return { nodes, edges }
}

function mergeGraphs(primary: LineageGraph, secondary: LineageGraph): LineageGraph {
  const nodes = [...primary.nodes]
  const nodeIds = new Set(nodes.map((node) => node.id))
  for (const node of secondary.nodes) {
    if (!nodeIds.has(node.id)) {
      nodes.push(node)
      nodeIds.add(node.id)
    }
  }
  const edges = [...primary.edges]
  const edgeIds = new Set(edges.map((edge) => edge.id))
  for (const edge of secondary.edges) {
    if (!edgeIds.has(edge.id)) {
      edges.push(edge)
      edgeIds.add(edge.id)
    }
  }
  return { nodes, edges }
}

/** Extract conservative ontology candidates from CREATE TABLE / CREATE VIEW DDL. */
export function extractOntologyFromDdl(sql: string, source: string): LineageGraph {
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const tableColumns = new Map<string, string[]>()
  const tablePattern = /CREATE\s+(?:GLOBAL\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w$]+)[`"\]]?\s*\(([\s\S]*?)\)\s*(?:ENGINE|COMMENT|AS|;|$)/gi
  for (const match of sql.matchAll(tablePattern)) {
    const table = match[1]!
    const body = match[2]!
    const columnNames: string[] = []
    const tableComment = body.match(/(?:\)\s*)?COMMENT\s*=?\s*'([^']+)'/i)?.[1] ?? ''
    const tableId = idFor('class', source, table)
    pushNode(nodes, {
      id: tableId,
      label: table,
      type: 'class',
      source: 'derived',
      confidence: 1,
      domain: 'DDL',
      evidence: source,
      properties: { sourceAsset: source, description: tableComment },
    })
    for (const rawLine of body.split(/[\r\n;]+/)) {
      const line = rawLine.trim().replace(/,$/, '')
      if (line === '' || /^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT|INDEX|KEY)\b/i.test(line)) continue
      const column = line.match(/^[`"[]?([\w$]+)[`"\]]?\s+([A-Za-z][\w]*(?:\([^)]*\))?)/)
      if (column === null) continue
      const columnName = column[1]!
      const dataType = column[2]!
      columnNames.push(columnName)
      const comment = line.match(/COMMENT\s+'([^']*)'/i)?.[1] ?? ''
      const attributeId = idFor('attribute', source, `${table}.${columnName}`)
      pushNode(nodes, {
        id: attributeId,
        label: comment !== '' ? comment : columnName,
        type: 'attribute',
        source: 'derived',
        confidence: 1,
        domain: 'DDL',
        evidence: source,
        properties: { sourceAsset: source, dataType, primaryKey: /PRIMARY\s+KEY/i.test(line), nullable: !/NOT\s+NULL/i.test(line) },
      })
      pushEdge(edges, {
        id: idFor('edge', source, `${table}.${columnName}|attribute_of|${table}`),
        from: attributeId,
        to: tableId,
        label: '属性',
        rel_type: 'attribute_of',
        source: 'derived',
        confidence: 1,
        evidence: source,
      })
    }
    tableColumns.set(table, columnNames)
    const foreignPattern = /FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+[`"[]?([\w$]+)[`"\]]?\s*\(([^)]+)\)/gi
    for (const foreign of body.matchAll(foreignPattern)) {
      const target = foreign[2]!
      const targetId = idFor('class', source, target)
      pushNode(nodes, {
        id: targetId,
        label: target,
        type: 'class',
        source: 'derived',
        confidence: 1,
        domain: 'DDL',
        evidence: source,
        properties: { sourceAsset: source },
      })
      pushEdge(edges, {
        id: idFor('edge', source, `${table}|depends_on|${target}`),
        from: tableId,
        to: targetId,
        label: '关联',
        rel_type: 'depends_on',
        source: 'derived',
        confidence: 1,
        evidence: source,
      })
    }
  }

  const inferred = new Set(edges.filter((edge) => edge.rel_type === 'depends_on').map((edge) => `${edge.from}:${edge.to}`))
  const singular = (value: string): string => value.endsWith('ies')
    ? `${value.slice(0, -3)}y`
    : value.endsWith('ses') || value.endsWith('xes')
      ? value.slice(0, -2)
      : value.endsWith('s')
        ? value.slice(0, -1)
        : value
  for (const [childTable, columns] of tableColumns) {
    const childId = idFor('class', source, childTable)
    for (const column of columns) {
      const match = column.match(/^(.+?)(?:_?id|_?no|_?code)$/i)
      if (match === null) continue
      const root = match[1]!
      const normalizedRoot = root.toLowerCase().replace(/_/g, '')
      const parentTable = [...tableColumns.keys()].find((table) => {
        const normalizedTable = table.toLowerCase().replace(/_/g, '')
        return normalizedTable === normalizedRoot
          || normalizedTable === singular(normalizedRoot)
          || normalizedTable.replace(/s$/, '') === normalizedRoot
      })
      if (parentTable === undefined || parentTable === childTable) continue
      const parentColumn = tableColumns.get(parentTable)?.find((candidate) =>
        candidate === 'id' || candidate === `${parentTable}_id` || candidate.toLowerCase().endsWith('_id')) ?? 'id'
      const edgeId = idFor('edge', source, `${childTable}|depends_on|${parentTable}`)
      if (inferred.has(edgeId)) continue
      pushEdge(edges, {
        id: edgeId,
        from: childId,
        to: idFor('class', source, parentTable),
        label: '疑似关联',
        rel_type: 'depends_on',
        source: 'inferred',
        confidence: 0.5,
        evidence: source,
        properties: {
          inferenceMethod: 'naming-convention',
          childObject: childTable,
          childColumn: column,
          parentObject: parentTable,
          parentColumn,
          reviewStatus: 'candidate',
        },
      })
    }
  }

  const viewPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+[`"[]?([\w$]+)[`"\]]?\s+AS\s+([\s\S]+?)(?:;|$)/gi
  for (const match of sql.matchAll(viewPattern)) {
    const view = match[1]!
    const definition = match[2]!
    const viewId = idFor('class', source, view)
    pushNode(nodes, {
      id: viewId,
      label: view,
      type: 'class',
      source: 'derived',
      confidence: 1,
      domain: 'DDL',
      evidence: source,
      properties: { sourceAsset: source, description: '视图派生类' },
    })
    const referenced = new Set<string>()
    const fromPattern = /(?:FROM|JOIN)\s+[`"[]?([\w$]+)[`"\]]?/gi
    for (const reference of definition.matchAll(fromPattern)) {
      const table = reference[1]!
      if (referenced.has(table) || /^(select|where|on|and|or)$/i.test(table)) continue
      referenced.add(table)
      const tableId = idFor('class', source, table)
      pushNode(nodes, {
        id: tableId,
        label: table,
        type: 'class',
        source: 'derived',
        confidence: 1,
        domain: 'DDL',
        evidence: source,
        properties: { sourceAsset: source },
      })
      pushEdge(edges, {
        id: idFor('edge', source, `${view}|derives_from|${table}`),
        from: viewId,
        to: tableId,
        label: '派生',
        rel_type: 'derives_from',
        source: 'inferred',
        evidence: source,
      })
    }
  }
  return mergeGraphs({ nodes, edges }, extractOntologyFromSql(sql, source))
}

/**
 * Extract conservative ontology candidates from already-parsed text.
 * Heading hierarchy is mapped to class inheritance; obvious definitions and
 * rule sentences are kept as classes/rules with document evidence.
 */
export function extractOntologyFromText(text: string, source: string): LineageGraph {
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const stack: { depth: number; label: string }[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    const heading = line.match(/^(#{1,6})\s+(.{1,60})$/)
    if (heading !== null) {
      const depth = heading[1]!.length
      const label = heading[2]!.trim()
      const id = idFor('class', source, label)
      const type = nodeTypeForHeading(label)
      pushNode(nodes, {
        id,
        label,
        type,
        source: 'inferred',
        domain: '文档',
        evidence: source,
        properties: { sourceAsset: source },
      })
      while (stack.length > 0 && stack.at(-1)!.depth >= depth) stack.pop()
      const parent = stack.at(-1)
      if (parent !== undefined && type === 'class') {
        pushEdge(edges, {
          id: idFor('edge', source, `${label}|is_a|${parent.label}`),
          from: id,
          to: idFor('class', source, parent.label),
          label: '继承',
          rel_type: 'is_a',
          source: 'inferred',
          evidence: source,
        })
      }
      stack.push({ depth, label })
      continue
    }

    const definition = definitionOf(line)
    if (definition !== undefined) {
      const id = idFor('class', source, definition.label)
      pushNode(nodes, {
        id,
        label: definition.label,
        type: 'class',
        source: 'inferred',
        domain: '文档',
        evidence: source,
        properties: { sourceAsset: source, description: definition.description },
      })
      continue
    }

    if (isRuleLine(line)) {
      const label = line.slice(0, 80)
      const id = idFor('rule', source, label)
      pushNode(nodes, {
        id,
        label,
        type: 'rule',
        source: 'inferred',
        domain: '文档',
        evidence: source,
        properties: { sourceAsset: source },
      })
      const owner = stack.at(-1)
      if (owner !== undefined) {
        pushEdge(edges, {
          id: idFor('edge', source, `${label}|constrains|${owner.label}`),
          from: id,
          to: idFor('class', source, owner.label),
          label: '约束',
          rel_type: 'constrains',
          source: 'inferred',
          evidence: source,
        })
      }
    }
  }

  return { nodes, edges }
}

function extractWorkbookText(matrix: unknown[][], source: string, sheetName: string): LineageGraph {
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const classId = idFor('class', source, sheetName)
  pushNode(nodes, {
    id: classId,
    label: sheetName,
    type: 'class',
    source: 'inferred',
    domain: '资料',
    evidence: source,
    properties: { sourceAsset: source, sheet: sheetName },
  })
  for (const header of matrix[0] ?? []) {
    const label = String(header ?? '').trim()
    if (label === '') continue
    const attributeId = idFor('attribute', source, `${sheetName}.${label}`)
    pushNode(nodes, {
      id: attributeId,
      label,
      type: 'attribute',
      source: 'inferred',
      domain: '资料',
      evidence: source,
      properties: { sourceAsset: source, sheet: sheetName },
    })
    pushEdge(edges, {
      id: idFor('edge', source, `${sheetName}.${label}|attribute_of|${sheetName}`),
      from: attributeId,
      to: classId,
      label: '属性',
      rel_type: 'attribute_of',
      source: 'inferred',
      evidence: source,
    })
  }
  return { nodes, edges }
}

/** Parse one workspace document into candidate ontology nodes/edges. */
export async function readDocumentOntology(absolutePath: string, relativePath: string): Promise<LineageGraph> {
  const asset = normalizeAsset(relativePath)
  if (asset === undefined) throw new Error(`unsupported document: ${relativePath}`)
  const info = await stat(absolutePath)
  if (!info.isFile()) throw new Error(`not a file: ${relativePath}`)
  if (info.size > 20 * 1024 * 1024) throw new Error(`document too large: ${relativePath}`)

  const kind = asset.kind
  if (kind === 'pdf') {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await readFile(absolutePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return extractOntologyFromText(result.text, relativePath)
    } finally {
      await parser.destroy()
    }
  }

  if (kind === 'word') {
    const mammoth = await import('mammoth')
    const buffer = await readFile(absolutePath)
    const result = await mammoth.default.convertToHtml({ buffer })
    const markdown = result.value
      .replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n${'#'.repeat(Number(level))} `)
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
    return extractOntologyFromText(markdown, relativePath)
  }

  if (kind === 'sheet') {
    const XLSX = await import('xlsx')
    const buffer = await readFile(absolutePath)
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const graphs = workbook.SheetNames.slice(0, 20).map((sheetName) => {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, { header: 1, defval: '' })
      return extractWorkbookText(rows.slice(0, 100), relativePath, sheetName)
    })
    return { nodes: graphs.flatMap((graph) => graph.nodes), edges: graphs.flatMap((graph) => graph.edges) }
  }

  if (kind === 'sql') {
    const content = await readFile(absolutePath, 'utf8')
    return extractOntologyFromDdl(content, relativePath)
  }

  const content = await readFile(absolutePath, 'utf8')
  return extractOntologyFromText(content, relativePath)
}

/** Extract several assets, skipping unreadable files instead of failing the batch. */
export async function readAssetOntologies(root: string, paths: string[], maxAssets = 50): Promise<AssetExtractionResult> {
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const errors: { path: string; message: string }[] = []

  for (const path of paths.slice(0, maxAssets)) {
    try {
      const graph = await readDocumentOntology(join(root, path), path)
      nodes.push(...graph.nodes)
      edges.push(...graph.edges)
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return { graph: { nodes, edges }, errors }
}
