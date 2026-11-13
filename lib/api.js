/**
 * 面板背后的 JSON 接口。
 *
 * 连接是一个扁平池，不再按工作区区分。
 * 查询类接口（/query /redis /ssh /http /databases）和模型工具走同一批
 * 连接器，所以只读/危险命令等限制完全一致。
 * 连接里的 password / token 永远不出现在响应里（只回 hasPassword / hasToken）。
 */

import { describeConnection, resolveConnection, setPoolResolver } from './config.js'
import { probeConnection } from './connectors/index.js'
import { driverManifests, getDriver } from './drivers/index.js'
import { listDatabases, querySql } from './connectors/sql.js'
import { formatRedisReply, runRedis, splitCommandLine } from './connectors/redis.js'
import { runSsh } from './connectors/ssh.js'
import { runHttp } from './connectors/http.js'
import { applyImport, draftConnection, editConnection, editConfig, exportPayload } from './store.js'

export const API_PREFIX = '/wsconn/api'

const MAX_BODY = 256 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 回给客户端的连接：按驱动的 secretFields 隐藏密钥字段。
 * 仍然保留 hasPassword / hasToken（旧 UI 在用），另外给出通用的 hasSecrets。
 */
function redact(connection) {
  let driver
  try {
    driver = getDriver(connection.kind)
  } catch {
    driver = undefined
  }
  const secretFields =
    Array.isArray(driver?.secretFields) && driver.secretFields.length > 0
      ? driver.secretFields
      : ['password', 'token']
  const hidden = new Set(secretFields)

  const visible = {}
  for (const [key, value] of Object.entries(connection)) {
    if (!hidden.has(key)) visible[key] = value
  }

  const hasSecrets = {}
  for (const field of hidden) {
    hasSecrets[field] = typeof connection[field] === 'string' && connection[field] !== ''
  }

  return {
    ...visible,
    kindLabel: driver?.label ?? connection.kind,
    endpoint: describeConnection(connection),
    hasPassword: hasSecrets.password === true,
    hasToken: hasSecrets.token === true,
    secretFields: [...hidden],
    hasSecrets,
  }
}

function cell(value) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (type === 'number' || type === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex').slice(0, 64)}`
  try {
    const text = JSON.stringify(value)
    return text.length > 500 ? `${text.slice(0, 500)}…` : text
  } catch {
    return String(value)
  }
}

