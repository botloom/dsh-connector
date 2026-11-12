/** HTTP 驱动：复用 lib/connectors/http.js（全局 fetch + baseUrl 同源限制）。 */

import { probeHttp, runHttp } from '../connectors/http.js'
import { pickNumber, pickString } from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = 'HTTP'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

async function requestAction(conn, args, opts) {
  const result = await runHttp(
    conn,
    {
      path: args?.path,
      method: args?.method,
      body: args?.body,
      headers: args?.headers,
    },
    { timeoutMs: timeoutOf(conn, opts) },
  )
  const header = `${conn.name} · ${result.status} ${result.statusText} · ${formatDuration(result.elapsedMs)}\n${result.url}`
  const body = result.body.trim() === '' ? '(空响应体)' : truncate(result.body.trim(), 4000)
  return {
    text: `${header}\n${body}`,
    meta: {
      status: result.status,
      statusText: result.statusText,
      url: result.url,
      bodyBytes: result.bodyBytes,
      elapsedMs: result.elapsedMs,
    },
  }
}

export default {
  kind: 'http',
  label: LABEL,
  category: 'api',
  aliases: ['https', 'api'],
  defaultPort: undefined,
  fields: [
    { name: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'http://10.0.0.20:8080/' },
    { name: 'headers', label: '默认请求头', type: 'object' },
    { name: 'token', label: 'Token', type: 'password' },
    { name: 'tokenEnv', label: 'Token 环境变量', type: 'text' },
    { name: 'username', label: 'Basic 用户名', type: 'text' },
    { name: 'password', label: 'Basic 密码', type: 'password' },
    { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
    { name: 'allowAnyUrl', label: '允许跨域地址', type: 'boolean' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['token', 'password'],
  actions: [
    {
      id: 'request',
      label: '发请求',
      primary: true,
      params: [
        { name: 'path', label: '路径', type: 'text', hint: '相对路径拼在 baseUrl 后' },
        { name: 'method', label: '方法', type: 'text', placeholder: 'GET' },
        { name: 'body', label: '请求体', type: 'object' },
        { name: 'headers', label: '附加请求头', type: 'object' },
      ],
    },
  ],

  validate(conn) {
    const baseUrl = pickString(conn.baseUrl)
    if (baseUrl === undefined) throw new Error(`连接 ${conn.name} 缺少 baseUrl`)
    let normalized
    try {
      normalized = new URL(baseUrl).toString()
    } catch {
      throw new Error(`连接 ${conn.name} 的 baseUrl 不是合法 URL`)
    }
    return {
      ...conn,
      baseUrl: normalized,
      allowAnyUrl: conn.allowAnyUrl === true,
    }
  },

  async probe(conn, opts) {
    return probeHttp(conn, { timeoutMs: timeoutOf(conn, opts) })
  },

  async call(conn, action, args, opts) {
    if (action === 'request') return requestAction(conn, args, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：request`)
  },

  async callArgs(conn, args, opts) {
    return requestAction(conn, args, opts)
  },

  describe(conn) {
    return `${LABEL} ${conn.baseUrl}`
  },
}
