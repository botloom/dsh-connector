/**
 * 企业微信群机器人（webhook 出站）。
 * probe 只做可达性探测（GET），不会发消息。
 */

import { parseHttpUrl, pickNumber, pickString, probeUrl, requestJson } from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = '企业微信机器人'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

async function sendAction(conn, args, opts) {
  const text = pickString(args?.text)
  if (text === undefined) throw new Error('text 不能为空')
  const msgtype = args?.msgtype === 'markdown' ? 'markdown' : 'text'
  const payload =
    msgtype === 'markdown'
      ? { msgtype, markdown: { content: text } }
      : { msgtype, text: { content: text } }

  const result = await requestJson(conn.webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    timeoutMs: timeoutOf(conn, opts),
  })
  if (result.json === undefined) {
    throw new Error(`企业微信返回非 JSON（HTTP ${result.status}）：${truncate(result.text.trim(), 300) || '(空响应)'}`)
  }
  const errcode = Number(result.json?.errcode ?? 0)
  if (!Number.isFinite(errcode) || errcode !== 0) {
    throw new Error(
      `企业微信发送失败：errcode=${result.json?.errcode ?? '未知'} errmsg=${result.json?.errmsg ?? '（无）'}`,
    )
  }
  return {
    text: `${LABEL} · 已发送（${msgtype}）· ${formatDuration(result.elapsedMs)}`,
    meta: { errcode: 0, msgtype, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'wecom',
  label: LABEL,
  category: 'message',
  aliases: ['wechat-work', 'qyweixin'],
  defaultPort: undefined,
  fields: [
    {
      name: 'webhook',
      label: 'Webhook 地址',
      type: 'text',
      required: true,
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
    },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['secret', 'token', 'password'],
  actions: [
    {
      id: 'send',
      label: '发送消息',
      primary: true,
      params: [
        { name: 'text', label: '内容', type: 'text', required: true },
        { name: 'msgtype', label: '消息类型', type: 'text', hint: 'text | markdown，默认 text' },
      ],
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
