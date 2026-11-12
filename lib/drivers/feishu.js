/**
 * 飞书自定义机器人（webhook 出站）。
 *
 * 加签（飞书官方算法）：stringToSign = `${timestamp}\n${secret}`，
 * HMAC-SHA256(key = stringToSign, data = '') → base64，作为 body 的 sign。
 * probe 只做可达性探测（GET，不会发消息）。
 */

import crypto from 'node:crypto'
import { readSecretValue } from '../secret.js'
import { parseHttpUrl, pickNumber, pickString, probeUrl, requestJson } from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = '飞书机器人'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

function signOf(secret) {
  const timestamp = Math.floor(Date.now() / 1000)
  const stringToSign = `${timestamp}\n${secret}`
  const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64')
  return { timestamp, sign }
}

async function sendAction(conn, args, opts) {
  const text = pickString(args?.text)
  if (text === undefined) throw new Error('text 不能为空')
  const title = pickString(args?.title)
  const content = title === undefined ? text : `${title}\n${text}`

  const payload = { msg_type: 'text', content: { text: content } }
  const secret = readSecretValue(conn, 'secret', 'secretEnv')
  if (secret !== undefined) {
    const { timestamp, sign } = signOf(secret)
    payload.timestamp = String(timestamp)
    payload.sign = sign
  }

  const result = await requestJson(conn.webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    timeoutMs: timeoutOf(conn, opts),
  })
  if (result.json === undefined) {
    throw new Error(`飞书返回非 JSON（HTTP ${result.status}）：${truncate(result.text.trim(), 300) || '(空响应)'}`)
  }
  const code = Number(result.json?.code ?? result.json?.StatusCode ?? 0)
  if (!Number.isFinite(code) || code !== 0) {
    const message = result.json?.msg ?? result.json?.StatusMessage ?? '（无）'
    throw new Error(`飞书发送失败：code=${result.json?.code ?? result.json?.StatusCode ?? '未知'} msg=${message}`)
  }
  return {
    text: `${LABEL} · 已发送 · ${formatDuration(result.elapsedMs)}`,
    meta: { code: 0, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'feishu',
  label: LABEL,
  category: 'message',
  aliases: ['lark'],
  defaultPort: undefined,
  fields: [
    {
      name: 'webhook',
      label: 'Webhook 地址',
      type: 'text',
      required: true,
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
    },
    { name: 'secretEnv', label: '签名密钥环境变量', type: 'text', hint: '可选，加签机器人用' },
    { name: 'secret', label: '签名密钥', type: 'password' },
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
        { name: 'title', label: '标题', type: 'text', hint: '可选，会拼在正文前' },
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
