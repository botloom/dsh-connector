/**
 * 连接配置的归一化与解析。
 *
 * 配置形状（cordis.patch.yml 里该插件行的 config）：
 *
 *   driversDir: 'C:/my-drivers'   # 可选：外部驱动目录（*.js/*.mjs）
 *   connections:
 *     - name: 'pg-main'
 *       kind: 'postgres'          # 任意已注册 kind（内置见 lib/drivers/）
 *       host: '10.0.0.5'
 *       port: 5432
 *       database: 'app'           # 可选
 *       user: 'readonly'
 *       passwordEnv: 'PG_PASSWORD'   # 或 password: '...'
 *       allowWrite: false
 *
 * 不再按工作区区分：所有连接放在一个池子里，任何会话都能用。
 * 旧配置（workspaces[].connections）会被自动合并进来，兼容不迁移。
 *
 * 校验/默认值全部交给驱动（lib/drivers/*.js 的 validate），这里只做
 * 名字/kind 解析、重复检测和 warning 收集；坏条目降级成 warning 并跳过，
 * 免得一条写错的连接让整个插件（以及所有工具）装不上。
 */

import { getDriver, listDrivers, listKinds, normalizeKind } from './drivers/index.js'
import { pickNumber, pickString } from './driver-kit.js'

// 兼容旧导出：kind → 显示名 / 支持的 kind 列表。外部驱动加载后这里不会变，
// 需要动态列表的地方请直接用 listDrivers() / listKinds()。
export const KIND_LABELS = Object.fromEntries(listDrivers().map((driver) => [driver.kind, driver.label]))
export const SUPPORTED_KINDS = listKinds()

/** 校验并补默认值；驱动不存在或配置非法时抛错（由调用方收集成 warning）。 */
export function normalizeConnection(raw, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} 的连接必须是对象`)
  }
  const name = pickString(raw.name)
  if (name === undefined) throw new Error(`${where} 有一条连接缺少 name`)
  const kindText = pickString(raw.kind) ?? pickString(raw.type)
  if (kindText === undefined) throw new Error(`连接 ${name} 缺少 kind`)

  const kind = normalizeKind(kindText)
  if (kind === undefined) {
    throw new Error(`连接 ${name} 的 kind「${kindText}」不支持（可用：${listKinds().join('/')}）`)
  }

  const driver = getDriver(kind)
  const conn = { ...raw, name, kind: driver.kind, timeoutMs: pickNumber(raw.timeoutMs) }
  const normalized = driver.validate(conn)
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error(`连接 ${name} 的驱动 ${driver.kind} 没有返回合法的配置对象`)
  }
  normalized.name = name
  normalized.kind = driver.kind
  normalized.timeoutMs = pickNumber(normalized.timeoutMs)
  normalized.disabled = raw.disabled === true
  return normalized
}

/** 把 config 归一化成一个连接池；旧的 workspaces[].connections 也合并进来。 */
export function normalizeConfig(config) {
  const warnings = []
  const connections = []
  const seen = new Set()

  const add = (raw, where) => {
    try {
      const connection = normalizeConnection(raw, where)
      const key = connection.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push(`连接名重复：${connection.name}（保留第一个，忽略 ${where}）`)
        return
      }
      seen.add(key)
      connections.push(connection)
    } catch (error) {
      warnings.push(`${error.message}（已跳过）`)
    }
  }

  if (Array.isArray(config?.connections)) {
    config.connections.forEach((raw, index) => add(raw, `connections[${index}]`))
  }
  if (Array.isArray(config?.workspaces)) {
    config.workspaces.forEach((workspace, workspaceIndex) => {
      if (Array.isArray(workspace?.connections)) {
        workspace.connections.forEach((raw, index) =>
          add(raw, `workspaces[${workspaceIndex}].connections[${index}]`),
        )
      }
    })
  }

  return {
    connections,
    warnings,
    driversDir: pickString(config?.driversDir),
    defaultTimeoutMs: pickNumber(config?.timeoutMs) ?? 15000,
    defaultMaxRows: Math.max(1, Math.min(500, pickNumber(config?.maxRows) ?? 50)),
  }
}

/** 取连接；池里只有一个连接时可以省略名字。 */
export function resolveConnection(connections, name, options = {}) {
  const all = Array.isArray(connections) ? connections : []
  const allowDisabled = options?.allowDisabled === true
  const pool = allowDisabled ? all : all.filter((connection) => connection?.disabled !== true)
  const wanted = pickString(name)
  if (wanted !== undefined) {
    const found = all.find((connection) => `${connection?.name ?? ''}`.toLowerCase() === wanted.toLowerCase())
    if (found === undefined) {
      const available = all.map((connection) => connection.name).join('、')
      throw new Error(`没有名为 ${wanted} 的连接。可用连接：${available || '（无）'}`)
    }
    if (found.disabled === true && !allowDisabled) {
      throw new Error(`连接 ${found.name} 已禁用：在连接器面板里启用后再用`)
    }
    return found
  }
  if (pool.length === 0) {
    if (all.length > 0) throw new Error('配置里的连接都被禁用了，先在面板里启用一个')
    throw new Error('还没有配置任何连接，先用 conn_edit 添加一个')
  }
  if (pool.length === 1) return pool[0]
  throw new Error(`现在有 ${pool.length} 个可用连接，请用 connection 指定：${pool.map((c) => c.name).join('、')}`)
}

// 密钥读取搬到了 lib/secret.js（断开 ESM 循环），这里 re-export 保持旧 import 可用。
export { readSecret, readSecretValue } from './secret.js'

/** 列给模型看的一行摘要：不包含密码。 */
export function describeConnection(conn) {
  if (conn === null || typeof conn !== 'object') return ''
  let driver
  try {
    driver = getDriver(conn.kind)
  } catch {
    driver = undefined
  }
  if (typeof driver?.describe === 'function') {
    try {
      return driver.describe(conn)
    } catch {
      /* 描述失败不影响调用方 */
    }
  }
  return `${driver?.label ?? conn.kind ?? '未知'} ${conn.name ?? ''}`.trim()
}

export function timeoutOf(conn, fallback) {
  return conn?.timeoutMs ?? fallback
}

/**
 * 连接池解析器：插件 apply 时注入，驱动（如 dsh 节点）用它按名字找别的连接。
 * 驱动只拿到自己的 conn 对象，拿不到整个连接池，所以需要这个回调。
 */
let poolResolver
export function setPoolResolver(resolver) {
  poolResolver = typeof resolver === 'function' ? resolver : undefined
}

export function resolveFromPool(name) {
  if (poolResolver === undefined || typeof name !== 'string' || name.trim() === '') return undefined
  return poolResolver(name.trim())
}
