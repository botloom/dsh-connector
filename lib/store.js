/**
 * 连接配置的写入口。
 *
 * UI（/wsconn/api）和工具（conn_edit）都走这里，避免两套逻辑：
 *   纯函数 applyConnectionChange 负责算新配置，
 *   editConfig 负责通过 configEditor 落盘。
 *
 * 配置只有一个扁平 connections 列表；旧的 workspaces[].connections
 * 在第一次写入时自动搬进来（保留顺序，同名保留前者）。
 */

import { normalizeConnection } from './config.js'

const ACTIONS = new Set(['add', 'update', 'delete'])

function compact(value) {
  return JSON.parse(JSON.stringify(value))
}

function dropEmpty(connection) {
  const cleaned = {}
  for (const [field, value] of Object.entries(connection ?? {})) {
    if (value === '' || value === undefined || value === null) continue
    cleaned[field] = value
  }
  return cleaned
}

/** 把 workspaces[].connections 合并到顶层 connections，返回可写的副本。 */
function migrate(current) {
  const next = { ...(current ?? {}) }
  const flat = Array.isArray(next.connections) ? next.connections.map((item) => ({ ...item })) : []
  const names = new Set(flat.map((item) => `${item?.name ?? ''}`.toLowerCase()))

  if (Array.isArray(next.workspaces)) {
    next.workspaces = next.workspaces.map((workspace) => {
      const list = Array.isArray(workspace?.connections) ? workspace.connections : []
      for (const raw of list) {
        const key = `${raw?.name ?? ''}`.toLowerCase()
        if (key === '' || names.has(key)) continue
        flat.push({ ...raw })
        names.add(key)
      }
      return { ...workspace, connections: [] }
    })
  }

  next.connections = flat
  return { next, flat }
}

/**
 * 纯函数：返回 { config, message, connection }。
 * action=update 时未填的 password/token 会保留原值（空字符串视为「不修改」）。
 */
export function applyConnectionChange(current, request) {
  const action = request?.action
  if (!ACTIONS.has(action)) throw new Error('action 只能是 add / update / delete')
  const name = typeof request?.name === 'string' ? request.name.trim() : ''
  if (name === '') throw new Error('连接名不能为空')

  const { next, flat } = migrate(current)
  const position = flat.findIndex((connection) => `${connection?.name ?? ''}`.toLowerCase() === name.toLowerCase())

  let message = ''
  let saved

  if (action === 'delete') {
    if (position === -1) throw new Error(`没有名为 ${name} 的连接`)
    flat.splice(position, 1)
    message = `已删除连接 ${name}`
  } else {
    if (action === 'add' && position !== -1) throw new Error(`连接 ${name} 已存在，改用 update`)
    if (action === 'update' && position === -1) throw new Error(`连接 ${name} 不存在，改用 add`)
    if (request?.connection === null || typeof request?.connection !== 'object' || Array.isArray(request.connection)) {
      throw new Error('connection 必须是一个对象')
    }
    const provided = dropEmpty(request.connection)
    const base = position === -1 ? {} : flat[position]
    // 表单里的 name 是新名字；request.name 是定位用的旧名字。改名前查重。
    const requestedName =
      typeof provided.name === 'string' && provided.name.trim() !== '' ? provided.name.trim() : name
    if (requestedName.toLowerCase() !== name.toLowerCase()) {
      const clash = flat.some(
        (item, index) => index !== position && `${item?.name ?? ''}`.toLowerCase() === requestedName.toLowerCase(),
      )
      if (clash) throw new Error(`连接 ${requestedName} 已存在`)
    }
    const merged = { ...base, ...provided, name: requestedName }
    const normalized = normalizeConnection(merged, '连接配置')
    saved = compact(normalized)
    flat[position === -1 ? flat.length : position] = saved
    message = `${action === 'add' ? '已新增' : '已更新'}连接 ${requestedName}`
  }

  next.connections = flat
  return { config: next, message, connection: saved }
}

/**
 * 用表单草稿 + 已保存连接合成一个可探测的连接对象。
 * 空字符串不覆盖既有值，所以「密码留空」在测试时也会沿用已保存的密码。
 */
export function draftConnection(base, draft, name) {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('connection 必须是一个对象')
  }
  const merged = { ...(base ?? {}), ...dropEmpty(draft) }
  if (typeof merged.name !== 'string' || merged.name.trim() === '') {
    merged.name = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'draft'
  }
  return normalizeConnection(merged, '测试连接')
}

function requireEditor(ctx) {
  const entry = ctx.fiber?.entry
  const editor = ctx.get('configEditor')
  if (entry === undefined || editor === undefined) {
    throw new Error('当前 profile 无法保存配置（缺少 configEditor），请直接编辑 cordis.patch.yml')
  }
  return { entry, editor }
}

/** 通过 configEditor 落盘；返回给用户的说明。 */
export async function editConfig(ctx, mutate) {
  const { entry, editor } = requireEditor(ctx)
  let result
  await editor.edit(entry, (current) => {
    result = mutate(current)
    return result.config
  })
  return result
}

export async function editConnection(ctx, request) {
  const result = await editConfig(ctx, (current) => applyConnectionChange(current, request))
  return result.message
}

/** 导出用：把当前连接池整理成可保存/传输的 JSON（含密码，调用方自行保管）。 */
export function exportPayload(current) {
  const { flat } = migrate(current)
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: flat.map((connection) => compact(connection)),
  }
}

/**
 * 纯函数：把导入的 JSON 合并进当前配置。
 * mode=merge 同名覆盖、其余追加；mode=replace 先清空再导入。
 * 单条失败只记进 errors，不影响其它连接。
 */
export function applyImport(current, payload, mode = 'merge') {
  const incoming = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.connections)
      ? payload.connections
      : undefined
  if (incoming === undefined) throw new Error('导入内容里没有 connections 数组')

  const { next, flat } = migrate(current)
  if (mode === 'replace') flat.length = 0

  const positions = new Map(flat.map((connection, index) => [`${connection?.name ?? ''}`.toLowerCase(), index]))
  const added = []
  const updated = []
  const errors = []

  for (const [index, raw] of incoming.entries()) {
    const label =
      typeof raw?.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : `第 ${index + 1} 条`
    try {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是对象')
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      if (name === '') throw new Error('缺少 name')
      const saved = compact(normalizeConnection({ ...raw, name }, '导入连接'))
      const existing = positions.get(name.toLowerCase())
      if (existing === undefined) {
        positions.set(name.toLowerCase(), flat.length)
        flat.push(saved)
        added.push(name)
      } else {
        flat[existing] = saved
        updated.push(name)
      }
    } catch (error) {
      errors.push(`${label}: ${error?.message ?? error}`)
    }
  }

  next.connections = flat
  return { config: next, added, updated, errors }
}
