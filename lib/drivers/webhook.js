/**
 * 通用出站 Webhook：baseUrl + 可选 headers / token（Bearer）。
 *
 * actions:
 * - request  自定义 path + method + body
 * - send     与 request 等价的别名
 *
 * probe 用 HEAD（拿不到 body 也不影响判断），不会真的发消息。
 */

import { readSecretValue } from '../secret.js'
import {
  bearerAuthHeader,
  pickNumber,
  pickObject,
  pickString,
  probeUrl,
  requestJson,
  safeUrl,
} from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = '通用 Webhook'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

function authHeaders(conn) {
  const headers = {}
  const token = readSecretValue(conn, 'token', 'tokenEnv')
  if (token !== undefined) headers.authorization = bearerAuthHeader(token)
  return headers
}

function buildUrl(conn, path) {
  const base = new URL(conn.baseUrl)
  const suffix = typeof path === 'string' ? path.trim() : ''
  // baseUrl 自带结尾斜杠时不要再补一个，否则 /hooks/ + x 会变成 /hooks//x
  const baseHref = conn.baseUrl.endsWith('/') ? conn.baseUrl : `${conn.baseUrl}/`
  const target = new URL(suffix === '' ? base : suffix.replace(/^\/+/, ''), baseHref)
  if (target.origin !== base.origin && conn.allowAnyUrl !== true) {
    throw new Error(`拒绝请求 ${target.origin}：连接只允许访问 ${base.origin}（需要时加 allowAnyUrl: true）`)
  }
  return target
}

async function requestAction(conn, args, opts) {
  const target = buildUrl(conn, args?.path)
  const method = (pickString(args?.method) ?? (args?.body === undefined ? 'GET' : 'POST')).toUpperCase()
  const result = await requestJson(target, {
    method,
    headers: {
      ...(pickObject(conn.headers) ?? {}),
      ...(pickObject(args?.headers) ?? {}),
      ...authHeaders(conn),
    },
    body: args?.body,
    timeoutMs: timeoutOf(conn, opts),
  })
  const body = result.text.trim() === '' ? '(空响应体)' : truncate(result.text.trim(), 4000)
  return {
    text: `${conn.name} · ${method} ${target.pathname} · ${result.status} ${result.statusText} · ${formatDuration(result.elapsedMs)}\n${body}`,
    meta: { status: result.status, url: result.url, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'webhook',
  label: LABEL,
  category: 'api',
  aliases: ['hook', 'outbound'],
  defaultPort: undefined,
  fields: [
    { name: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'https://example.com/hooks/' },
    { name: 'headers', label: '默认请求头', type: 'object' },
    { name: 'token', label: 'Token', type: 'password', hint: '会以 Authorization: Bearer 发送' },
    { name: 'tokenEnv', label: 'Token 环境变量', type: 'text' },
    { name: 'allowAnyUrl', label: '允许跨域地址', type: 'boolean' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['token', 'password', 'secret'],
  actions: [
    {
      id: 'request',
      label: '发请求',
      primary: true,
      params: [
        { name: 'path', label: '路径', type: 'text', hint: '相对路径拼在 baseUrl 后' },
        { name: 'method', label: '方法', type: 'text', placeholder: 'POST' },
        { name: 'body', label: '请求体', type: 'object' },
        { name: 'headers', label: '附加请求头', type: 'object' },
      ],
    },
    {
      id: 'send',
      label: '发送（request 别名）',
      params: [
        { name: 'path', label: '路径', type: 'text' },
        { name: 'method', label: '方法', type: 'text' },
        { name: 'body', label: '请求体', type: 'object' },
        { name: 'headers', label: '附加请求头', type: 'object' },
      ],
    },
  ],

  validate(conn) {
    const text = pickString(conn.baseUrl)
    if (text === undefined) throw new Error(`连接 ${conn.name} 缺少 baseUrl`)
    let baseUrl
    try {
      baseUrl = new URL(text).toString()
    } catch {
      throw new Error(`连接 ${conn.name} 的 baseUrl 不是合法 URL`)
    }
    return {
      ...conn,
      baseUrl,
      headers: pickObject(conn.headers) ?? undefined,
      allowAnyUrl: conn.allowAnyUrl === true,
    }
  },

  async probe(conn, opts) {
    const target = buildUrl(conn, '')
    const started = Date.now()
    const result = await probeUrl(target, {
      method: 'HEAD',
      headers: { ...(pickObject(conn.headers) ?? {}), ...authHeaders(conn) },
      timeoutMs: timeoutOf(conn, opts),
    })
    return {
      detail: `HTTP ${result.status} ${result.statusText}（仅探测，未发送消息）`.trim(),
      elapsedMs: Date.now() - started,
    }
  },

  async call(conn, action, args, opts) {
    if (action === 'request' || action === 'send') return requestAction(conn, args, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：request/send`)
  },

  async callArgs(conn, args, opts) {
    return requestAction(conn, args, opts)
  },

  describe(conn) {
    return `${LABEL} ${safeUrl(conn.baseUrl)}`
  },
}
