/**
 * 钉钉自定义机器人（webhook 出站）。
 *
 * - 可选加签：HMAC-SHA256(key = secret, data = `${timestamp}\n${secret}`) → base64，
 *   拼到 webhook 的 `timestamp` / `sign` 查询参数上。
 * - probe 只做可达性探测（GET，不会发消息）。
 */

import crypto from 'node:crypto'
import { readSecretValue } from '../secret.js'
import {
  parseHttpUrl,
  pickNumber,
  pickString,
  pickStringArray,
  probeUrl,
  requestJson,
} from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = '钉钉机器人'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

function signedWebhook(webhook, secret) {
  const url = new URL(webhook)
  if (secret === undefined) return url
  const timestamp = Date.now()
  const sign = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  url.searchParams.set('timestamp', String(timestamp))
  url.searchParams.set('sign', sign)
  return url
}

async function sendAction(conn, args, opts) {
  const text = pickString(args?.text)
  if (text === undefined) throw new Error('text 不能为空')
  const msgtype = args?.msgtype === 'markdown' ? 'markdown' : 'text'

  const payload =
    msgtype === 'markdown'
      ? { msgtype, markdown: { title: truncate(text.split('\n')[0], 32) || '消息', text } }
      : { msgtype, text: { content: text } }
  const atMobiles = pickStringArray(args?.atMobiles)
  if (atMobiles !== undefined) payload.at = { atMobiles }

  const secret = readSecretValue(conn, 'secret', 'secretEnv')
  const target = signedWebhook(conn.webhook, secret)

  const result = await requestJson(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    timeoutMs: timeoutOf(conn, opts),
  })
  if (result.json === undefined) {
    throw new Error(`钉钉返回非 JSON（HTTP ${result.status}）：${truncate(result.text.trim(), 300) || '(空响应)'}`)
  }
  const errcode = Number(result.json?.errcode ?? 0)
  if (!Number.isFinite(errcode) || errcode !== 0) {
    throw new Error(
      `钉钉发送失败：errcode=${result.json?.errcode ?? '未知'} errmsg=${result.json?.errmsg ?? '（无）'}`,
    )
  }
  return {
    text: `${LABEL} · 已发送（${msgtype}）· ${formatDuration(result.elapsedMs)}`,
    meta: { errcode: 0, msgtype, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'dingtalk',
  label: LABEL,
  category: 'message',
  aliases: ['ding'],
  defaultPort: undefined,
  fields: [
    {
      name: 'webhook',
      label: 'Webhook 地址',
      type: 'text',
      required: true,
      placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
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
        { name: 'msgtype', label: '消息类型', type: 'text', hint: 'text | markdown，默认 text' },
        { name: 'atMobiles', label: '@手机号', type: 'array' },
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
    // GET 不会触发发消息，只确认地址可达
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
    let host = conn.webhook
    try {
      host = `${new URL(conn.webhook).origin}${new URL(conn.webhook).pathname}`
    } catch {
      /* 保持原样 */
    }
    return `${LABEL} ${host}`
  },
}
