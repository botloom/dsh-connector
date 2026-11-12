/** SSH：用 ssh2 直接连（支持账号密码，跟 Xshell 一样；也支持私钥）。 */

import { readFileSync } from 'node:fs'
import { readSecret } from '../secret.js'
import { assertTcpReachable } from './tcpcheck.js'

const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\/(\s|$)/, label: 'rm -rf /' },
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\/\*/, label: 'rm -rf /*' },
  { pattern: /\bmkfs(\.|\s|$)/, label: 'mkfs' },
  { pattern: /\bdd\s+[^\n]*\bof=\/dev\//, label: 'dd 写块设备' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, label: '关机/重启' },
  { pattern: /\binit\s+[06]\b/, label: 'init 0/6' },
  { pattern: /:\s*\(\s*\)\s*\{/, label: 'fork bomb' },
  { pattern: /\bchmod\s+-R\s+777\s+\//, label: 'chmod -R 777 /' },
  { pattern: /\btruncate\s+-s\s*0\b/, label: 'truncate 文件到 0' },
  { pattern: />\s*\/dev\/sd[a-z]/, label: '覆盖块设备' },
]

export function assertSafeSshCommand(conn, command) {
  if (conn.allowDestructive === true) return
  if (`${command}`.trim() === '') throw new Error('远程命令为空')
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`拒绝执行远程命令：命中「${label}」。确需执行时给连接加 allowDestructive: true。`)
    }
  }
}

async function loadSsh2() {
  try {
    return await import('ssh2')
  } catch (error) {
    throw new Error(`SSH 需要 ssh2 驱动：在插件目录执行 npm install ssh2；原始错误：${error?.message ?? error}`)
  }
}

function clientConfig(conn, timeoutMs) {
  const config = {
    host: conn.host,
    port: conn.port ?? 22,
    username: conn.user,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  }
  const password = readSecret(conn)
  if (password !== undefined) {
    config.password = password
  } else if (typeof conn.keyPath === 'string' && conn.keyPath !== '') {
    config.privateKey = readFileSync(conn.keyPath)
    if (typeof conn.keyPassphrase === 'string' && conn.keyPassphrase !== '') {
      config.passphrase = conn.keyPassphrase
    }
  } else if (typeof conn.agent === 'string' && conn.agent !== '') {
    config.agent = conn.agent
  }
  if (typeof conn.algorithms === 'object' && conn.algorithms !== null) config.algorithms = conn.algorithms
  return config
}

async function connect(conn, timeoutMs) {
  const { Client } = await loadSsh2()
  const client = new Client()
  const config = clientConfig(conn, timeoutMs)

  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      client.end()
      reject(
        new Error(
          `SSH 连接 ${conn.host}:${conn.port ?? 22} 超时（${timeoutMs}ms）：确认网络/VPN 是否通、端口有没有被防火墙拦，必要时把连接的超时时间调大`,
        ),
      )
    }, timeoutMs)

    client.once('ready', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
    client.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`SSH 连接 ${conn.host}:${conn.port ?? 22} 失败：${error.message}`))
    })
    try {
      client.connect(config)
    } catch (error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`SSH 连接失败：${error?.message ?? error}`))
    }
  })

  return client
}

/** 供交互式 shell 会话复用：返回已 ready 的 ssh2 Client。 */
export async function connectSsh(conn, timeoutMs) {
  return connect(conn, timeoutMs)
}

async function exec(conn, command, timeoutMs) {
  const client = await connect(conn, timeoutMs)
  const startedAt = Date.now()
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSH 命令超时（${timeoutMs}ms）`)), timeoutMs)
      client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer)
          reject(new Error(`SSH 执行失败：${error.message}`))
          return
        }
        let stdout = ''
        let stderr = ''
        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8')
        })
        stream.on('close', (code) => {
          clearTimeout(timer)
          resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 0 })
        })
      })
    })
    return { ...result, elapsedMs: Date.now() - startedAt }
  } finally {
    client.end()
  }
}

export async function runSsh(conn, command, options) {
  assertSafeSshCommand(conn, command)
  return exec(conn, command, options.timeoutMs)
}

export async function probeSsh(conn, options) {
  await assertTcpReachable(conn.host, conn.port ?? 22, options.timeoutMs)
  const result = await exec(conn, 'echo ok', options.timeoutMs)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `ssh 退出码 ${result.exitCode}`)
  }
  return { detail: `登录成功${conn.user ? `（${conn.user}）` : ''}`, elapsedMs: result.elapsedMs }
}
