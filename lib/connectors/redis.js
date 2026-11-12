/** Redis：一个够用的 RESP2 客户端，只读排查场景不依赖任何 npm 包。 */

import net from 'node:net'
import tls from 'node:tls'
import { readSecret } from '../secret.js'
import { truncate } from '../format.js'

class RedisReplyError extends Error {}

const ALWAYS_BLOCKED = new Set([
  'FLUSHALL',
  'FLUSHDB',
  'SHUTDOWN',
  'DEBUG',
  'SCRIPT',
  'EVAL',
  'EVALSHA',
  'EVAL_RO',
  'EVALSHA_RO',
  'FCALL',
  'FCALL_RO',
  'FUNCTION',
  'MODULE',
  'MIGRATE',
  'SLAVEOF',
  'REPLICAOF',
  'SWAPDB',
  'RESET',
  'ACL',
  'RESTORE',
  'BGREWRITEAOF',
  'BGSAVE',
  'SAVE',
  'PSYNC',
  'REPLCONF',
])

const BLOCKED_SUBCOMMANDS = {
  CONFIG: new Set(['SET', 'REWRITE', 'RESETSTAT']),
  CLIENT: new Set(['KILL', 'PAUSE', 'UNPAUSE', 'NO-EVICT']),
  COMMAND: new Set(['DOCS']),
}

/** 阻止明确会改状态的命令；conn.allowDangerous === true 时放行。 */
export function assertSafeRedisCommand(conn, argv) {
  if (conn.allowDangerous === true) return
  const command = String(argv[0] ?? '').toUpperCase()
  if (command === '') throw new Error('Redis 命令为空')
  if (ALWAYS_BLOCKED.has(command)) {
    throw new Error(`拒绝执行 ${command}：它会改 Redis 状态。确需执行时给连接加 allowDangerous: true。`)
  }
  const blocked = BLOCKED_SUBCOMMANDS[command]
  if (blocked !== undefined) {
    const sub = String(argv[1] ?? '').toUpperCase()
    if (blocked.has(sub)) {
      throw new Error(`拒绝执行 ${command} ${sub}：它会改 Redis 状态。确需执行时给连接加 allowDangerous: true。`)
    }
  }
}

function encodeCommand(argv) {
  const chunks = [Buffer.from(`*${argv.length}\r\n`)]
  for (const arg of argv) {
    const buffer = Buffer.from(`${arg}`, 'utf8')
    chunks.push(Buffer.from(`$${buffer.length}\r\n`), buffer, Buffer.from('\r\n'))
  }
  return Buffer.concat(chunks)
}

/** RESP2 增量解析：返回 { value, offset }，数据不够时返回 null。 */
function parseReply(buffer, offset) {
  const lineEnd = buffer.indexOf('\r\n', offset)
  if (lineEnd === -1) return null
  const type = String.fromCharCode(buffer[offset])
  const line = buffer.toString('utf8', offset + 1, lineEnd)
  const next = lineEnd + 2

  switch (type) {
    case '+':
      return { value: line, offset: next }
    case '-':
      return { value: new RedisReplyError(line), offset: next }
    case ':':
      return { value: Number(line), offset: next }
    case ',': {
      return { value: Number(line), offset: next }
    }
    case '#':
      return { value: line === 't', offset: next }
    case '_':
      return { value: null, offset: next }
    case '$': {
      const length = Number(line)
      if (length === -1) return { value: null, offset: next }
      if (!Number.isFinite(length) || length < 0) return { value: `(无法解析的 bulk 长度 ${line})`, offset: next }
      if (buffer.length < next + length + 2) return null
      return { value: buffer.toString('utf8', next, next + length), offset: next + length + 2 }
    }
    case '*':
    case '~': {
      const count = Number(line)
      if (count === -1) return { value: null, offset: next }
      if (!Number.isFinite(count) || count < 0) return { value: `(无法解析的数组长度 ${line})`, offset: next }
      const items = []
      let cursor = next
      for (let index = 0; index < count; index += 1) {
        const parsed = parseReply(buffer, cursor)
        if (parsed === null) return null
        items.push(parsed.value)
        cursor = parsed.offset
      }
      return { value: items, offset: cursor }
    }
    default:
      return { value: line, offset: next }
  }
}

