/** TCP 驱动：端口可达性探测（复用 lib/connectors/tcp.js）。 */

import { probeTcp } from '../connectors/tcp.js'
import { pickNumber, pickString } from '../driver-kit.js'
import { formatDuration } from '../format.js'

const LABEL = 'TCP'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

async function checkAction(conn, opts) {
  const result = await probeTcp(conn, { timeoutMs: timeoutOf(conn, opts) })
  return {
    text: `${conn.name} · ${result.detail} · ${formatDuration(result.elapsedMs)}`,
    meta: { host: conn.host, port: conn.port, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'tcp',
  label: LABEL,
  category: 'server',
  aliases: ['port'],
  defaultPort: undefined,
  fields: [
    { name: 'host', label: '主机', type: 'text', required: true },
    { name: 'port', label: '端口', type: 'number', required: true },
    { name: 'send', label: '首包内容', type: 'text', hint: '可选，用来触发服务端 banner' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: [],
  actions: [
    {
      id: 'check',
      label: '探测端口',
      primary: true,
      params: [],
    },
  ],

  validate(conn) {
    const host = pickString(conn.host)
    if (host === undefined) throw new Error(`连接 ${conn.name} 缺少 host`)
    const port = pickNumber(conn.port)
    if (port === undefined) throw new Error(`连接 ${conn.name} 缺少 port`)
    return { ...conn, host, port }
  },

  async probe(conn, opts) {
    return probeTcp(conn, { timeoutMs: timeoutOf(conn, opts) })
  },

  async call(conn, action, _args, opts) {
    if (action === 'check' || action === 'probe') return checkAction(conn, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：check`)
  },

  async callArgs(conn, _args, opts) {
    return checkAction(conn, opts)
  },

  describe(conn) {
    return `${LABEL} ${conn.host}:${conn.port}`
  },
}
