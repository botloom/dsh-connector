/**
 * 跨 DSH 的「信箱」通道。
 *
 * 思路：所有机器都连同一个 MySQL/PostgreSQL（连接器里已有的连接），
 * 用两张表转发任务：
 *   dsh_peer_tasks —— 任务（谁发给谁、目标会话、内容、状态、回复）
 *   dsh_peers      —— 心跳（哪台在线、最后活跃时间、当前目录）
 *
 * 本机插件每 pollMs 领一条发给自己的任务，用 Host 的 sessionController
 * 把消息投进目标会话（没有指定就用最近活跃的会话），等它跑完再把最后一段
 * assistant 文本写回任务行。发起方用 peer_wait 轮询拿结果。
 *
 * 这样不需要开端口、不需要 CLI、不需要第三方插件；B 的 DSH 开着就能干活。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { querySql } from './connectors/sql.js'

const TASKS = 'dsh_peer_tasks'
const PEERS = 'dsh_peers'

/** 任务表后加的列；老库由 addMissingColumns 补上。 */
const TASK_EXTRA_COLUMNS = [
  ['session_label', 'varchar(128)'],
  ['progress', 'text'],
  ['attempts', 'int'],
  ['cancel_requested', 'int'],
  ['approved', 'int'],
]

/**
 * 会话路由：每行 `sessionId | 名称 | 用途`，行首加 * 表示默认会话。
 * 返回 [{ id, label, purpose, default }]
 */
export function parseRoutes(text) {
  // 面板里存成数组：[{ id, label, purpose, default }]
  if (Array.isArray(text)) {
    return text
      .map((row) => {
        if (row === null || typeof row !== 'object') return undefined
        const id = typeof row.id === 'string' ? row.id.trim() : ''
        if (id === '') return undefined
        return {
          id,
          label: typeof row.label === 'string' ? row.label.trim() : '',
          purpose: typeof row.purpose === 'string' ? row.purpose.trim() : '',
          default: row.default === true,
        }
      })
      .filter((row) => row !== undefined)
  }
  if (typeof text !== 'string') return []
  const routes = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const isDefault = line.startsWith('*')
    const parts = (isDefault ? line.slice(1) : line).split('|').map((part) => part.trim())
    const id = parts[0]
    if (id === '') continue
    routes.push({ id, label: parts[1] ?? '', purpose: parts[2] ?? '', default: isDefault })
  }
  return routes
}

function isSql(conn) {
  return conn !== undefined && (conn.kind === 'mysql' || conn.kind === 'postgres')
}

export function peerConfig(config) {
  const raw = config?.peer
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const mailbox = typeof raw.mailbox === 'string' ? raw.mailbox.trim() : ''
  if (name === '' || mailbox === '') return undefined
  return {
    name,
    mailbox,
    database: typeof raw.database === 'string' && raw.database.trim() !== '' ? raw.database.trim() : undefined,
    pollMs: Math.max(1000, Math.min(60000, Number(raw.pollMs) || 3000)),
    waitMs: Math.max(5000, Math.min(300000, Number(raw.waitMs) || 120000)),
  }
}

/** PostgreSQL 用 $1..$n，MySQL 用 ?；这里统一按 ? 写，执行前按 kind 转换。 */
function placeholders(conn, sql) {
  if (conn.kind !== 'postgres') return sql
  let index = 0
  return sql.replace(/\?/g, () => '$' + ++index)
}

async function exec(conn, sql, params = [], timeoutMs = 15000) {
  return querySql(conn, { sql: placeholders(conn, sql), params, write: true }, { timeoutMs })
}

/**
 * 信箱的两张表是插件自己的私有存储：建表/加列不受连接级 allowDdl 限制，
 * 否则用户还要为一个内部迁移去开 DDL 权限。
 */
async function ddl(conn, sql, timeoutMs = 20000) {
  return querySql(
    { ...conn, allowDdl: true },
    { sql: placeholders(conn, sql), params: [], write: true },
    { timeoutMs },
  )
}

async function read(conn, sql, params = [], timeoutMs = 15000) {
  return querySql(conn, { sql: placeholders(conn, sql), params }, { timeoutMs })
}

const MAX_INLINE_REPLY = 4000