function openSocket(conn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = conn.host
    const port = conn.port
    let settled = false
    let timer

    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('error', onError)
      socket.destroy()
      reject(error)
    }

    const onError = (error) => fail(new Error(`连接 ${host}:${port} 失败：${error.message}`))

    const socket = conn.tls
      ? tls.connect({
          host,
          port,
          servername: typeof conn.servername === 'string' ? conn.servername : host,
          rejectUnauthorized: conn.tlsRejectUnauthorized !== false,
        })
      : net.connect({ host, port })

    timer = setTimeout(() => fail(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`)), timeoutMs)
    socket.once('error', onError)
    socket.once(conn.tls ? 'secureConnect' : 'connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

class RedisClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.failure = undefined
    socket.setNoDelay?.(true)
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('Redis 连接已关闭')))
  }

  fail(error) {
    this.failure = this.failure ?? error
    while (this.waiters.length > 0) this.waiters.shift().reject(this.failure)
  }

  drain() {
    while (this.waiters.length > 0) {
      const parsed = parseReply(this.buffer, 0)
      if (parsed === null) return
      this.buffer = this.buffer.subarray(parsed.offset)
      const waiter = this.waiters.shift()
      if (parsed.value instanceof RedisReplyError) waiter.reject(parsed.value)
      else waiter.resolve(parsed.value)
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      if (this.failure !== undefined) {
        reject(this.failure)
        return
      }
      this.waiters.push({ resolve, reject })
      this.drain()
    })
  }

  async command(argv) {
    if (this.failure !== undefined) throw this.failure
    const payload = encodeCommand(argv)
    await new Promise((resolve, reject) => {
      this.socket.write(payload, (error) => (error ? reject(error) : resolve()))
    })
    return this.read()
  }

  close() {
    this.fail(new Error('Redis 连接已关闭'))
    try {
      this.socket.destroy()
    } catch {
      /* 忽略 */
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function connect(conn, timeoutMs) {
  const socket = await openSocket(conn, timeoutMs)
  const client = new RedisClient(socket)
  const password = readSecret(conn)
  if (password !== undefined) {
    const user = typeof conn.user === 'string' && conn.user !== '' ? conn.user : undefined
    const argv = user === undefined ? ['AUTH', password] : ['AUTH', user, password]
    await withTimeout(client.command(argv), timeoutMs, 'Redis AUTH 超时')
  }
  if (Number(conn.db) > 0) {
    await withTimeout(client.command(['SELECT', String(conn.db)]), timeoutMs, 'Redis SELECT 超时')
  }
  return client
}

/** 执行一条命令，返回原始回复。 */
export async function runRedis(conn, argv, options) {
  assertSafeRedisCommand(conn, argv)
  const client = await connect(conn, options.timeoutMs)
  try {
    return await withTimeout(
      client.command(argv),
      options.timeoutMs,
      `Redis 命令超时（${options.timeoutMs}ms）`,
    )
  } finally {
    client.close()
  }
}

export async function probeRedis(conn, options) {
  const startedAt = Date.now()
  const client = await connect(conn, options.timeoutMs)
  try {
    const pong = await withTimeout(client.command(['PING']), options.timeoutMs, 'Redis PING 超时')
    let version = ''
    try {
      const info = await withTimeout(client.command(['INFO', 'server']), options.timeoutMs, 'Redis INFO 超时')
      version = /redis_version:([^\r\n]+)/.exec(`${info}`)?.[1]?.trim() ?? ''
    } catch {
      /* INFO 可能被 rename/禁用，不影响探测结论 */
    }
    return {
      detail: `PING=${pong}${version === '' ? '' : ` redis_version=${version}`}`,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    client.close()
  }
}

/** 把 Redis 回复折成一段文本。 */
export function formatRedisReply(value) {
  if (value === null || value === undefined) return '(nil)'
  if (typeof value === 'string') return truncate(value, 4000)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return truncate(JSON.stringify(value), 4000)
  } catch {
    return truncate(String(value), 4000)
  }
}

/** 把 "INFO memory" 这类命令串切成 argv，支持单双引号。 */
export function splitCommandLine(line) {
  const text = `${line}`.trim()
  const argv = []
  let current = ''
  let quote
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (char === '\\' && text[index + 1] === quote) {
        current += quote
        index += 1
        continue
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (current !== '') {
        argv.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') argv.push(current)
  return argv
}
