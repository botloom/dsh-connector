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

import { randomUUID } from 'node:crypto'
import { querySql } from './connectors/sql.js'

const TASKS = 'dsh_peer_tasks'
const PEERS = 'dsh_peers'

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

async function read(conn, sql, params = [], timeoutMs = 15000) {
  return querySql(conn, { sql: placeholders(conn, sql), params }, { timeoutMs })
}

export async function ensureSchema(conn) {
  if (!isSql(conn)) throw new Error('信箱连接必须是 mysql 或 postgres')
  const bigint = conn.kind === 'mysql' ? 'bigint' : 'bigint'
  await exec(conn, `create table if not exists ${TASKS} (
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
  await exec(conn, `create table if not exists ${PEERS} (
    name varchar(64) primary key,
    cwd varchar(512),
    last_seen ${bigint} not null
  )`)
}

export async function heartbeat(conn, name, cwd) {
  const now = Date.now()
  if (conn.kind === 'mysql') {
    await exec(
      conn,
      `insert into ${PEERS} (name, cwd, last_seen) values (?, ?, ?)
       on duplicate key update cwd = values(cwd), last_seen = values(last_seen)`,
      [name, cwd ?? '', now],
    )
  } else {
    await exec(
      conn,
      `insert into ${PEERS} (name, cwd, last_seen) values ($1, $2, $3)
       on conflict (name) do update set cwd = excluded.cwd, last_seen = excluded.last_seen`,
      [name, cwd ?? '', now],
    )
  }
}

export async function listPeers(conn, onlineWindowMs = 60000) {
  const result = await read(conn, `select name, cwd, last_seen from ${PEERS} order by last_seen desc`)
  const now = Date.now()
  return result.rows.map((row) => ({
    name: `${row[0]}`,
    cwd: `${row[1] ?? ''}`,
    lastSeen: Number(row[2]),
    online: now - Number(row[2]) <= onlineWindowMs,
  }))
}

export async function sendTask(conn, { from, to, sessionId, message }) {
  const id = randomUUID()
  const now = Date.now()
  await exec(
    conn,
    `insert into ${TASKS} (id, from_peer, to_peer, session_id, message, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, from, to, sessionId ?? '', message, now, now],
  )
  return id
}

export async function readTask(conn, id) {
  const result = await read(conn, `select id, from_peer, to_peer, session_id, message, status, reply, error, created_at, updated_at from ${TASKS} where id = ?`, [id])
  const row = result.rows[0]
  if (row === undefined) return undefined
  return {
    id: `${row[0]}`,
    from: `${row[1]}`,
    to: `${row[2]}`,
    sessionId: `${row[3] ?? ''}`,
    message: `${row[4]}`,
    status: `${row[5]}`,
    reply: row[6] === null ? null : `${row[6]}`,
    error: row[7] === null ? null : `${row[7]}`,
    createdAt: Number(row[8]),
    updatedAt: Number(row[9]),
  }
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
    `update ${TASKS} set status = ?, reply = ?, error = ?, updated_at = ? where id = ?`,
    [error === undefined ? 'done' : 'error', reply ?? '', error ?? '', now, id],
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
export function startPeerLoop({ ctx, connection, peer, log }) {
  let timer
  let stopped = false
  let busy = false

  const controllers = () => ctx.get('sessionController')

  async function resolveSessionId(controller, wanted) {
    if (typeof wanted === 'string' && wanted !== '') return wanted
    const list = await controller.list({}, AbortSignal.timeout(10000))
    const items = Array.isArray(list?.items) ? list.items : []
    const candidate = items.find((item) => item.blank !== true && item.agentAvailable === true)
    if (candidate === undefined) throw new Error('对方没有可用会话，请在任务里指定 sessionId')
    return candidate.sessionId
  }

  async function handle(task) {
    const controller = controllers()
    if (controller === undefined) throw new Error('缺少 sessionController，无法投递')
    const sessionId = await resolveSessionId(controller, task.sessionId)
    const prompt = {
      requestId: `peer-${task.id}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task.message }],
    }
    await controller.prompt(prompt, AbortSignal.timeout(15000))
    log('info', `peer task ${task.id} → ${sessionId}`)

    const waited = await controller.wait(
      { sessionId, timeoutMs: peer.waitMs, maxMessages: 30 },
      AbortSignal.timeout(peer.waitMs + 15000),
    )
    const text = extractAssistantText(waited?.output?.records ?? [])
    return {
      sessionId,
      reply: text || `（${waited?.reason ?? 'unknown'}，未提取到 assistant 文本）`,
      reason: waited?.reason,
    }
  }

  async function tick() {
    if (stopped || busy) return
    busy = true
    try {
      await heartbeat(connection, peer.name, undefined)
      const task = await claimTask(connection, peer.name)
      if (task !== undefined) {
        try {
          const result = await handle(task)
          await finishTask(connection, task.id, { reply: `${result.reply}` })
        } catch (error) {
          await finishTask(connection, task.id, { error: `${error?.message ?? error}` })
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

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