/** 超过阈值就把全文写进 ~/.dsh/peer/<taskId>.md，任务行只留摘要 + 路径 */
async function archiveLongReply(taskId, reply) {
  if (reply.length <= MAX_INLINE_REPLY) return reply
  const dir = join(homedir(), '.dsh', 'peer')
  const file = join(dir, `${taskId}.md`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, reply, 'utf8')
    return `${reply.slice(0, 2000)}\n\n…（完整回复 ${reply.length} 字，已存到 ${file}）`
  } catch {
    return reply
  }
}

export async function ensureSchema(conn) {
  if (!isSql(conn)) throw new Error('信箱连接必须是 mysql 或 postgres')
  const bigint = conn.kind === 'mysql' ? 'bigint' : 'bigint'
  await ddl(conn, `create table if not exists ${TASKS} (
    id varchar(64) primary key,
    from_peer varchar(64) not null,
    to_peer varchar(64) not null,
    session_id varchar(128),
    message text not null,
    status varchar(16) not null,
    reply text,
    error text,
    created_at ${bigint} not null,
    updated_at ${bigint} not null
  )`)
  await ddl(conn, `create table if not exists ${PEERS} (
    name varchar(64) primary key,
    cwd varchar(512),
    caps text,
    last_seen ${bigint} not null
  )`)
  await addMissingColumns(conn)
}

async function addMissingColumns(conn) {
  try {
    await ddl(conn, `alter table ${PEERS} add column caps text`)
  } catch (error) {
    const message = `${error?.message ?? error}`
    if (!/already exists|duplicate column|42701|1060/i.test(message)) {
      throw new Error(`邻居表升级失败（caps）：${message}`)
    }
  }
  for (const [name, type] of TASK_EXTRA_COLUMNS) {
    try {
      await ddl(conn, `alter table ${TASKS} add column ${name} ${type}`)
    } catch (error) {
      const message = `${error?.message ?? error}`
      // 已经加过就跳过（PG 42701 / MySQL 1060，或文案里的 already exists）
      if (/already exists|duplicate column|42701|1060/i.test(message)) continue
      throw new Error(`信箱表升级失败（${name}）：${message}`)
    }
  }
}

export async function heartbeat(conn, name, cwd, capabilities) {
  const now = Date.now()
  const caps = JSON.stringify(Array.isArray(capabilities) ? capabilities : [])
  if (conn.kind === 'mysql') {
    await exec(
      conn,
      `insert into ${PEERS} (name, cwd, caps, last_seen) values (?, ?, ?, ?)
       on duplicate key update cwd = values(cwd), caps = values(caps), last_seen = values(last_seen)`,
      [name, cwd ?? '', caps, now],
    )
  } else {
    await exec(
      conn,
      `insert into ${PEERS} (name, cwd, caps, last_seen) values ($1, $2, $3, $4)
       on conflict (name) do update set cwd = excluded.cwd, caps = excluded.caps, last_seen = excluded.last_seen`,
      [name, cwd ?? '', caps, now],
    )
  }
}

export async function listPeers(conn, onlineWindowMs = 60000) {
  let result
  try {
    result = await read(conn, `select name, cwd, caps, last_seen from ${PEERS} order by last_seen desc`)
  } catch (error) {
    const message = `${error?.message ?? error}`
    // 老库还没迁移 caps：退回不带能力的查询，面板照样能列出节点
    if (!/caps/i.test(message)) throw error
    const legacy = await read(conn, `select name, cwd, last_seen from ${PEERS} order by last_seen desc`)
    const now = Date.now()
    return legacy.rows.map((row) => ({
      name: `${row[0]}`,
      cwd: `${row[1] ?? ''}`,
      capabilities: [],
      lastSeen: Number(row[2]),
      online: now - Number(row[2]) <= onlineWindowMs,
    }))
  }
  const now = Date.now()
  return result.rows.map((row) => ({
    name: `${row[0]}`,
    cwd: `${row[1] ?? ''}`,
    capabilities: parseCaps(row[2]),
    lastSeen: Number(row[3]),
    online: now - Number(row[3]) <= onlineWindowMs,
  }))
}

function parseCaps(raw) {
  if (raw === null || raw === undefined) return []
  try {
    const parsed = JSON.parse(`${raw}`)
    return Array.isArray(parsed) ? parsed.map((item) => `${item}`) : []
  } catch {
    return []
  }
}

