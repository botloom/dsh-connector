/**
 * 驱动注册表。
 *
 * 连接类型 = 一个驱动对象（见 lib/drivers/*.js）。新增类型只要加一个驱动文件
 * 并在下面 import/registerDriver，不再需要改 config.js / connectors/index.js / index.js。
 *
 * 外部驱动可用配置里的 `driversDir` 指定目录，loadExternalDrivers() 会扫描
 * *.js / *.mjs 并逐个 registerDriver；单个文件失败只 warn，不影响内置驱动。
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const registry = new Map()
const aliasToKind = new Map()

export const DRIVER_CATEGORIES = ['database', 'cache', 'server', 'api', 'search', 'message', 'agent']

function normalizeAliasList(aliases, kind) {
  if (aliases === undefined) return []
  if (!Array.isArray(aliases)) throw new Error(`驱动 ${kind} 的 aliases 必须是数组`)
  const list = []
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias.trim() === '') {
      throw new Error(`驱动 ${kind} 的 aliases 里有非法项`)
    }
    const key = alias.trim().toLowerCase()
    if (key !== kind) list.push(key)
  }
  return list
}

function normalizeActions(actions, kind) {
  if (actions === undefined) return []
  if (!Array.isArray(actions)) throw new Error(`驱动 ${kind} 的 actions 必须是数组`)
  return actions.map((action) => {
    if (action === null || typeof action !== 'object') {
      throw new Error(`驱动 ${kind} 的 action 必须是对象`)
    }
    const id = typeof action.id === 'string' ? action.id.trim() : ''
    if (id === '') throw new Error(`驱动 ${kind} 有 action 缺少 id`)
    return {
      ...action,
      id,
      label: typeof action.label === 'string' && action.label !== '' ? action.label : id,
      params: Array.isArray(action.params) ? action.params : [],
    }
  })
}

/** 注册（或覆盖）一个驱动；返回归一化后的驱动对象。 */
export function registerDriver(driver) {
  if (driver === null || typeof driver !== 'object' || Array.isArray(driver)) {
    throw new Error('驱动必须是对象')
  }
  const kind = typeof driver.kind === 'string' ? driver.kind.trim().toLowerCase() : ''
  if (kind === '') throw new Error('驱动缺少 kind')
  if (typeof driver.label !== 'string' || driver.label.trim() === '') {
    throw new Error(`驱动 ${kind} 缺少 label`)
  }
  if (typeof driver.validate !== 'function') throw new Error(`驱动 ${kind} 缺少 validate()`)
  if (typeof driver.probe !== 'function') throw new Error(`驱动 ${kind} 缺少 probe()`)
  if (typeof driver.call !== 'function') throw new Error(`驱动 ${kind} 缺少 call()`)

  const aliases = normalizeAliasList(driver.aliases, kind)
  const actions = normalizeActions(driver.actions, kind)

  // 先检查别名冲突，再落表，避免注册到一半留下脏数据
  for (const alias of aliases) {
    const owner = aliasToKind.get(alias)
    if (owner !== undefined && owner !== kind) {
      throw new Error(`驱动 ${kind} 的别名「${alias}」已被 ${owner} 占用`)
    }
  }

  const normalized = {
    kind,
    label: driver.label.trim(),
    category: typeof driver.category === 'string' && driver.category !== '' ? driver.category : 'api',
    aliases,
    defaultPort: Number.isFinite(driver.defaultPort) ? driver.defaultPort : undefined,
    fields: Array.isArray(driver.fields) ? driver.fields : [],
    secretFields: Array.isArray(driver.secretFields)
      ? driver.secretFields.filter((field) => typeof field === 'string' && field !== '')
      : ['password', 'token', 'secret'],
    actions,
    validate: driver.validate,
    probe: driver.probe,
    call: driver.call,
    callArgs: typeof driver.callArgs === 'function' ? driver.callArgs : undefined,
    describe: typeof driver.describe === 'function' ? driver.describe : undefined,
  }

  registry.set(kind, normalized)
  aliasToKind.set(kind, kind)
  for (const alias of aliases) aliasToKind.set(alias, kind)
  return normalized
}

/** 按 kind / alias 找驱动；找不到抛错并列出可用的 kind。 */
export function getDriver(kind) {
  const resolved = normalizeKind(kind)
  if (resolved === undefined) {
    throw new Error(`没有注册连接类型「${kind}」（可用：${listKinds().join('/')}）`)
  }
  return registry.get(resolved)
}

/** 走 kind + aliases；未知名返回 undefined。 */
export function normalizeKind(text) {
  if (typeof text !== 'string') return undefined
  const key = text.trim().toLowerCase()
  if (key === '') return undefined
  return aliasToKind.get(key)
}

/** 已注册驱动的数组（含函数，给 Host 逻辑用）。 */
export function listDrivers() {
  return [...registry.values()]
}

export function listKinds() {
  return [...registry.keys()]
}

/** 给 UI 的纯数据清单（不含函数，可直接 JSON 序列化）。 */
export function driverManifests() {
  return listDrivers().map((driver) => ({
    kind: driver.kind,
    label: driver.label,
    category: driver.category,
    defaultPort: driver.defaultPort,
    aliases: [...driver.aliases],
    fields: driver.fields.map((field) => ({ ...field })),
    actions: driver.actions.map((action) => ({ ...action, params: action.params.map((param) => ({ ...param })) })),
    secretFields: [...driver.secretFields],
  }))
}

/**
 * 扫描目录加载外部驱动。默认不加载（driversDir 未配置）。
 * 单个文件失败只 warn，保留其它驱动可用。
 */
export async function loadExternalDrivers(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return []
  const root = path.resolve(dir)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    console.warn(`[ws-connections] 无法读取外部驱动目录 ${root}：${error?.message ?? error}`)
    return []
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.(js|mjs)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const loaded = []
  for (const file of files) {
    try {
      const module = await import(pathToFileURL(path.join(root, file)).href)
      const driver = module?.default
      if (driver === undefined) {
        console.warn(`[ws-connections] 外部驱动 ${file} 没有 default 导出（已跳过）`)
        continue
      }
      loaded.push(registerDriver(driver))
    } catch (error) {
      console.warn(`[ws-connections] 加载外部驱动 ${file} 失败：${error?.message ?? error}`)
    }
  }
  return loaded
}

// ---------- 内置驱动 ----------
import postgres from './postgres.js'
import mysql from './mysql.js'
import sqlite from './sqlite.js'
import redis from './redis.js'
import ssh from './ssh.js'
import http from './http.js'
import tcp from './tcp.js'
import elasticsearch from './elasticsearch.js'
import dingtalk from './dingtalk.js'
import feishu from './feishu.js'
import wecom from './wecom.js'
import slack from './slack.js'
import telegram from './telegram.js'
import webhook from './webhook.js'
import dsh from './dsh.js'
import jenkins from './jenkins.js'

export const BUILTIN_DRIVERS = [
  postgres,
  mysql,
  sqlite,
  redis,
  ssh,
  http,
  tcp,
  elasticsearch,
  dingtalk,
  feishu,
  wecom,
  slack,
  telegram,
  webhook,
  dsh,
  jenkins,
]

for (const driver of BUILTIN_DRIVERS) registerDriver(driver)
