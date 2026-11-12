/** HTTP：对配置好的内网接口发请求（相对路径拼在 baseUrl 后）。 */

import { readSecret } from '../secret.js'
import { truncate } from '../format.js'

function authHeaders(conn) {
  const headers = {}
  const token = conn.tokenEnv || conn.token ? readSecret(conn, 'token', 'tokenEnv') : undefined
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const password = conn.passwordEnv || conn.password ? readSecret(conn) : undefined
  if (password !== undefined && conn.username) {
    headers.authorization = `Basic ${Buffer.from(`${conn.username}:${password}`).toString('base64')}`
  }
  return headers
}

function buildUrl(conn, path) {
  const base = new URL(conn.baseUrl)
  const target = new URL(path ?? '', base)
  if (target.origin !== base.origin && conn.allowAnyUrl !== true) {
    throw new Error(`拒绝请求 ${target.origin}：连接只允许访问 ${base.origin}（需要时加 allowAnyUrl: true）`)
  }
  return target
}

/** 返回 { status, statusText, headers, body, elapsedMs, url }。 */
export async function runHttp(conn, request, options) {
  const target = buildUrl(conn, request.path)
  const method = `${request.method ?? 'GET'}`.toUpperCase()
  const headers = {
    ...(conn.headers ?? {}),
    ...(request.headers ?? {}),
    ...authHeaders(conn),
  }

  let body
  if (request.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof request.body === 'string') {
      body = request.body
    } else {
      body = JSON.stringify(request.body)
      headers['content-type'] = headers['content-type'] ?? 'application/json'
    }
  }

  const startedAt = Date.now()
  let response
  try {
    response = await fetch(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`请求超时（${options.timeoutMs}ms）`)
    throw new Error(`请求 ${target} 失败：${error?.cause?.message ?? error?.message ?? error}`)
  }

  const text = await response.text().catch(() => '')
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries([...response.headers.entries()].slice(0, 40)),
    body: truncate(text, 4000),
    bodyBytes: Buffer.byteLength(text, 'utf8'),
    elapsedMs: Date.now() - startedAt,
  }
}

export async function probeHttp(conn, options) {
  const startedAt = Date.now()
  const target = buildUrl(conn, '')
  let response
  try {
    response = await fetch(target, {
      method: 'GET',
      headers: { ...(conn.headers ?? {}), ...authHeaders(conn) },
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`请求超时（${options.timeoutMs}ms）`)
    throw new Error(`${error?.cause?.message ?? error?.message ?? error}`)
  }
  return { detail: `HTTP ${response.status} ${response.statusText}`.trim(), elapsedMs: Date.now() - startedAt }
}