/** 谁能干这件事：按能力子串匹配，返回 { peer, matched } */
export async function findByCapability(conn, need, onlineWindowMs = 60000) {
  const needle = `${need ?? ''}`.trim().toLowerCase()
  if (needle === '') return []
  const peers = await listPeers(conn, onlineWindowMs)
  const hits = []
  for (const peer of peers) {
    const matched = peer.capabilities.filter((cap) => cap.toLowerCase().includes(needle))
    if (matched.length > 0) hits.push({ peer, matched })
  }
  return hits
}

/** 重试：把结束了的任务重置回 pending，attempts+1 */
export async function retryTask(conn, id, peer) {
  const task = await readTask(conn, id)
  if (task === undefined) return { ok: false, reason: 'not-found' }
  if (typeof peer === 'string' && peer !== '' && task.from !== peer) return { ok: false, reason: 'not-owner', task }
  if (task.status !== 'done' && task.status !== 'error' && task.status !== 'cancelled') {
    return { ok: false, reason: 'running', task }
  }
  const now = Date.now()
  await exec(
    conn,
    `update ${TASKS} set status = 'pending', reply = '', error = '', progress = '', session_id = '', session_label = '', attempts = ?, cancel_requested = 0, updated_at = ? where id = ?`,
    [task.attempts + 1, now, id],
  )
  return { ok: true, task: await readTask(conn, id) }
}

