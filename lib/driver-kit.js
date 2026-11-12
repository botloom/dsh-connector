/**
 * 驱动共用的小工具：取值/取默认值、URL 校验、带超时的 fetch、脱敏。
 *
 * 只依赖 Node 内置能力（全局 fetch / AbortSignal），不引第三方包。
 * 这里刻意不 import 插件里的其它模块（除了纯函数的 format.js），
 * 免得和 config.js -> drivers/index.js 形成 ESM 循环。
 */

import { truncate } from './format.js'

export function pickString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function pickNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : undefined
}

export function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

/** 只保留非空字符串的数组；不是数组时返回 undefined。 */
export function pickStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const items = value.map((item) => pickString(item)).filter((item) => item !== undefined)
  return items.length === 0 ? undefined : items
}

/** 只接受普通对象（拒绝数组 / null / Date 等）。 */
export function pickObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value
}

/** 校验成 http(s) URL；失败时抛带字段名的错误。 */
export function parseHttpUrl(value, label, connName) {
  const text = pickString(value)
  if (text === undefined) throw new Error(`连接 ${connName} 缺少 ${label}`)
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`连接 ${connName} 的 ${label} 不是合法 URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`连接 ${connName} 的 ${label} 只支持 http/https`)
  }
  return url
}

/** 去掉 query/fragment，避免把 access_token 打回模型或客户端。 */
export function safeUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(`${value}`)
    return `${url.origin}${url.pathname}`.replace(/\/bot\d+:[^/]+/g, '/bot***')
  } catch {
    return `${value}`.split('?')[0]
  }
}

/**
 * 把错误信息里可能出现的密钥擦掉：
 * - 完整 URL 换成去掉 query 的形态；
 * - query 参数值（access_token 等）替换成 ***；
 * - Telegram 的 bot<id>:<token> 替换成 bot***；
 * - JSON 里 "password"/"token"/"secret"/"sign" 的值替换成 ***。
 */
export function scrub(text, url) {
  let out = `${text ?? ''}`
  try {
    const parsed = url instanceof URL ? url : new URL(`${url}`)
    if (parsed.search !== '') out = out.split(parsed.search).join('?…')
    out = out.split(parsed.toString()).join(safeUrl(parsed))
    for (const [, value] of parsed.searchParams) {
      if (value.length >= 4) out = out.split(value).join('***')
    }
  } catch {
    /* url 不合法时按纯文本处理 */
  }
  out = out.replace(/access_token=[^&\s"'<>]+/gi, 'access_token=***')
  out = out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
  out = out.replace(/(["']?(?:secret|password|token|sign|botToken)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi, '$1***')
  return out
}

/** 把任意 error 变成可回给模型的一句话（已脱敏）。 */
export function errorMessage(error, url) {
  const message = `${error?.cause?.message ?? error?.message ?? error}`
  return scrub(message, url)
}

export function basicAuthHeader(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

export function bearerAuthHeader(token) {
  return `Bearer ${token}`
}

/** 递归转成可 JSON.stringify 的形态（BigInt / Date / Buffer 都能落地）。 */
export function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex')
    return hex.length > 64 ? `0x${hex.slice(0, 64)}…(${value.length}B)` : `0x${hex}`
  }
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item)
    return out
  }
  return value
}

export function formatJson(value, max = 6000) {
  try {
    return truncate(JSON.stringify(value, null, 2), max)
  } catch {
    return truncate(`${value}`, max)
  }
}

/**
 * 发一次请求并尽量解析 JSON。
 *
 * @returns {Promise<{status:number,statusText:string,ok:boolean,url:string,
 *   headers:object,text:string,json:any,elapsedMs:number}>}
 */
export async function requestJson(url, request = {}) {
  const target = `${url}`
  const method = `${request.method ?? 'GET'}`.toUpperCase()
  const headers = { ...(request.headers ?? {}) }
  const timeoutMs = clampNumber(request.timeoutMs, 100, 300000, 15000)

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
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`请求 ${safeUrl(target)} 超时（${timeoutMs}ms）`)
    }
    throw new Error(`请求 ${safeUrl(target)} 失败：${errorMessage(error, target)}`)
  }

  const text = await response.text().catch(() => '')
  let json
  try {
    json = text.trim() === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    url: safeUrl(response.url === '' ? target : response.url),
    headers: Object.fromEntries([...response.headers.entries()].slice(0, 40)),
    text,
    json,
    elapsedMs: Date.now() - startedAt,
  }
}

/** 只做可达性探测，不读响应体（webhook 探测专用，避免产生消息）。 */
export async function probeUrl(url, options = {}) {
  const target = `${url}`
  const timeoutMs = clampNumber(options.timeoutMs, 100, 300000, 15000)
  const method = [`HEAD`, `GET`].includes(`${options.method ?? 'GET'}`.toUpperCase())
    ? `${options.method ?? 'GET'}`.toUpperCase()
    : 'GET'
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(target, {
      method,
      headers: { ...(options.headers ?? {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`请求 ${safeUrl(target)} 超时（${timeoutMs}ms）`)
    }
    throw new Error(`请求 ${safeUrl(target)} 失败：${errorMessage(error, target)}`)
  }
  await response.body?.cancel?.().catch?.(() => {})
  return { status: response.status, statusText: response.statusText, elapsedMs: Date.now() - startedAt }
}
