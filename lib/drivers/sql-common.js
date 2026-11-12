/**
 * SQL 驱动共用的动作实现：PostgreSQL / MySQL / SQLite 只是 validate 与
 * 默认端口不同，执行逻辑完全一致（底层仍在 lib/connectors/sql.js）。
 */

import { listDatabases, probeSql, querySql } from '../connectors/sql.js'
import { clampNumber, jsonSafe, pickNumber } from '../driver-kit.js'
import { formatDuration, formatTable } from '../format.js'

export const sqlActions = [
  {
    id: 'query',
    label: '执行 SQL',
    primary: true,
    params: [
      { name: 'sql', label: 'SQL', type: 'text', required: true },
      { name: 'params', label: '绑定参数', type: 'array', hint: '按顺序对应 $1/$2 或 ?' },
      { name: 'database', label: '库名', type: 'text' },
      { name: 'limit', label: '返回行数', type: 'number' },
      { name: 'write', label: '允许写', type: 'boolean' },
    ],
  },
  { id: 'databases', label: '列出数据库/表', params: [] },
]

export function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

export function maxRowsOf(opts) {
  return clampNumber(opts?.maxRows, 1, 500, 50)
}

export async function queryAction(conn, args, opts) {
  const sql = typeof args?.sql === 'string' ? args.sql : ''
  if (sql.trim() === '') throw new Error('sql 不能为空')
  const limit = clampNumber(args?.limit, 1, 500, maxRowsOf(opts))

  const result = await querySql(
    conn,
    {
      sql,
      params: args?.params,
      write: args?.write === true,
      database: args?.database,
    },
    { timeoutMs: timeoutOf(conn, opts) },
  )

  const header = `${conn.name} · ${result.head} · ${formatDuration(result.elapsedMs)}`
  if (result.columns.length === 0) {
    return {
      text: `${header} · ${result.notice ?? '执行完成'}`,
      meta: { head: result.head, rowCount: result.rowCount ?? 0, elapsedMs: result.elapsedMs },
    }
  }

  const rows = result.rows.slice(0, limit)
  const total = Math.max(result.rowCount ?? 0, result.rows.length)
  const omitted = result.rows.length > rows.length ? `\n（结果共 ${total} 行，只显示前 ${rows.length} 行）` : ''
  return {
    text: `${header} · ${total} 行\n${formatTable(result.columns, rows, { maxRows: limit })}${omitted}`,
    table: {
      columns: result.columns,
      rows: rows.map((row) => row.map(jsonSafe)),
    },
    meta: {
      head: result.head,
      rowCount: total,
      shown: rows.length,
      truncated: result.rows.length > rows.length,
      elapsedMs: result.elapsedMs,
    },
  }
}

export async function databasesAction(conn, _args, opts) {
  const list = await listDatabases(conn, { timeoutMs: timeoutOf(conn, opts) })
  const noun = list.kind === 'databases' ? '个数据库' : '张表'
  const lines = list.items.length === 0 ? [`${conn.name} · 没有${noun.slice(1)}`] : list.items.map((item) => `- ${item}`)
  return {
    text: [`${conn.name} · ${list.items.length} ${noun}`, ...lines].join('\n'),
    table: { columns: [list.kind === 'databases' ? 'database' : 'table'], rows: list.items.map((item) => [item]) },
    meta: { kind: list.kind, count: list.items.length },
  }
}

export function sqlActionNames() {
  return sqlActions.map((action) => action.id)
}

export async function probeSqlConnection(conn, opts) {
  return probeSql(conn, { timeoutMs: timeoutOf(conn, opts) })
}

export function describeSqlConnection(conn, label) {
  const who = conn.user ? `${conn.user}@` : ''
  const database = conn.database ? `/${conn.database}` : ''
  return `${label} ${who}${conn.host}:${conn.port}${database}${conn.allowWrite ? ' 可写' : ' 只读'}`
}

export function unsupportedSqlAction(conn, label, action) {
  return new Error(`${label} 连接 ${conn.name} 不支持动作「${action}」，可用：${sqlActionNames().join('/')}`)
}
