/**
 * DSH 节点驱动：把一个「同事的 DSH」当成一种连接来管理。
 *
 * 它本身不连数据库，只记录本机节点名（peerName）和信箱连接名（mailbox）；
 * 真正的收发由 lib/peer.js 通过信箱（PostgreSQL/MySQL）完成。
 *
 * 分类是 agent（面板里单独一组），不和数据库混在一起。
 */

import { resolveFromPool } from '../config.js'
import { extractAssistantText, ensureSchema, heartbeat, listPeers, readTask, sendTask } from '../peer.js'
import { clampNumber, pickString } from '../driver-kit.js'
import { formatDuration } from '../format.js'

const LABEL = 'DSH 节点'

function mailboxOf(conn) {
  const mailboxName = pickString(conn.mailbox)
  if (mailboxName === undefined) throw new Error(`连接 ${conn.name} 缺少 mailbox（信箱连接名）`)
  const mailbox = resolveFromPool(mailboxName)
  if (mailbox === undefined) throw new Error(`找不到信箱连接「${mailboxName}」：先在连接器里加一个 mysql/postgres 连接`)
  const database = pickString(conn.database) ?? mailbox.database
  return database === undefined ? mailbox : { ...mailbox, database }
}

function peerNameOf(conn) {
  const name = pickString(conn.peerName)
  if (name === undefined) throw new Error(`连接 ${conn.name} 缺少 peerName（本机节点名，例如 dev-a）`)
  return name
}

async function peersAction(conn) {
  const mailbox = mailboxOf(conn)
  await ensureSchema(mailbox)
  await heartbeat(mailbox, peerNameOf(conn))
  const peers = await listPeers(mailbox)
  if (peers.length === 0) return { text: '信箱里还没有节点心跳。', meta: { peers } }
  return {
    text: peers
      .map((item) => `${item.online ? '在线' : '离线'}  ${item.name}${item.cwd ? ` · ${item.cwd}` : ''} · ${new Date(item.lastSeen).toLocaleString()}`)
      .join('\n'),
    meta: { peers },
  }
}

async function sendAction(conn, args) {
  const mailbox = mailboxOf(conn)
  const to = pickString(args?.to)
  if (to === undefined) throw new Error('to 不能为空（对方的 peerName）')
  const text = typeof args?.text === 'string' ? args.text : ''
  if (text.trim() === '') throw new Error('text 不能为空')
  await ensureSchema(mailbox)
  const taskId = await sendTask(mailbox, {
    from: peerNameOf(conn),
    to,
    sessionId: pickString(args?.sessionId) ?? '',
    message: text,
  })
  return { text: `已投递给 ${to}，taskId=${taskId}\n用 wait 动作等结果。`, meta: { taskId, to } }
}

async function waitAction(conn, args, opts) {
  const mailbox = mailboxOf(conn)
  const taskId = pickString(args?.taskId)
  if (taskId === undefined) throw new Error('taskId 不能为空')
  const budget = clampNumber(args?.timeoutMs, 1000, 600000, Number(opts?.timeoutMs) || 180000)
  const startedAt = Date.now()
  for (;;) {
    const task = await readTask(mailbox, taskId)
    if (task === undefined) throw new Error(`没有这个任务：${taskId}`)
    if (task.status === 'done') {
      return {
        text: `任务完成（会话 ${task.sessionId || '对方默认'}）· ${formatDuration(Date.now() - startedAt)}\n${task.reply ?? ''}`,
        meta: task,
      }
    }
    if (task.status === 'error') return { text: `任务失败：${task.error ?? '未知原因'}`, meta: task }
    if (Date.now() - startedAt > budget) {
      return { text: `等待超时（${budget}ms），任务状态仍是 ${task.status}。稍后再试。`, meta: task }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export default {
  kind: 'dsh',
  label: LABEL,
  category: 'agent',
  aliases: ['peer', 'dsh-peer'],
  fields: [
    { name: 'peerName', label: '本机节点名', type: 'text', required: true, placeholder: 'dev-a', hint: '每台机器不同，对方用它找到你' },
    { name: 'mailbox', label: '信箱连接', type: 'text', required: true, hint: '连接器里一个 mysql/postgres 连接的名字' },
    { name: 'database', label: '信箱库名', type: 'text', hint: '省略则用信箱连接自带的库' },
    {
      name: 'routes',
      label: '会话路由',
      type: 'textarea',
      hint: '每行：sessionId | 名称 | 用途；行首加 * 表示默认会话。没配就不接收任何任务。',
      placeholder:
        '*session-xxxx | 闲聊 | 兜底任务\nsession-yyyy | 技能 | 技能相关需求',
    },
    { name: 'pollMs', label: '轮询间隔（毫秒）', type: 'number' },
  ],
  actions: [
    { id: 'peers', label: '看在线节点', primary: true, params: [] },
    {
      id: 'send',
      label: '给同事派活',
      params: [
        { name: 'to', label: '目标节点', type: 'text', required: true, placeholder: 'dev-b' },
        { name: 'text', label: '内容', type: 'text', required: true },
        { name: 'sessionId', label: '对方会话 ID', type: 'text', hint: '省略则由对方挑最近活跃会话' },
      ],
    },
    {
      id: 'wait',
      label: '等结果',
      params: [
        { name: 'taskId', label: '任务 ID', type: 'text', required: true },
        { name: 'timeoutMs', label: '最多等多久（毫秒）', type: 'number' },
      ],
    },
  ],

  validate(conn) {
    const peerName = pickString(conn.peerName)
    if (peerName === undefined) throw new Error(`连接 ${conn.name} 缺少 peerName`)
    const mailbox = pickString(conn.mailbox)
    if (mailbox === undefined) throw new Error(`连接 ${conn.name} 缺少 mailbox`)
    return { ...conn, peerName, mailbox, pollMs: clampNumber(conn.pollMs, 1000, 60000, 3000) }
  },

  async probe(conn) {
    const result = await peersAction(conn)
    return { detail: result.text.split('\n')[0], elapsedMs: 0 }
  },

  async call(conn, action, args, opts) {
    if (action === 'peers') return peersAction(conn)
    if (action === 'send') return sendAction(conn, args)
    if (action === 'wait') return waitAction(conn, args, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：peers / send / wait`)
  },

  async callArgs(conn, args, opts) {
    return sendAction(conn, args)
  },

  describe(conn) {
    return `${LABEL} ${conn.peerName ?? ''} · 信箱 ${conn.mailbox ?? ''}`
  },
}
