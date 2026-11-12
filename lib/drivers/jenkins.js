/**
 * Jenkins 驱动：把「发布 / 重启」这类操作收敛成动作。
 *
 * 认证用用户名 + API Token（Jenkins「用户 → 配置 → API Token」里生成），
 * 也兼容用户名 + 密码。CSRF crumb 会自动取一次再重试。
 *
 * 默认**不允许触发构建**：连接要显式 allowTrigger: true，否则 build 动作直接拒绝。
 */

import { basicAuthHeader, clampNumber, errorMessage, pickString, requestJson, safeUrl } from '../driver-kit.js'
import { readSecretValue } from '../secret.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = 'Jenkins'

function baseOf(conn) {
  const text = pickString(conn.baseUrl)
  if (text === undefined) throw new Error(`连接 ${conn.name} 缺少 baseUrl`)
  return text.replace(/\/+$/, '')
}

function timeoutOf(conn, opts) {
  return clampNumber(conn?.timeoutMs ?? opts?.timeoutMs, 1000, 300000, 20000)
}

function authHeaders(conn) {
  const user = pickString(conn.user)
  const secret = readSecretValue(conn, 'token') ?? readSecretValue(conn, 'password')
  if (user === undefined || secret === undefined) return {}
  return { authorization: basicAuthHeader(user, secret) }
}

/** job 支持 folder/job/name 简写，逐段编码。 */
function jobPath(job) {
  return `${job}`
    .split('/')
    .filter((part) => part !== '')
    .map((part) => `/job/${encodeURIComponent(part)}`)
    .join('')
}

async function call(conn, path, options, opts) {
  const response = await requestJson(`${baseOf(conn)}${path}`, {
    headers: { accept: 'application/json', ...authHeaders(conn) },
    timeoutMs: timeoutOf(conn, opts),
    ...options,
  })
  if (response.ok) return response
  throw new Error(
    `Jenkins ${response.status}${response.statusText ? ` ${response.statusText}` : ''} · ${safeUrl(`${baseOf(conn)}${path}`)}：${
      truncate(response.text.trim(), 300) || '(空响应)'
    }`,
  )
}

