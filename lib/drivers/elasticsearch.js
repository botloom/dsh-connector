/**
 * Elasticsearch 驱动：只用全局 fetch。
 *
 * actions:
 * - health  GET /_cluster/health
 * - query   自定义 path + body
 * - search  index + dsl（默认 match_all，size 20）
 */

import { readSecretValue } from '../secret.js'
import {
  basicAuthHeader,
  bearerAuthHeader,
  formatJson,
  pickNumber,
  pickObject,
  pickString,
  requestJson,
  safeUrl,
} from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = 'Elasticsearch'
const DEFAULT_SIZE = 20

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

function authHeaders(conn) {
  const headers = {}
  const user = readSecretValue(conn, 'user', 'userEnv')
  const password = readSecretValue(conn, 'password', 'passwordEnv')
  if (user !== undefined && password !== undefined) {
    headers.authorization = basicAuthHeader(user, password)
  } else if (password !== undefined) {
    // 只给了 password 时按 token 处理（例如 API Key 场景）
    headers.authorization = bearerAuthHeader(password)
  }
  return headers
}

function buildUrl(conn, path) {
  const base = new URL(conn.baseUrl)
  const suffix = typeof path === 'string' ? path.trim() : ''
  const target = new URL(suffix === '' ? base : suffix.replace(/^\/+/, ''), `${conn.baseUrl}/`)
  if (target.origin !== base.origin) {
    throw new Error(`拒绝请求 ${target.origin}：连接只允许访问 ${base.origin}`)
  }
  return target
}

async function run(conn, method, path, body, opts) {
  const target = buildUrl(conn, path)
  const result = await requestJson(target, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders(conn) },
    body,
    timeoutMs: timeoutOf(conn, opts),
  })
  const payload =
    result.json !== undefined ? formatJson(result.json, 8000) : truncate(result.text.trim(), 6000) || '(空响应体)'
  const header = `${conn.name} · ${method} ${target.pathname} · ${result.status} ${result.statusText} · ${formatDuration(result.elapsedMs)}`
  return {
    text: `${header}\n${payload}`,
    meta: {
      status: result.status,
      url: result.url,
      elapsedMs: result.elapsedMs,
      error: result.ok ? null : (result.json?.error?.reason ?? result.statusText),
    },
  }
}

async function callAction(conn, action, args, opts) {
  if (action === 'health') return run(conn, 'GET', '/_cluster/health', undefined, opts)
  if (action === 'query') {
    const path = pickString(args?.path)
    if (path === undefined) throw new Error('path 不能为空')
    const method = pickString(args?.method) ?? (args?.body === undefined ? 'GET' : 'POST')
    return run(conn, method.toUpperCase(), path, args?.body, opts)
  }
  if (action === 'search') {
    const index = pickString(args?.index)
    if (index === undefined) throw new Error('index 不能为空')
    const dsl = pickObject(args?.dsl) ?? { query: { match_all: {} } }
    const size = Math.max(1, Math.min(1000, pickNumber(args?.size) ?? DEFAULT_SIZE))
    const body = { ...dsl, size: pickNumber(dsl.size) ?? size }
    return run(conn, 'POST', `/${encodeURIComponent(index)}/_search`, body, opts)
  }
  throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：health/query/search`)
}

export default {
  kind: 'elasticsearch',
  label: LABEL,
  category: 'search',
  aliases: ['es'],
  defaultPort: 9200,
  fields: [
    { name: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'http://127.0.0.1:9200' },
    { name: 'user', label: '用户名', type: 'text' },
    { name: 'userEnv', label: '用户名环境变量', type: 'text' },
    { name: 'password', label: '密码 / API Key', type: 'password' },
    { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
    { name: 'verify', label: '校验 TLS 证书', type: 'boolean' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['password', 'token'],
  actions: [
    { id: 'health', label: '集群健康', primary: true, params: [] },
    {
      id: 'query',
      label: '自定义请求',
      params: [
        { name: 'path', label: '路径', type: 'text', required: true, placeholder: '/_cat/indices?format=json' },
        { name: 'body', label: '请求体', type: 'object' },
        { name: 'method', label: '方法', type: 'text', hint: '默认有 body 用 POST，否则用 GET' },
      ],
    },
    {
      id: 'search',
      label: '搜索',
      params: [
        { name: 'index', label: '索引', type: 'text', required: true, placeholder: 'logs-*' },
        { name: 'dsl', label: 'Query DSL', type: 'object', hint: '默认 {"query":{"match_all":{}}}' },
        { name: 'size', label: '返回条数', type: 'number', hint: '默认 20' },
      ],
    },
  ],

  validate(conn) {
    const text = pickString(conn.baseUrl)
    if (text === undefined) throw new Error(`连接 ${conn.name} 缺少 baseUrl`)
    let baseUrl
    try {
      baseUrl = new URL(text).toString().replace(/\/+$/, '')
    } catch {
      throw new Error(`连接 ${conn.name} 的 baseUrl 不是合法 URL`)
    }
    return {
      ...conn,
      baseUrl,
      user: pickString(conn.user),
      verify: conn.verify !== false,
    }
  },

  async probe(conn, opts) {
    const target = new URL(`${conn.baseUrl}/`)
    const started = Date.now()
    try {
      const result = await requestJson(target, {
        method: 'GET',
        headers: authHeaders(conn),
        timeoutMs: timeoutOf(conn, opts),
      })
      const authHint =
        result.status === 401 || result.status === 403 ? '（认证失败：检查 user/password）' : ''
      return {
        detail: `Elasticsearch 可达（HTTP ${result.status} ${result.statusText}）${authHint}`,
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      throw new Error(`Elasticsearch 不可达（${safeUrl(target)}）：${error?.message ?? error}`)
    }
  },

  async call(conn, action, args, opts) {
    return callAction(conn, action, args, opts)
  },

  async callArgs(conn, args, opts) {
    return callAction(conn, 'query', args, opts)
  },

  describe(conn) {
    return `${LABEL} ${conn.baseUrl}`
  },
}
