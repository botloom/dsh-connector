/** Redis 驱动：复用 lib/connectors/redis.js 的 RESP2 客户端，危险命令默认拒绝。 */

import { formatRedisReply, probeRedis, runRedis, splitCommandLine } from '../connectors/redis.js'
import { clampNumber, pickNumber, pickString } from '../driver-kit.js'

const LABEL = 'Redis'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

async function execAction(conn, args, opts) {
  const argv = splitCommandLine(args?.command ?? '')
  if (argv.length === 0) throw new Error('command 不能为空')
  const value = await runRedis(conn, argv, { timeoutMs: timeoutOf(conn, opts) })
  const command = String(argv[0]).toUpperCase()
  const note = command === 'KEYS' ? '\n（KEYS 会遍历全库并阻塞 Redis，线上优先用 SCAN）' : ''
  return {
    text: `${conn.name} · ${command}\n${formatRedisReply(value)}${note}`,
    meta: { command, argv: argv.slice(0, 8) },
  }
}

export default {
  kind: 'redis',
  label: LABEL,
  category: 'cache',
  aliases: [],
  defaultPort: 6379,
  fields: [
    { name: 'host', label: '主机', type: 'text', placeholder: '127.0.0.1' },
    { name: 'port', label: '端口', type: 'number', placeholder: '6379' },
    { name: 'db', label: '数据库编号', type: 'number', placeholder: '0' },
    { name: 'user', label: '用户名', type: 'text', hint: 'Redis 6+ ACL 才需要' },
    { name: 'password', label: '密码', type: 'password' },
    { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
    { name: 'tls', label: 'TLS', type: 'boolean' },
    { name: 'allowDangerous', label: '允许危险命令', type: 'boolean' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['password'],
  actions: [
    {
      id: 'exec',
      label: '执行命令',
      primary: true,
      params: [
        { name: 'command', label: '命令', type: 'text', required: true, placeholder: 'HGETALL user:1' },
      ],
    },
  ],

  validate(conn) {
    return {
      ...conn,
      host: pickString(conn.host) ?? '127.0.0.1',
      port: pickNumber(conn.port) ?? 6379,
      db: pickNumber(conn.db) ?? 0,
      allowDangerous: conn.allowDangerous === true,
    }
  },

  async probe(conn, opts) {
    return probeRedis(conn, { timeoutMs: timeoutOf(conn, opts) })
  },

  async call(conn, action, args, opts) {
    if (action === 'exec') return execAction(conn, args, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：exec`)
  },

  async callArgs(conn, args, opts) {
    return execAction(conn, args, opts)
  },

  describe(conn) {
    return `${LABEL} ${conn.host}:${conn.port} db=${clampNumber(conn.db, 0, 65535, 0)}`
  },
}