export async function sendTask(conn, { from, to, sessionId, sessionLabel, message }) {
  const id = randomUUID()
  const now = Date.now()
  await exec(
    conn,
    `insert into ${TASKS} (id, from_peer, to_peer, session_id, session_label, message, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, from, to, sessionId ?? '', sessionLabel ?? '', message, now, now],
  )
  return id
}

/** 局部更新任务行（progress / status / session_label / attempts / cancel_requested）。 */
export async function updateTask(conn, id, patch = {}) {
  const sets = []
  const params = []
  const put = (column, value) => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (typeof patch.session_id === 'string') put('session_id', patch.session_id)
  if (typeof patch.session_label === 'string') put('session_label', patch.session_label)
  if (typeof patch.progress === 'string') put('progress', patch.progress)
  if (typeof patch.status === 'string') put('status', patch.status)
  if (typeof patch.attempts === 'number') put('attempts', patch.attempts)
  if (typeof patch.cancel_requested === 'number') put('cancel_requested', patch.cancel_requested)
  if (typeof patch.approved === 'number') put('approved', patch.approved)
  if (sets.length === 0) return
  put('updated_at', Date.now())
  await exec(conn, `update ${TASKS} set ${sets.join(', ')} where id = ?`, [...params, id])
}

/** 列出任务：direction=sent|received|all，可按状态过滤。 */
export async function listTasks(conn, { peer, direction = 'all', status, limit = 20 } = {}) {
  const where = []
  const params = []
  if (typeof peer === 'string' && peer !== '') {
    if (direction === 'sent') {
      where.push('from_peer = ?')
      params.push(peer)
    } else if (direction === 'received') {
      where.push('to_peer = ?')
      params.push(peer)
    } else {
      where.push('(from_peer = ? or to_peer = ?)')
      params.push(peer, peer)
    }
  }
  if (typeof status === 'string' && status !== '') {
    where.push('status = ?')
    params.push(status)
  }
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const sql = `select ${TASK_COLUMNS} from ${TASKS}${where.length > 0 ? ` where ${where.join(' and ')}` : ''} order by created_at desc limit ${size}`
  const result = await read(conn, sql, params)
  return result.rows.map(mapTaskRow)
}

/** 取消任务：还没领的直接置 cancelled，已领的标记 cancel_requested 让接收方在投递前放弃。 */
/** 把「待确认」的任务放行，下一轮轮询就会投递 */
export async function acceptTask(conn, id, peer) {
  const task = await readTask(conn, id)
  if (task === undefined) return { ok: false, reason: 'not-found' }
  if (typeof peer === 'string' && peer !== '' && task.to !== peer) return { ok: false, reason: 'not-owner', task }
  if (task.status !== 'inbox') return { ok: false, reason: 'not-inbox', task }
  await updateTask(conn, id, { status: 'pending', progress: '已确认，等待执行', approved: 1 })
  return { ok: true, task: await readTask(conn, id) }
}

/** 直接丢掉「待确认」的任务 */
export async function rejectTask(conn, id, peer) {
  const task = await readTask(conn, id)
  if (task === undefined) return { ok: false, reason: 'not-found' }
  if (typeof peer === 'string' && peer !== '' && task.to !== peer) return { ok: false, reason: 'not-owner', task }
  if (task.status !== 'inbox') return { ok: false, reason: 'not-inbox', task }
  await updateTask(conn, id, { status: 'cancelled', progress: '' })
  return { ok: true, task: await readTask(conn, id) }
}

/** 收件箱：等我确认的任务 */
export async function listInbox(conn, peer, limit = 20) {
  return listTasks(conn, { peer, direction: 'received', status: 'inbox', limit })
}

export async function cancelTask(conn, id, peer) {
  const task = await readTask(conn, id)
  if (task === undefined) return { ok: false, reason: 'not-found' }
  if (typeof peer === 'string' && peer !== '' && task.from !== peer) return { ok: false, reason: 'not-owner', task }
  if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
    return { ok: false, reason: 'finished', task }
  }
  if (task.status === 'pending' || task.status === 'inbox') {
    await updateTask(conn, id, { status: 'cancelled', progress: '' })
    return { ok: true, task: await readTask(conn, id) }
  }
  await updateTask(conn, id, { cancel_requested: 1, progress: '已请求取消' })
  return { ok: true, pending: true, task: await readTask(conn, id) }
}

const TASK_COLUMNS =
  'id, from_peer, to_peer, session_id, session_label, message, status, progress, reply, error, attempts, cancel_requested, approved, created_at, updated_at'

function mapTaskRow(row) {
  return {
    id: `${row[0]}`,
    from: `${row[1]}`,
    to: `${row[2]}`,
    sessionId: `${row[3] ?? ''}`,
    sessionLabel: row[4] === null ? '' : `${row[4] ?? ''}`,
    message: `${row[5]}`,
    status: `${row[6]}`,
    progress: row[7] === null ? '' : `${row[7] ?? ''}`,
    reply: row[8] === null ? null : `${row[8]}`,
    error: row[9] === null ? null : `${row[9]}`,
    attempts: Number(row[10] ?? 0),
    cancelRequested: Number(row[11] ?? 0) === 1,
    approved: Number(row[12] ?? 0) === 1,
    createdAt: Number(row[13]),
    updatedAt: Number(row[14]),
  }
}

export async function readTask(conn, id) {
  const result = await read(conn, `select ${TASK_COLUMNS} from ${TASKS} where id = ?`, [id])
  const row = result.rows[0]
  return row === undefined ? undefined : mapTaskRow(row)
}

/** 领一条发给我的 pending 任务（先查再带条件更新，冲突时下一轮再试）。 */
export async function claimTask(conn, peerName) {
  const found = await read(
    conn,
    `select id, from_peer, to_peer, session_id, message, status, reply, error, created_at, updated_at
          from ${TASKS} where to_peer = ? and status = 'pending' order by created_at asc limit 1`,
    [peerName],
  )
  const row = found.rows[0]
  if (row === undefined) return undefined
  const id = `${row[0]}`
  const now = Date.now()
  const claimed = await exec(
    conn,
    `update ${TASKS} set status = 'claimed', updated_at = ? where id = ? and status = 'pending'`,
    [now, id],
  )
  if ((claimed.rowCount ?? 0) === 0) return undefined
  return readTask(conn, id)
}

export async function finishTask(conn, id, { reply, error }) {
  const now = Date.now()
  await exec(
    conn,
    `update ${TASKS} set status = ?, reply = ?, error = ?, progress = ?, updated_at = ? where id = ?`,
    [error === undefined ? 'done' : 'error', reply ?? '', error ?? '', '', now, id],
  )
}

/** 从 wait/events 的输出里挑最后一段 assistant 文本。 */
export function extractAssistantText(records) {
  if (!Array.isArray(records)) return ''
  let best = ''
  for (const record of records) {
    const event = record?.event ?? record
    const type = `${event?.type ?? ''}`
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
    const data = event?.data ?? {}
    const content = data?.content ?? data?.message?.content ?? data?.blocks
    if (!Array.isArray(content)) continue
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text !== '') best = text
  }
  return best
}

/**
 * 启动本机的信箱循环：心跳 + 领任务 + 投进会话 + 写回结果。
 * 返回一个 stop()。
 */
export function startPeerLoop({ ctx, connection, peer, log, onEvent }) {
  // 同一进程里重复 apply（热重载/改配置）时，先停掉上一轮的循环：
  // 否则旧闭包里的 setInterval 会继续按旧节点名发心跳、抢任务
  const previous = globalThis.__wsconnPeerStops
  if (Array.isArray(previous)) {
    for (const stop of previous.splice(0)) {
      try {
        stop()
      } catch {
        /* 忽略 */
      }
    }
  }

  let timer
  let stopped = false
  let busy = false

  const controllers = () => ctx.get('sessionController')
  const routes = Array.isArray(peer.routes) ? peer.routes : []

  function routeFor(wanted) {
    if (routes.length === 0) {
      throw new Error('本机没有配置可投递会话：在 DSH 节点连接的「会话路由」里加至少一行')
    }
    if (typeof wanted === 'string' && wanted !== '') {
      const exact = routes.find((route) => route.id === wanted)
      if (exact === undefined) {
        const list = routes.map((route) => `${route.id}${route.label === '' ? '' : `（${route.label}）`}`).join('、')
        throw new Error(`会话 ${wanted} 不在可投递列表：${list}`)
      }
      return exact
    }
    return routes.find((route) => route.default === true) ?? routes[0]
  }

  async function handle(task) {
    const controller = controllers()
    if (controller === undefined) throw new Error('缺少 sessionController，无法投递')
    const route = routeFor(task.sessionId)
    const sessionId = route.id

    await updateTask(connection, task.id, {
      session_id: sessionId,
      session_label: route.label,
      status: 'running',
      progress: '准备投递',
    })

    const prompt = {
      requestId: `peer-${task.id}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task.message }],
    }

    // 先记下当前游标：wait 只取投递之后的新消息，避免把对方上一轮的回复当成结果
    let afterSeq
    try {
      const before = await controller.state({ sessionId }, AbortSignal.timeout(10000))
      if (typeof before?.cursor === 'number') afterSeq = before.cursor
    } catch {
      /* 拿不到游标就退回全窗口 */
    }

    await controller.prompt(prompt, AbortSignal.timeout(15000))
    log('info', `peer task ${task.id} → ${sessionId}`)
    await updateTask(connection, task.id, { progress: '已投递，等待回复' })

    const waited = await controller.wait(
      {
        sessionId,
        timeoutMs: peer.waitMs,
        maxMessages: 30,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      },
      AbortSignal.timeout(peer.waitMs + 15000),
    )
    const text = extractAssistantText(waited?.output?.records ?? [])
    const reply = await archiveLongReply(
      task.id,
      text || `（${waited?.reason ?? 'unknown'}，未提取到 assistant 文本）`,
    )
    return { sessionId, reply, reason: waited?.reason }
  }

  async function tick() {
    if (stopped || busy) return
    busy = true
    try {
      await heartbeat(connection, peer.name, undefined, peer.capabilities)
      const task = await claimTask(connection, peer.name)
      if (task !== undefined) {
        if (task.cancelRequested === true) {
          await finishTask(connection, task.id, { error: '已取消（投递前）' })
          onEvent?.({ kind: 'failed', task, error: '已取消' })
          return
        }

        // 默认不自动执行：先挂到「待确认」，等人点了才投递
        const trusted = Array.isArray(peer.trusted) ? peer.trusted : []
        const autoRun = task.approved === true || peer.autoRun === true || trusted.includes(task.from)
        if (!autoRun) {
          await updateTask(connection, task.id, { status: 'inbox', progress: '等待本机确认' })
          onEvent?.({ kind: 'inbox', task })
          log('info', `peer task ${task.id} 来自 ${task.from}，已放进待确认`)
          return
        }

        onEvent?.({ kind: 'received', task })
        await updateTask(connection, task.id, { status: 'running', progress: '已领取' })
        try {
          const result = await handle(task)
          await finishTask(connection, task.id, { reply: `${result.reply}` })
          onEvent?.({ kind: 'done', task, sessionId: result.sessionId, reply: result.reply })
        } catch (error) {
          await finishTask(connection, task.id, { error: `${error?.message ?? error}` })
          onEvent?.({ kind: 'failed', task, error: `${error?.message ?? error}` })
          log('warn', `peer task ${task.id} failed: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      log('warn', `peer poll failed: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }

  timer = setInterval(tick, peer.pollMs)
  timer.unref?.()
  void tick()

  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  globalThis.__wsconnPeerStops = [stop]
  return stop
}