export function createApiHandler(ctx, state) {
  setPoolResolver((name) => resolveConnection(state.connections, name))
  const timeoutMs = state.defaultTimeoutMs

  function connectionOf(body) {
    return resolveConnection(state.connections, body?.name)
  }

  async function handleState(req, res) {
    sendJson(res, 200, {
      connections: state.connections.map(redact),
      timeoutMs: state.defaultTimeoutMs,
      maxRows: state.defaultMaxRows,
      // 驱动清单：UI 用它渲染「新建连接」的类型/表单/控制台动作
      kinds: driverManifests(),
    })
  }

  /**
   * 连通性测试：
   * - { name }                    测已保存的连接
   * - { name, connection }        测表单草稿（未保存即可测）；
   *   同名已保存连接会作为底，空字段不覆盖（密码留空照样能测）。
   */
  async function handleTest(req, res) {
    const body = await readJson(req)

    let connection
    if (body !== null && typeof body.connection === 'object' && body.connection !== null) {
      const wanted = typeof body.name === 'string' ? body.name.trim().toLowerCase() : ''
      const base =
        wanted === ''
          ? undefined
          : state.connections.find((item) => item.name.toLowerCase() === wanted)
      connection = draftConnection(base, body.connection, body.name)
    } else {
      connection = connectionOf(body)
    }

    try {
      const result = await probeConnection(connection, timeoutMs)
      sendJson(res, 200, {
        ok: true,
        name: connection.name,
        detail: result.detail,
        elapsedMs: result.elapsedMs,
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, name: connection.name, error: `${error?.message ?? error}` })
    }
  }

  async function handleConnection(req, res) {
    const body = await readJson(req)
    const message = await editConnection(ctx, {
      action: body.action,
      name: body.name,
      connection: body.connection,
      disabled: body.disabled,
    })
    sendJson(res, 200, { ok: true, message })
  }

  async function handleDatabases(req, res) {
    const body = await readJson(req)
    const connection = connectionOf(body)
    if (connection.kind !== 'postgres' && connection.kind !== 'mysql' && connection.kind !== 'sqlite') {
      throw new Error(`连接 ${connection.name} 不是数据库连接`)
    }
    const list = await listDatabases(connection, { timeoutMs: connection.timeoutMs ?? timeoutMs })
    sendJson(res, 200, { ok: true, kind: list.kind, items: list.items })
  }

  async function handleQuery(req, res) {
    const body = await readJson(req)
    const connection = connectionOf(body)
    const limit = Math.max(1, Math.min(500, Number(body.limit) || state.defaultMaxRows))
    const result = await querySql(
      connection,
      { sql: body.sql, params: body.params, write: body.write === true, database: body.database },
      { timeoutMs: connection.timeoutMs ?? timeoutMs },
    )
    const rows = result.rows.slice(0, limit).map((row) => row.map(cell))
    sendJson(res, 200, {
      ok: true,
      head: result.head,
      columns: result.columns,
      rows,
      rowCount: result.rowCount ?? result.rows.length,
      truncated: result.rows.length > rows.length,
      elapsedMs: result.elapsedMs,
      notice: result.notice ?? null,
    })
  }

  async function handleRedis(req, res) {
    const body = await readJson(req)
    const connection = connectionOf(body)
    const argv = splitCommandLine(body.command ?? '')
    if (argv.length === 0) throw new Error('Redis 命令为空')
    const value = await runRedis(connection, argv, { timeoutMs: connection.timeoutMs ?? timeoutMs })
    sendJson(res, 200, { ok: true, text: formatRedisReply(value) })
  }

  async function handleSsh(req, res) {
    const body = await readJson(req)
    const connection = connectionOf(body)
    const timeout = Math.max(1000, Math.min(120000, Number(body.timeoutMs) || (connection.timeoutMs ?? timeoutMs)))
    const result = await runSsh(connection, body.command ?? '', { timeoutMs: timeout })
    sendJson(res, 200, {
      ok: true,
      stdout: `${result.stdout}`.slice(0, 20000),
      stderr: `${result.stderr}`.slice(0, 8000),
      exitCode: result.exitCode,
      elapsedMs: result.elapsedMs,
    })
  }

  async function handleHttp(req, res) {
    const body = await readJson(req)
    const connection = connectionOf(body)
    if (connection.kind !== 'http') throw new Error(`连接 ${connection.name} 不是 HTTP 连接`)
    const result = await runHttp(
      connection,
      { path: body.path, method: body.method, body: body.body, headers: body.headers },
      { timeoutMs: connection.timeoutMs ?? timeoutMs },
    )
    sendJson(res, 200, {
      ok: true,
      status: result.status,
      statusText: result.statusText,
      url: result.url,
      headers: result.headers,
      body: `${result.body}`.slice(0, 20000),
      elapsedMs: result.elapsedMs,
    })
  }

  /**
   * 统一驱动入口：{ name, action, args } → { ok, text, table?, meta? }。
   * 失败也返回 200 + { ok: false, error }，跟 /test 的风格一致。
   */
  async function handleCall(req, res) {
    try {
      const body = await readJson(req)
      const connection = connectionOf(body)
      const driver = getDriver(connection.kind)
      const requested = typeof body.action === 'string' ? body.action.trim() : ''
      const action =
        requested !== ''
          ? requested
          : (driver.actions.find((item) => item.primary)?.id ?? driver.actions[0]?.id ?? '')
      const callArgs = body.args === undefined || body.args === null ? {} : body.args
      const options = {
        timeoutMs: connection.timeoutMs ?? timeoutMs,
        maxRows: state.defaultMaxRows,
      }

      const result =
        action === '' && typeof driver.callArgs === 'function'
          ? await driver.callArgs(connection, callArgs, options)
          : await driver.call(connection, action, callArgs, options)

      const payload = { ok: true, name: connection.name, action, text: result.text }
      if (result.table !== undefined) payload.table = result.table
      if (result.meta !== undefined) payload.meta = result.meta
      sendJson(res, 200, payload)
    } catch (error) {
      sendJson(res, 200, { ok: false, error: `${error?.message ?? error}` })
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.startsWith(API_PREFIX)
      ? url.pathname.slice(API_PREFIX.length) || '/'
      : url.pathname

    try {
      if (req.method === 'GET' && route === '/state') {
        await handleState(req, res)
        return
      }
      if (req.method === 'POST' && route === '/test') {
        await handleTest(req, res)
        return
      }
      if (req.method === 'POST' && route === '/connection') {
        await handleConnection(req, res)
        return
      }
      if (req.method === 'GET' && route === '/sessions') {
        const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
        if (controller === undefined) throw new Error('当前 profile 没有 sessionController')
        const list = await controller.list({}, AbortSignal.timeout(10000))
        const items = Array.isArray(list?.items) ? list.items : []
        sendJson(res, 200, {
          sessions: items.map((item) => ({
            sessionId: item.sessionId,
            updatedAt: item.updatedAt,
            blank: item.blank === true,
            running: item.running === true,
            title: `${item.projections?.values?.title ?? ''}`,
            cwd: `${item.projections?.values?.workingDirectory ?? ''}`,
          })),
        })
        return
      }
      if (req.method === 'GET' && route === '/peer/events') {
        const since = Number(url.searchParams.get('since') ?? 0) || 0
        const all = Array.isArray(state.peerEvents) ? state.peerEvents : []
        const events = all.filter((event) => event.id > since)
        sendJson(res, 200, { events, cursor: all.length > 0 ? all[all.length - 1].id : since })
        return
      }
      if (req.method === 'GET' && route === '/export') {
        sendJson(res, 200, exportPayload(state))
        return
      }
      if (req.method === 'POST' && route === '/import') {
        const body = await readJson(req)
        const mode = body?.mode === 'replace' ? 'replace' : 'merge'
        const result = await editConfig(ctx, (current) => applyImport(current, body, mode))
        sendJson(res, 200, { ok: true, added: result.added, updated: result.updated, errors: result.errors })
        return
      }
      if (req.method === 'POST' && route === '/databases') {
        await handleDatabases(req, res)
        return
      }
      if (req.method === 'POST' && route === '/query') {
        await handleQuery(req, res)
        return
      }
      if (req.method === 'POST' && route === '/redis') {
        await handleRedis(req, res)
        return
      }
      if (req.method === 'POST' && route === '/ssh') {
        await handleSsh(req, res)
        return
      }
      if (req.method === 'POST' && route === '/http') {
        await handleHttp(req, res)
        return
      }
      if (req.method === 'POST' && route === '/call') {
        await handleCall(req, res)
        return
      }
      sendJson(res, 404, { error: `未知接口 ${req.method} ${url.pathname}` })
    } catch (error) {
      sendJson(res, 400, { error: `${error?.message ?? error}` })
    }
  }
}