/** 从响应里拼出 Cookie 头：Jenkins 的 crumb 绑定在会话上，必须带同一个 cookie。 */
function cookieOf(response) {
  const raw = response?.headers?.['set-cookie']
  if (typeof raw !== 'string' || raw === '') return undefined
  const pairs = raw
    .split(/,(?=\s*[^;=]+=)/)
    .map((part) => part.split(';')[0].trim())
    .filter((part) => part !== '')
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/** POST：先直接发，遇到 403 就取会话 cookie + CSRF crumb 再发一次。 */
async function post(conn, path, opts) {
  const url = `${baseOf(conn)}${path}`
  const first = await requestJson(url, {
    method: 'POST',
    headers: { accept: 'application/json', ...authHeaders(conn) },
    timeoutMs: timeoutOf(conn, opts),
  })
  if (first.ok) return first
  if (first.status !== 403) {
    throw new Error(`Jenkins ${first.status} 拒绝 ${path}：${truncate(first.text.trim(), 200) || '(空响应)'}`)
  }

  const cookie = cookieOf(first)
  const sessionHeaders = cookie === undefined ? {} : { cookie }

  let field
  let value
  try {
    const crumb = await requestJson(`${baseOf(conn)}/crumbIssuer/api/json`, {
      headers: { accept: 'application/json', ...authHeaders(conn), ...sessionHeaders },
      timeoutMs: timeoutOf(conn, opts),
    })
    field = pickString(crumb.json?.crumbRequestField)
    value = pickString(crumb.json?.crumb)
  } catch {
    /* 没有 crumb issuer 就按原错误抛 */
  }
  if (field === undefined || value === undefined) {
    throw new Error(`Jenkins 403：${truncate(first.text.trim(), 200) || '没有拿到 CSRF crumb'}`)
  }
  const retry = await requestJson(url, {
    method: 'POST',
    headers: { accept: 'application/json', ...authHeaders(conn), ...sessionHeaders, [field]: value },
    timeoutMs: timeoutOf(conn, opts),
  })
  if (!retry.ok) throw new Error(`Jenkins ${retry.status} 拒绝 ${path}：${truncate(retry.text.trim(), 200)}`)
  return retry
}

const COLOR_TONE = (color) => {
  if (typeof color !== 'string') return '未知'
  if (color.endsWith('_anime')) return '构建中'
  if (color.startsWith('blue')) return '成功'
  if (color.startsWith('red')) return '失败'
  if (color.startsWith('yellow')) return '不稳定'
  if (color.startsWith('aborted')) return '已取消'
  if (color.startsWith('grey') || color.startsWith('disabled')) return '未构建'
  return color
}

async function jobsAction(conn, args, opts) {
  const path = pickString(args?.path) ?? ''
  const prefix = path === '' ? '' : `${path.startsWith('/') ? '' : '/'}${path.replace(/\/+$/, '')}`
  const response = await call(conn, `${prefix}/api/json?tree=jobs[name,color,url]`, { method: 'GET' }, opts)
  const jobs = Array.isArray(response.json?.jobs) ? response.json.jobs : []
  if (jobs.length === 0) return { text: `没有列到 job（${safeUrl(`${baseOf(conn)}${prefix || '/'}`)}）` }
  return {
    text: jobs
      .map((job) => `${COLOR_TONE(job.color)}  ${job.name}`)
      .join('\n'),
    meta: { count: jobs.length, jobs: jobs.map((job) => ({ name: job.name, color: job.color })) },
  }
}

async function jobAction(conn, args, opts) {
  const job = pickString(args?.job)
  if (job === undefined) throw new Error('job 不能为空')
  const response = await call(
    conn,
    `${jobPath(job)}/api/json?tree=name,color,lastBuild[number,result,building,duration,timestamp,url]`,
    { method: 'GET' },
    opts,
  )
  const data = response.json ?? {}
  const last = data.lastBuild
  const lines = [`${data.name ?? job} · ${COLOR_TONE(data.color)}`]
  if (last !== undefined && last !== null) {
    lines.push(
      `#${last.number} · ${last.building === true ? '构建中' : last.result ?? '未知'} · ${Math.round(Number(last.duration) || 0) / 1000}s${
        last.url ? `\n${last.url}` : ''
      }`,
    )
  } else {
    lines.push('还没有构建记录')
  }
  return { text: lines.join('\n'), meta: data }
}

async function buildAction(conn, args, opts) {
  if (conn.allowTrigger !== true) {
    throw new Error(`连接 ${conn.name} 没有开启 allowTrigger：触发构建/发布是危险操作，先在面板里打开`)
  }
  const job = pickString(args?.job)
  if (job === undefined) throw new Error('job 不能为空')
  const params = args?.params
  const query =
    params !== null && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length > 0
      ? `?${Object.entries(params)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(`${value}`)}`)
          .join('&')}`
      : ''
  const startedAt = Date.now()
  await post(conn, `${jobPath(job)}/${query === '' ? 'build' : `buildWithParameters${query}`}`, opts)

  const waitMs = clampNumber(args?.waitMs, 0, 600000, 0)
  if (waitMs === 0) {
    return { text: `已触发 ${job}（不等待结果）。用 status 或 log 看进展。`, meta: { job } }
  }

  // 等这一轮构建结束
  const deadline = Date.now() + waitMs
  let lastNumber
  for (;;) {
    const info = await call(conn, `${jobPath(job)}/api/json?tree=lastBuild[number,building,result]`, { method: 'GET' }, opts)
    const last = info.json?.lastBuild
    if (last !== undefined && last !== null && last.building !== true) {
      lastNumber = last.number
      return {
        text: `${job} #${lastNumber} ${last.result ?? '未知'} · ${formatDuration(Date.now() - startedAt)}`,
        meta: { job, build: lastNumber, result: last.result },
      }
    }
    if (Date.now() > deadline) {
      return { text: `已触发 ${job}，等待 ${waitMs}ms 还没结束（可以稍后看 status/log）。`, meta: { job } }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

async function logAction(conn, args, opts) {
  const job = pickString(args?.job)
  if (job === undefined) throw new Error('job 不能为空')
  const build = pickString(args?.build) ?? 'lastBuild'
  const lines = clampNumber(args?.lines, 1, 2000, 80)
  const response = await requestJson(`${baseOf(conn)}${jobPath(job)}/${build}/consoleText`, {
    headers: authHeaders(conn),
    timeoutMs: timeoutOf(conn, opts),
  })
  if (!response.ok) throw new Error(`Jenkins ${response.status} 读不到日志：${truncate(response.text.trim(), 200)}`)
  const tail = response.text.split(/\r?\n/).slice(-lines).join('\n')
  return { text: `${job} · ${build} 最后 ${lines} 行：\n${tail}` }
}

async function queueAction(conn, opts) {
  const response = await call(conn, '/queue/api/json?tree=items[id,why,task[name,url]]', { method: 'GET' }, opts)
  const items = Array.isArray(response.json?.items) ? response.json.items : []
  if (items.length === 0) return { text: '构建队列是空的。' }
  return { text: items.map((item) => `${item.task?.name ?? '?'} · ${item.why ?? ''}`).join('\n') }
}

export default {
  kind: 'jenkins',
  label: LABEL,
  category: 'server',
  aliases: ['ci'],
  defaultPort: 8080,
  fields: [
    { name: 'baseUrl', label: 'Jenkins 地址', type: 'text', required: true, placeholder: 'http://10.0.0.35:9999/' },
    { name: 'user', label: '用户名', type: 'text' },
    { name: 'token', label: 'API Token', type: 'password', hint: '用户 → 配置 → API Token' },
    { name: 'tokenEnv', label: 'Token 环境变量', type: 'text' },
    { name: 'password', label: '密码（没 Token 时）', type: 'password' },
    { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
    {
      name: 'allowTrigger',
      label: '允许触发构建',
      type: 'boolean',
      hint: '默认关：build（发布/重启）会被拒绝',
    },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['token', 'password'],
  actions: [
    { id: 'jobs', label: '列出 Job', primary: true, params: [{ name: 'path', label: '视图路径', type: 'text', hint: '如 view/911新产测试，省略则列全部' }] },
    { id: 'job', label: '查看 Job', params: [{ name: 'job', label: 'Job 路径', type: 'text', required: true, hint: 'folder/job 用 / 分隔' }] },
    {
      id: 'build',
      label: '触发构建 / 发布',
      params: [
        { name: 'job', label: 'Job 路径', type: 'text', required: true },
        { name: 'params', label: '参数', type: 'object', hint: '带参数的 job 会走 buildWithParameters' },
        { name: 'waitMs', label: '等多久（毫秒）', type: 'number', hint: '0 = 只触发不等待' },
      ],
    },
    { id: 'log', label: '看构建日志', params: [{ name: 'job', label: 'Job 路径', type: 'text', required: true }, { name: 'build', label: '构建号', type: 'text', hint: '默认 lastBuild' }, { name: 'lines', label: '行数', type: 'number' }] },
    { id: 'queue', label: '看排队', params: [] },
  ],

  validate(conn) {
    const baseUrl = baseOf(conn)
    let parsed
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new Error(`连接 ${conn.name} 的 baseUrl 不是合法 URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`连接 ${conn.name} 的 baseUrl 只支持 http/https`)
    }
    return { ...conn, baseUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ''), allowTrigger: conn.allowTrigger === true }
  },

  async probe(conn, opts) {
    const startedAt = Date.now()
    const response = await requestJson(`${baseOf(conn)}/api/json?tree=mode,nodeDescription`, {
      headers: { accept: 'application/json', ...authHeaders(conn) },
      timeoutMs: timeoutOf(conn, opts),
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Jenkins 认证失败（${response.status}）：检查用户名 / API Token`)
    }
    if (!response.ok) throw new Error(errorMessage(new Error(`Jenkins ${response.status}`), baseOf(conn)))
    return {
      detail: `Jenkins 可达 · 模式 ${response.json?.mode ?? '?'}${conn.allowTrigger === true ? ' · 允许触发构建' : ' · 只读'}`,
      elapsedMs: Date.now() - startedAt,
    }
  },

  async call(conn, action, args, opts) {
    if (action === 'jobs') return jobsAction(conn, args, opts)
    if (action === 'job') return jobAction(conn, args, opts)
    if (action === 'build') return buildAction(conn, args, opts)
    if (action === 'log') return logAction(conn, args, opts)
    if (action === 'queue') return queueAction(conn, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：jobs / job / build / log / queue`)
  },

  async callArgs(conn, args, opts) {
    return buildAction(conn, args, opts)
  },

  describe(conn) {
    return `${LABEL} ${conn.baseUrl ?? ''}${conn.allowTrigger === true ? ' · 可触发' : ' · 只读'}`
  },
}
