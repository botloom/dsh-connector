/** SQL 连接：PostgreSQL / MySQL / SQLite，统一成 { columns, rows, rowCount }。 */

import { readSecret } from '../secret.js'
import { assertTcpReachable } from './tcpcheck.js'
import { assertSafeWrite, classifySql } from '../sqlguard.js'

async function loadPackage(spec, hint) {
  try {
    return await import(spec)
  } catch (error) {
    const message = `${error?.message ?? error}`
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(message)) {
      throw new Error(`${hint}；原始错误：${message}`)
    }
    throw error
  }
}

function toMatrix(columns, objects) {
  return objects.map((row) => columns.map((column) => row[column]))
}

async function runPostgres(conn, sql, values, options) {
  const mod = await loadPackage('pg', 'PostgreSQL 需要 pg 驱动：在插件目录执行 npm install pg')
  const pg = mod.default ?? mod
  if (typeof pg?.Pool !== 'function') throw new Error('pg 驱动不可用：找不到 Pool 导出')

  const config = {
    host: conn.host,
    port: conn.port,
    database: options.database,
    user: conn.user,
    password: readSecret(conn),
    application_name: 'dsh-ws-connections',
    max: 1,
    connectionTimeoutMillis: options.timeoutMs,
    statement_timeout: options.timeoutMs,
    query_timeout: options.timeoutMs,
  }
  if (conn.ssl === true) {
    config.ssl = { rejectUnauthorized: conn.sslRejectUnauthorized !== false }
  } else if (typeof conn.ssl === 'object' && conn.ssl !== null) {
    config.ssl = conn.ssl
  }

  const pool = new pg.Pool(config)
  pool.on('error', () => {})
  try {
    const result = await pool.query({ text: sql, values, rowMode: 'array' })
    const columns = (result.fields ?? []).map((field) => field.name)
    return {
      columns,
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? (result.rows?.length ?? 0),
      notice: typeof result.command === 'string' ? result.command : undefined,
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

async function runMysql(conn, sql, values, options) {
  const mod = await loadPackage('mysql2/promise', 'MySQL 需要 mysql2 驱动：在插件目录执行 npm install mysql2')
  const mysql = mod.default ?? mod
  if (typeof mysql?.createConnection !== 'function') {
    throw new Error('mysql2 驱动不可用：找不到 createConnection 导出')
  }

  const connection = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    database: options.database,
    user: conn.user,
    password: readSecret(conn),
    connectTimeout: options.timeoutMs,
    multipleStatements: false,
    dateStrings: true,
    charset: 'utf8mb4',
    ...(conn.ssl === true ? { ssl: { rejectUnauthorized: conn.sslRejectUnauthorized !== false } } : {}),
  })
  try {
    const [result, fields] = await connection.query({ sql, values, timeout: options.timeoutMs })
    if (Array.isArray(result)) {
      const columns = (fields ?? []).map((field) => field.name)
      return { columns, rows: toMatrix(columns, result), rowCount: result.length }
    }
    return {
      columns: [],
      rows: [],
      rowCount: result?.affectedRows ?? 0,
      notice: `affectedRows=${result?.affectedRows ?? 0}`,
    }
  } finally {
    await connection.end().catch(() => {})
  }
}

async function querySqlite(conn, sql, values, options) {
  const mod = await loadPackage('node:sqlite', '当前 Node 运行时没有内置 node:sqlite')
  const { DatabaseSync } = mod
  if (typeof DatabaseSync !== 'function') throw new Error('node:sqlite 不可用')

  const db = new DatabaseSync(conn.file, { readOnly: options.readOnly })
  try {
    const statement = db.prepare(sql)
    if (options.readOnly) {
      const objects = statement.all(...values)
      let columns = []
      try {
        columns = statement.columns().map((column) => column.name)
      } catch {
        columns = Object.keys(objects[0] ?? {})
      }
      return { columns, rows: toMatrix(columns, objects), rowCount: objects.length }
    }
    const info = statement.run(...values)
    return { columns: [], rows: [], rowCount: info?.changes ?? 0, notice: `changes=${info?.changes ?? 0}` }
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 执行一条 SQL。
 *
 * @param conn 归一化后的连接
 * @param request { sql, params, limit, write }
 * @param options { timeoutMs }
 */
export async function querySql(conn, request, options) {
  const parsed = classifySql(request.sql)
  const values = Array.isArray(request.params) ? request.params : []
  const writeRequested = request.write === true
  const writeAllowed = conn.allowWrite === true && writeRequested

  if (!parsed.readOnly && !writeAllowed) {
    if (conn.allowWrite !== true) {
      throw new Error(
        `拒绝执行写语句（${parsed.head}）：连接 ${conn.name} 是只读的。确认要写入时，把它的配置改成 allowWrite: true，再在调用时传 write: true。`,
      )
    }
    throw new Error(`拒绝执行写语句（${parsed.head}）：确认要写入时，在调用时传 write: true。`)
  }
  if (!parsed.readOnly) assertSafeWrite(parsed.sql, { allowDdl: conn.allowDdl === true, name: conn.name })

  const requestedDatabase = typeof request.database === 'string' ? request.database.trim() : ''
  const targetDatabase = requestedDatabase !== '' ? requestedDatabase : conn.database
  if (
    (conn.kind === 'postgres' || conn.kind === 'mysql') &&
    (targetDatabase === undefined || targetDatabase === '')
  ) {
    throw new Error(
      `连接 ${conn.name} 还没有指定库：先在面板里选一个库，或在调用时传 database（库列表可通过 listDatabases 获取）。`,
    )
  }

  const readOnly = !writeAllowed
  const startedAt = Date.now()
  const sqlOptions = { timeoutMs: options.timeoutMs, readOnly, database: targetDatabase }

  let result
  if (conn.kind === 'postgres') result = await runPostgres(conn, parsed.sql, values, sqlOptions)
  else if (conn.kind === 'mysql') result = await runMysql(conn, parsed.sql, values, sqlOptions)
  else if (conn.kind === 'sqlite') result = await querySqlite(conn, parsed.sql, values, sqlOptions)
  else throw new Error(`连接 ${conn.name} 不是 SQL 连接（kind=${conn.kind}）`)

  return { ...result, elapsedMs: Date.now() - startedAt, head: parsed.head }
}

/** 列出可用的库（PostgreSQL/MySQL）或表（SQLite）。 */
export async function listDatabases(conn, options) {
  const base = { ...options, database: conn.database }

  if (conn.kind === 'postgres') {
    const result = await runPostgres(
      conn,
      'select datname from pg_database where not datistemplate order by datname',
      [],
      base,
    )
    return { kind: 'databases', items: result.rows.map((row) => `${row[0]}`) }
  }

  if (conn.kind === 'mysql') {
    const result = await runMysql(conn, 'show databases', [], base)
    return { kind: 'databases', items: result.rows.map((row) => `${row[0]}`) }
  }

  if (conn.kind === 'sqlite') {
    const mod = await loadPackage('node:sqlite', '当前 Node 运行时没有内置 node:sqlite')
    const db = new mod.DatabaseSync(conn.file, { readOnly: true })
    try {
      const rows = db
        .prepare(
          "select name from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name",
        )
        .all()
      return { kind: 'tables', items: rows.map((row) => `${row.name}`) }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  throw new Error(`连接 ${conn.name} 不是 SQL 连接`)
}

/** 连通性探测：连上并执行一个最小查询；没配库时顺便数一下可用库/表。 */
export async function probeSql(conn, options) {
  const startedAt = Date.now()
  const probe = { ...options, database: conn.database }

  if (conn.kind === 'postgres' || conn.kind === 'mysql') {
    await assertTcpReachable(conn.host, conn.port, options.timeoutMs)
    const result =
      conn.kind === 'postgres'
        ? await runPostgres(conn, 'select version() as v', [], probe)
        : await runMysql(conn, 'select version() as v', [], probe)
    let detail = `${result.rows?.[0]?.[0] ?? (conn.kind === 'postgres' ? 'PostgreSQL' : 'MySQL')}`
    if (!conn.database) {
      try {
        const list = await listDatabases(conn, options)
        detail += ` · ${list.items.length} ${list.kind === 'databases' ? '个库' : '张表'}`
      } catch {
        /* 没有列表权限也不影响探测结论 */
      }
    }
    return { detail, elapsedMs: Date.now() - startedAt }
  }

  if (conn.kind === 'sqlite') {
    const mod = await loadPackage('node:sqlite', '当前 Node 运行时没有内置 node:sqlite')
    const db = new mod.DatabaseSync(conn.file, { readOnly: true })
    try {
      const row = db.prepare('select sqlite_version() as v').get()
      return { detail: `SQLite ${row?.v ?? ''}`, elapsedMs: Date.now() - startedAt }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  throw new Error(`连接 ${conn.name} 不是 SQL 连接`)
}
