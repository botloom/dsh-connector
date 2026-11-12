/**
 * Telegram Bot：botToken/botTokenEnv + chatId。
 * 发消息走 POST /bot<token>/sendMessage；probe 走 /getMe（不会发消息）。
 * 错误信息里会把 bot token 擦成 bot***。
 */

import { readSecretValue } from '../secret.js'
import { pickNumber, pickString, requestJson, scrub } from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = 'Telegram Bot'
const API_BASE = 'https://api.telegram.org'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

function apiRoot(conn) {
  const token = readSecretValue(conn, 'botToken', 'botTokenEnv')
  if (token === undefined) {
    throw new Error(`连接 ${conn.name} 缺少 botToken（或 botTokenEnv）`)
  }
  return { token, root: `${API_BASE}/bot${token}` }
}

async function sendAction(conn, args, opts) {
  const text = pickString(args?.text)
  if (text === undefined) throw new Error('text 不能为空')
  const { root } = apiRoot(conn)
  const url = `${root}/sendMessage`

  let result
  try {
    result = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { chat_id: conn.chatId, text },
      timeoutMs: timeoutOf(conn, opts),
    })
  } catch (error) {
    throw new Error(scrub(error?.message ?? error, url))
  }

  if (result.json?.ok !== true) {
    throw new Error(
      `Telegram 发送失败：${result.json?.description ?? `HTTP ${result.status} ${result.statusText}`}`,
    )
  }
  return {
    text: `${LABEL} · 已发送 · chat=${conn.chatId} · ${formatDuration(result.elapsedMs)}`,
    meta: { chatId: conn.chatId, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'telegram',
  label: LABEL,
  category: 'message',
  aliases: ['tg'],
  defaultPort: undefined,
  fields: [
    { name: 'botToken', label: 'Bot Token', type: 'password', hint: '形如 123456:ABC-...' },
    { name: 'botTokenEnv', label: 'Bot Token 环境变量', type: 'text' },
    { name: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['botToken', 'token', 'password', 'secret'],
  actions: [
    {
      id: 'send',
      label: '发送消息',
      primary: true,
      params: [{ name: 'text', label: '内容', type: 'text', required: true }],
    },
  ],

  validate(conn) {
    if (pickString(conn.chatId) === undefined) throw new Error(`连接 ${conn.name} 缺少 chatId`)
    if (pickString(conn.botToken) === undefined && pickString(conn.botTokenEnv) === undefined) {
      throw new Error(`连接 ${conn.name} 缺少 botToken（或 botTokenEnv）`)
    }
    return { ...conn, chatId: pickString(conn.chatId) }
  },

  async probe(conn, opts) {
    const { root } = apiRoot(conn)
    const url = `${root}/getMe`
    const started = Date.now()
    let result
    try {
      result = await requestJson(url, { method: 'GET', timeoutMs: timeoutOf(conn, opts) })
    } catch (error) {
      throw new Error(scrub(error?.message ?? error, url))
    }
    if (result.json?.ok !== true) {
      throw new Error(`Telegram 校验失败：${result.json?.description ?? `HTTP ${result.status}`}`)
    }
    const username = result.json?.result?.username
    return {
      detail: `Bot ${username ? `@${username}` : ''} 可用（未发送消息）`.replace('  ', ' ').trim(),
      elapsedMs: Date.now() - started,
    }
  },

  async call(conn, action, args, opts) {
    if (action === 'send') return sendAction(conn, args, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：send`)
  },

  async callArgs(conn, args, opts) {
    return sendAction(conn, args, opts)
  },

  describe(conn) {
    return `${LABEL} chat=${conn.chatId}`
  },
}
