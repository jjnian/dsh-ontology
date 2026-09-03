export type DatabaseFeature = 'test' | 'databases' | 'objects' | 'columns' | 'keys' | 'indexes' | 'ddl' | 'query'

export interface DatabaseCompatibility {
  engine: 'mysql' | 'postgresql' | 'dm'
  label: string
  versions: string
  driver: string
  status: 'supported' | 'planned'
  features: DatabaseFeature[]
  notes: string[]
}

const CORE: DatabaseFeature[] = ['test', 'databases', 'objects', 'columns', 'keys', 'indexes', 'ddl', 'query']

export const DATABASE_COMPATIBILITY: DatabaseCompatibility[] = [
  {
    engine: 'mysql', label: 'MySQL', versions: '5.7 / 8.0+', driver: 'mysql2', status: 'supported', features: CORE,
    notes: ['查询结果截断为 500 行', 'DDL 使用 SHOW CREATE 语句', 'JSON 列按文本展示'],
  },
  {
    engine: 'postgresql', label: 'PostgreSQL', versions: '10+', driver: 'pg', status: 'supported', features: CORE,
    notes: ['默认读取 public schema', '表 DDL 由元数据合成', '结果截断为 500 行'],
  },
  {
    engine: 'dm', label: '达梦 DM', versions: 'DM8', driver: 'dmdb', status: 'supported', features: CORE,
    notes: ['连接用户为默认 schema', '读取系统视图 ALL_*', '占位符使用 :1 语法'],
  },
]
