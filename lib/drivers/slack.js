/**
 * Slack Incoming Webhook。
 * probe 只做可达性探测（GET），不会发消息。
 */

import { parseHttpUrl, pickNumber, pickString, probeUrl, requestJson } from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = 'Slack Webhook'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

async function sendAction(conn, args, opts) {
  const text = pickString(args?.text)
  if (text === undefined) throw new Error('text 不能为空')

  const result = await requestJson(conn.webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { text },
    timeoutMs: timeoutOf(conn, opts),
  })
  const body = result.text.trim()
  if (result.status !== 200 || body !== 'ok') {
    throw new Error(
      `Slack 发送失败：HTTP ${result.status} ${result.statusText}${body === '' ? '' : ` · ${truncate(body, 300)}`}`,
    )
  }
  return {
    text: `${LABEL} · 已发送 · ${formatDuration(result.elapsedMs)}`,
    meta: { status: result.status, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'slack',
  label: LABEL,
  category: 'message',
  aliases: [],
  defaultPort: undefined,
  fields: [
    {
      name: 'webhook',
      label: 'Webhook 地址',
      type: 'text',
      required: true,
      placeholder: 'https://hooks.slack.com/services/...',
    },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['secret', 'token', 'password'],
  actions: [
    {
      id: 'send',
      label: '发送消息',
      primary: true,
      params: [{ name: 'text', label: '内容', type: 'text', required: true }],
    },
  ],

  validate(conn) {
    if (pickString(conn.webhook) === undefined) throw new Error(`连接 ${conn.name} 缺少 webhook`)
    parseHttpUrl(conn.webhook, 'webhook', conn.name)
    return { ...conn, webhook: pickString(conn.webhook) }
  },

  async probe(conn, opts) {
    const url = parseHttpUrl(conn.webhook, 'webhook', conn.name)
    const started = Date.now()
    const result = await probeUrl(url, { timeoutMs: timeoutOf(conn, opts), method: 'GET' })
    return {
      detail: `webhook 可达（HTTP ${result.status}），未发送消息`,
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
    try {
      const url = new URL(conn.webhook)
      return `${LABEL} ${url.origin}${url.pathname}`
    } catch {
      return `${LABEL} ${conn.name}`
    }
  },
}
