/** SSH 驱动：复用 lib/connectors/ssh.js（ssh2 直连），破坏性命令默认拒绝。 */

import { probeSsh, runSsh } from '../connectors/ssh.js'
import { clampNumber, pickNumber, pickString } from '../driver-kit.js'
import { formatDuration, truncate } from '../format.js'

const LABEL = 'SSH'

function timeoutOf(conn, opts) {
  return pickNumber(conn?.timeoutMs) ?? pickNumber(opts?.timeoutMs) ?? 15000
}

async function execAction(conn, args, opts) {
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command.trim() === '') throw new Error('command 不能为空')
  const timeoutMs = clampNumber(args?.timeoutMs, 1000, 120000, timeoutOf(conn, opts))

  const result = await runSsh(conn, command, { timeoutMs })
  const parts = [`${conn.name} · exit=${result.exitCode} · ${formatDuration(result.elapsedMs)}`]
  if (result.stdout.trim() !== '') parts.push(truncate(result.stdout.trim(), 6000))
  if (result.stderr.trim() !== '') parts.push(`stderr: ${truncate(result.stderr.trim(), 2000)}`)
  return {
    text: parts.join('\n'),
    meta: { exitCode: result.exitCode, elapsedMs: result.elapsedMs },
  }
}

export default {
  kind: 'ssh',
  label: LABEL,
  category: 'server',
  aliases: ['shell'],
  defaultPort: 22,
  fields: [
    { name: 'host', label: '主机', type: 'text', required: true },
    { name: 'port', label: '端口', type: 'number', placeholder: '22' },
    { name: 'user', label: '用户名', type: 'text' },
    { name: 'password', label: '密码', type: 'password' },
    { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
    { name: 'keyPath', label: '私钥路径', type: 'text' },
    { name: 'keyPassphrase', label: '私钥口令', type: 'password' },
    { name: 'agent', label: 'Agent Socket', type: 'text' },
    { name: 'allowDestructive', label: '允许破坏性命令', type: 'boolean' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['password', 'keyPassphrase'],
  actions: [
    {
      id: 'exec',
      label: '执行命令',
      primary: true,
      params: [
        { name: 'command', label: '命令', type: 'text', required: true },
        { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
      ],
    },
  ],

  validate(conn) {
    const host = pickString(conn.host)
    if (host === undefined) throw new Error(`连接 ${conn.name} 缺少 host`)
    return {
      ...conn,
      host,
      port: pickNumber(conn.port) ?? 22,
      user: pickString(conn.user),
      allowDestructive: conn.allowDestructive === true,
    }
  },

  async probe(conn, opts) {
    return probeSsh(conn, { timeoutMs: timeoutOf(conn, opts) })
  },

  async call(conn, action, args, opts) {
    if (action === 'exec') return execAction(conn, args, opts)
    throw new Error(`${LABEL} 连接 ${conn.name} 不支持动作「${action}」，可用：exec`)
  },

  async callArgs(conn, args, opts) {
    return execAction(conn, args, opts)
  },

  describe(conn) {
    const who = conn.user ? `${conn.user}@` : ''
    return `${LABEL} ${who}${conn.host}:${conn.port}`
  },
}
