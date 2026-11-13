/**
 * 连接器 —— 按连接池工作，不区分工作区。
 *
 * 所有配置过的连接（数据库 / 缓存 / 服务器 / HTTP / 消息机器人…）放在一个池子里，
 * 任何会话都能直接用；没有「当前工作区」这套判断。
 *
 * 设计约束：
 * - 只有 tools 是硬依赖，其余服务（systemPrompt/configEditor/webServer）按需取。
 * - 连接类型由驱动注册表（lib/drivers/）决定，新增类型只要加一个驱动文件。
 * - 默认只读：SQL 写语句、Redis 危险命令、SSH 破坏性命令都要连接级开关 +
 *   调用级确认两道门。
 * - 连接配置里不落密码：优先 passwordEnv / tokenEnv / secretEnv。
 */

import {
  describeConnection,
  normalizeConfig,
  resolveConnection,
  setPoolResolver,
} from './lib/config.js'
import { formatDuration, oneLine } from './lib/format.js'
import { probeConnection } from './lib/connectors/index.js'
import { driverManifests, getDriver, listDrivers, loadExternalDrivers } from './lib/drivers/index.js'
import { API_PREFIX, createApiHandler } from './lib/api.js'
import { applyImport, editConfig, editConnection, exportPayload } from './lib/store.js'
import {
  cancelTask,
  claimTask,
  ensureSchema,
  listTasks,
  findByCapability,
  parseRoutes,
  retryTask,
  finishTask,
  heartbeat,
  listPeers,
  peerConfig,
  readTask,
  sendTask,
  startPeerLoop,
} from './lib/peer.js'

export const name = 'ws-connections'
/** 只要 Host 的 tools 服务。 */
export const inject = ['tools']

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function present(title, kind, rawInput) {
  return {
    card: 'generic',
    title,
    kind,
    ...(rawInput === undefined ? {} : { rawInput }),
  }
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function actionText(action) {
  const params = (Array.isArray(action.params) ? action.params : [])
    .map((param) => `${param.name}${param.required ? '*' : ''}`)
    .join(', ')
  return `${action.id}(${params})${action.primary ? ' [主]' : ''}`
}

export async function apply(ctx, config = {}) {
  // 外部驱动必须在归一化连接之前注册，否则新 kind 会被当成未知类型。
  // 没配 driversDir 时这里没有 await，apply 的同步部分行为与旧版一致。
  if (typeof config?.driversDir === 'string' && config.driversDir.trim() !== '') {
    await loadExternalDrivers(config.driversDir)
  }
  const state = normalizeConfig(config)

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (typeof logger?.[level] === 'function') logger[level](`[ws-connections] ${message}`)
      else console.warn(`[ws-connections] ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }
  for (const warning of state.warnings) log('warn', warning)

  setPoolResolver((name) => resolveConnection(state.connections, name))

  const connection = (name) => resolveConnection(state.connections, name)

  function callOptions(conn) {
    return {
      timeoutMs: conn.timeoutMs ?? state.defaultTimeoutMs,
      maxRows: state.defaultMaxRows,
    }
  }

  function sqlConnection(name) {
    const conn = connection(name)
    if (conn.kind !== 'postgres' && conn.kind !== 'mysql' && conn.kind !== 'sqlite') {
      throw new Error(`连接 ${conn.name} 是 ${conn.kind}，不是 SQL 连接（db_query 只支持 postgres/mysql/sqlite）`)
    }
    return conn
  }

  function typedConnection(name, kind) {
    const conn = connection(name)
    if (conn.kind !== kind) {
      throw new Error(`连接 ${conn.name} 是 ${conn.kind}，这个工具需要 ${kind} 连接`)
    }
    return conn
  }

  const kinds = listDrivers().map((driver) => driver.kind)

  ctx.tools.register({
    name: 'conn_catalog',
    description:
      '列出所有已注册的连接类型（驱动）：kind、分类、字段、可用动作及参数。模型靠它发现「能连什么、每类能做什么」，具体调用用 conn_call。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const manifests = driverManifests()
      if (manifests.length === 0) return { text: '没有注册任何驱动' }
      const lines = [`已注册 ${manifests.length} 种连接类型（调用入口 conn_call）：`]
      for (const manifest of manifests) {
        const fields = manifest.fields.map((field) => `${field.name}${field.required ? '*' : ''}`).join(', ') || '-'
        const actions =
          manifest.actions.length === 0 ? '（无动作）' : manifest.actions.map(actionText).join(' / ')
        lines.push(`- ${manifest.kind} · ${manifest.label}（${manifest.category}）`)
        lines.push(`  字段：${fields}`)
        lines.push(`  动作：${actions}`)
      }
      lines.push('（字段名后带 * 的是必填；动作参数同理）')
      return { text: lines.join('\n') }
    },
    presentCall: () => present('查看驱动', 'read'),
  })

  ctx.tools.register({
    name: 'conn_call',
    description: `统一驱动入口：按连接类型执行一个动作。已注册 kind：${kinds.join('/')}。先用 conn_catalog 查动作与参数。`,
    parameters: {
      connection: {
        type: 'string',
        description: '连接名；只有一个连接时可省略。',
      },
      action: {
        type: 'string',
        description: '驱动的 action id；省略时用该类型的主动作。',
      },
      args: {
        type: 'object',
        description: '动作参数对象，字段与是否必填见 conn_catalog。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const conn = connection(args?.connection)
      const driver = getDriver(conn.kind)
      const actions = Array.isArray(driver.actions) ? driver.actions : []
      let actionId = typeof args?.action === 'string' ? args.action.trim() : ''
      if (actionId === '') {
        actionId = actions.find((action) => action.primary)?.id ?? actions[0]?.id ?? ''
      }
      if (actionId !== '' && !actions.some((action) => action.id === actionId)) {
        throw new Error(
          `连接 ${conn.name}（${driver.label}）没有动作「${actionId}」，可用：${actions.map((action) => action.id).join('/') || '（无）'}`,
        )
      }

      const callArgs = args?.args === undefined || args.args === null ? {} : args.args
      const result =
        actionId === '' && typeof driver.callArgs === 'function'
          ? await driver.callArgs(conn, callArgs, callOptions(conn))
          : await driver.call(conn, actionId, callArgs, callOptions(conn))
      return { text: result.text }
    },
    presentCall: (args) =>
      present('调用连接', 'execute', `${args?.connection ?? ''} ${args?.action ?? ''}`.trim()),
  })

  ctx.tools.register({
    name: 'conn_list',
    description:
      '列出已配置的全部连接（数据库、Redis、SSH 服务器、HTTP 接口、TCP 端口、消息机器人等）及其地址与读写限制。连接是全局的，不分工作区。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      if (state.connections.length === 0) {
        return { text: '还没有配置任何连接。用 conn_edit（action=add）添加，或在「连接器」面板里新建。' }
      }
      const lines = state.connections.flatMap((conn) => {
        const head = `- ${conn.name}${conn.disabled === true ? '（已禁用）' : ''} · ${describeConnection(conn)}`
        return conn.notes === undefined ? [head] : [head, ...conn.notes.split(/\r?\n/).map((line) => `    说明：${line}`)]
      })
      return { text: [`已配置 ${state.connections.length} 个连接：`, ...lines].join('\n') }
    },
    presentCall: () => present('查看连接', 'read'),
  })

  ctx.tools.register({
    name: 'conn_check',
    description:
      '逐个探测连接是否可达：按驱动执行探测（数据库建连执行最小查询、Redis PING、SSH 登录、HTTP 请求、TCP 端口握手、消息 webhook 只校验可达性不发消息）；返回耗时和失败原因。排查连不上时先用它。',
    parameters: {
      name: {
        type: 'string',
        description: '只探测指定连接名；省略则探测全部连接。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const targets =
        typeof args?.name === 'string' && args.name.trim() !== ''
          ? [connection(args.name)]
          : state.connections
      if (targets.length === 0) throw new Error('还没有配置任何连接')

      const lines = await Promise.all(
        targets.map(async (conn) => {
          try {
            const result = await probeConnection(conn, state.defaultTimeoutMs)
            return `OK   ${conn.name} · ${describeConnection(conn)} · ${result.detail} · ${formatDuration(result.elapsedMs)}`
          } catch (error) {
            return `FAIL ${conn.name} · ${describeConnection(conn)} · ${oneLine(error?.message ?? error, 300)}`
          }
        }),
      )
      return { text: lines.join('\n') }
    },
    presentCall: (args) => present('探测连接', 'execute', args?.name),
  })

  ctx.tools.register({
    name: 'db_query',
    description:
      '在 PostgreSQL / MySQL / SQLite 连接上执行一条 SQL 并返回结果表。默认只读：写语句需要连接配置 allowWrite 且本次传 write: true。',
    parameters: {
      sql: {
        type: 'string',
        required: true,
        description: '单条 SQL，不支持多语句。',
      },
      connection: {
        type: 'string',
        description: '连接名；只有一个连接时可省略。',
      },
      database: {
        type: 'string',
        description: '库名；连接配置里没写 database 时必填（PostgreSQL / MySQL）。',
      },
      params: {
        type: 'array',
        description: '绑定参数，按顺序对应 $1/$2（PostgreSQL）或 ?（MySQL/SQLite）。',
        items: {},
      },
      limit: {
        type: 'number',
        description: '最多返回行数，默认 50，上限 500。',
      },
      write: {
        type: 'boolean',
        description: '确认执行写语句；连接的 allowWrite 必须为 true。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const conn = sqlConnection(args?.connection)
      const sql = typeof args?.sql === 'string' ? args.sql : ''
      if (sql.trim() === '') throw new Error('sql 不能为空')
      const limit = clampNumber(args?.limit, 1, 500, state.defaultMaxRows)

      const result = await getDriver(conn.kind).call(
        conn,
        'query',
        {
          sql,
          params: args?.params,
          write: args?.write === true,
          database: args?.database,
          limit,
        },
        callOptions(conn),
      )
      return { text: result.text }
    },
    presentCall: (args) => present('执行 SQL', 'read', args?.sql),
  })

  ctx.tools.register({
    name: 'redis_exec',
    description:
      '在 Redis 连接上执行一条命令，命令串按空格切分，例如 "INFO memory"、"SCAN 0 MATCH user:* COUNT 100"。危险命令（FLUSHALL、CONFIG SET、EVAL 等）默认拒绝。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: '完整命令，例如 "HGETALL user:1"。',
      },
      connection: {
        type: 'string',
        description: '连接名；只有一个连接时可省略。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const conn = typedConnection(args?.connection, 'redis')
      const result = await getDriver(conn.kind).call(conn, 'exec', { command: args?.command }, callOptions(conn))
      return { text: result.text }
    },
    presentCall: (args) => present('执行 Redis 命令', 'execute', args?.command),
  })

  ctx.tools.register({
    name: 'ssh_exec',
    description:
      '在已配置的服务器上通过 SSH 执行一条命令，返回 stdout、stderr 和退出码。支持账号密码或私钥登录；破坏性命令（rm -rf /、mkfs、shutdown 等）默认拒绝。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: '在远端 shell 里执行的命令，例如 "systemctl status nginx --no-pager"。',
      },
      connection: {
        type: 'string',
        description: '连接名；只有一个连接时可省略。',
      },
      timeoutMs: {
        type: 'number',
        description: '超时毫秒数，默认沿用连接配置，上限 120000。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const conn = typedConnection(args?.connection, 'ssh')
      const command = typeof args?.command === 'string' ? args.command : ''
      if (command.trim() === '') throw new Error('command 不能为空')
      const timeoutMs = clampNumber(args?.timeoutMs, 1000, 120000, conn.timeoutMs ?? state.defaultTimeoutMs)

      const result = await getDriver(conn.kind).call(conn, 'exec', { command, timeoutMs }, callOptions(conn))
      return { text: result.text }
    },
    presentCall: (args) => present('SSH 执行命令', 'execute', args?.command),
  })

  ctx.tools.register({
    name: 'http_call',
    description:
      '对已配置的 HTTP 接口发一次请求，路径拼在 baseUrl 后，返回状态码、响应头和响应体。',
    parameters: {
      path: {
        type: 'string',
        description: '相对路径，例如 "/actuator/health"；省略则请求 baseUrl 本身。',
      },
      method: {
        type: 'string',
        description: 'HTTP 方法，默认 GET。',
      },
      body: {
        type: 'string',
        description: '请求体字符串；对象会按 JSON 发送。',
      },
      headers: {
        type: 'object',
        description: '附加请求头对象，例如 {"x-trace-id":"abc"}。',
      },
      connection: {
        type: 'string',
        description: '连接名；只有一个连接时可省略。',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const conn = typedConnection(args?.connection, 'http')
      const result = await getDriver(conn.kind).call(
        conn,
        'request',
        {
          path: args?.path,
          method: args?.method,
          body: args?.body,
          headers: args?.headers,
        },
        callOptions(conn),
      )
      return { text: result.text }
    },
    presentCall: (args) => present('请求 HTTP 接口', 'fetch', args?.path),
  })

  ctx.tools.register({
    name: 'conn_edit',
    description: `新增、修改或删除一个连接，写入插件配置后自动重载。用来把用户口述的地址落成配置。连接是全局的，不需要指定工作区。kind 可为：${kinds.join('/')}（驱动别名也接受）；各 kind 的字段用 conn_catalog 查。`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'update', 'delete', 'toggle'],
        description: 'add 新增、update 覆盖、delete 删除、toggle 启用/禁用（配合 disabled）。',
      },
      name: {
        type: 'string',
        required: true,
        description: '连接名，唯一，后续工具用它指定连接。',
      },
      disabled: {
        type: 'boolean',
        description: 'action=toggle 时用：true 禁用、false 启用。',
      },
      connection: {
        type: 'object',
        description: `完整连接对象，例如 {"kind":"postgres","host":"10.0.0.5","port":5432,"database":"app","user":"readonly","passwordEnv":"PG_PASSWORD"}；kind 可为 ${kinds.join('/')}。`,
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = args?.action
      if (action !== 'add' && action !== 'update' && action !== 'delete' && action !== 'toggle') {
        throw new Error('action 只能是 add / update / delete')
      }
      const name = typeof args?.name === 'string' ? args.name.trim() : ''
      if (name === '') throw new Error('name 不能为空')

      const message = await editConnection(ctx, {
        action,
        name,
        connection: args?.connection,
        disabled: action === 'toggle' ? args?.disabled === true : undefined,
      })

      return { text: `${message}。插件按新配置重载后，conn_list 就能看到。` }
    },
    presentCall: (args) => present('保存连接', 'edit', args?.name),
  })

  // 把连接清单放进模型上下文：不用先调工具就知道有哪些连接。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && state.connections.length > 0) {
    systemPrompt.section({
      name: 'workspace-connections',
      order: 45,
      text: () => {
        const lines = state.connections.flatMap((conn) => {
          const head = `- ${conn.name}${conn.disabled === true ? '（已禁用，调用会被拒绝）' : ''}：${describeConnection(conn)}`
          if (conn.notes === undefined) return [head]
          return [head, ...conn.notes.split(/\r?\n/).map((line) => `  ${line}`)]
        })
        return [
          '## 连接器（已配置连接）',
          '这些连接可用 conn_call 调用（先 conn_catalog 查驱动能力）；db_query / redis_exec / ssh_exec / http_call 是等价的快捷入口：',
          ...lines,
        ].join('\n')
      },
    })
  }

  ctx.tools.register({
    name: 'conn_export',
    description:
      '把连接器里的全部连接导出成 JSON（含密码，注意保管）。返回的文本可直接保存成 .json 文件，用于备份或导入到别的机器。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      return { text: JSON.stringify(exportPayload(state), null, 2) }
    },
    presentCall: () => present('导出连接配置', 'read'),
  })

  ctx.tools.register({
    name: 'conn_import',
    description:
      '从 JSON 导入连接：mode=merge（默认）同名覆盖、其余追加；mode=replace 先清空再导入。json 传导出得到的文件内容。',
    parameters: {
      json: { type: 'string', required: true, description: '导出的 JSON 文本（可直接粘贴文件内容）' },
      mode: { type: 'string', enum: ['merge', 'replace'], description: '默认 merge' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const raw = typeof args?.json === 'string' ? args.json : ''
      if (raw.trim() === '') throw new Error('json 不能为空')
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new Error('json 不是合法的 JSON')
      }
      const mode = args?.mode === 'replace' ? 'replace' : 'merge'
      const result = await editConfig(ctx, (current) => applyImport(current, payload, mode))
      const lines = [`导入完成：新增 ${result.added.length} 条，更新 ${result.updated.length} 条`]
      if (result.added.length > 0) lines.push(`新增：${result.added.join(', ')}`)
      if (result.updated.length > 0) lines.push(`更新：${result.updated.join(', ')}`)
      if (result.errors.length > 0) lines.push(`失败 ${result.errors.length} 条：\n${result.errors.join('\n')}`)
      return { text: lines.join('\n') }
    },
    presentCall: () => present('导入连接配置', 'edit'),
  })
  // ---------------- 跨 DSH 信箱（可选，配置了 config.peer 才启用） ----------------
  const hostOf = (value) => {
    if (typeof value !== 'string' || value === '') return ''
    try {
      return new URL(value).hostname
    } catch {
      return ''
    }
  }

  // 能力 = 本机能替别人做的事：按连接名、类型、目标主机各报一条
  const capabilityList = () => {
    const caps = new Set()
    for (const conn of state.connections) {
      if (conn.disabled === true || conn.kind === 'dsh') continue
      caps.add(`${conn.kind}:${conn.name}`)
      const host = typeof conn.host === 'string' && conn.host !== '' ? conn.host : hostOf(conn.baseUrl)
      if (host !== '') caps.add(`${conn.kind}:${host}`)
    }
    return [...caps]
  }

  const dshConnection = state.connections.find((item) => item.kind === 'dsh' && item.disabled !== true)
  const peer =
    peerConfig(config) ??
    (dshConnection === undefined ||
    typeof dshConnection.peerName !== 'string' ||
    dshConnection.peerName === '' ||
    typeof dshConnection.mailbox !== 'string' ||
    dshConnection.mailbox === ''
      ? undefined
      : {
          name: dshConnection.peerName,
          mailbox: dshConnection.mailbox,
          database: typeof dshConnection.database === 'string' ? dshConnection.database : undefined,
          pollMs: Math.max(1000, Math.min(60000, Number(dshConnection.pollMs) || 3000)),
          waitMs: 120000,
          routes: parseRoutes(dshConnection.routes),
          capabilities: capabilityList(),
        })
  const peerBase =

    peer === undefined ? undefined : state.connections.find((connection) => connection.name === peer.mailbox)
  const peerConnection =
    peerBase === undefined ? undefined : { ...peerBase, database: peer.database ?? peerBase.database }
  if (peer !== undefined && peerBase === undefined) {
    log('warn', `peer.mailbox 指向的连接不存在：${peer.mailbox}`)
  }
  const peerReady = peer !== undefined && peerConnection !== undefined

  // 给面板用的轻量事件流：右下角弹窗就靠它
  state.peerEvents = []
  // 用时间戳做起点：插件重载后序号仍单调递增，面板的 since 游标不会错位
  let peerEventSeq = Date.now()
  const pushPeerEvent = (event) => {
    peerEventSeq += 1
    state.peerEvents.push({
      id: peerEventSeq,
      at: Date.now(),
      kind: event.kind,
      from: event.task?.from ?? '',
      to: event.task?.to ?? '',
      sessionId: event.sessionId ?? event.task?.sessionId ?? '',
      text: `${(event.kind === 'received' ? event.task?.message : event.kind === 'done' ? event.reply : event.error) ?? ''}`.slice(0, 160),
    })
    if (state.peerEvents.length > 50) state.peerEvents.splice(0, state.peerEvents.length - 50)
  }

  if (peerReady) {
    ctx.effect(() => {
      let stop
      ensureSchema(peerConnection)
        .then(() => {
          if (typeof ctx.get === 'function' && ctx.get('sessionController') === undefined) {
            log('warn', 'peer 已配置，但当前 profile 没有 sessionController，只能收不能投')
          }
          stop = startPeerLoop({ ctx, connection: peerConnection, peer, log, onEvent: pushPeerEvent })
          log('info', `peer「${peer.name}」已接入信箱 ${peer.mailbox}，每 ${peer.pollMs}ms 轮询`)
        })
        .catch((error) => log('warn', `peer 初始化失败：${error?.message ?? error}`))
      return () => stop?.()
    })
  }

  const requirePeer = () => {
    if (!peerReady) {
      throw new Error('没有配置 peer：在插件 config 里加 peer.name 和 peer.mailbox（指向连接器里的 mysql/postgres 连接名）')
    }
    return { peer, connection: peerConnection }
  }

  ctx.tools.register({
    name: 'peer_list',
    description: '列出其他同事的 DSH 节点（通过共享信箱心跳），显示是否在线、最后活跃时间和工作目录。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const { connection } = requirePeer()
      const peers = await listPeers(connection)
      if (peers.length === 0) return { text: '信箱里还没有任何节点心跳。' }
      const lines = peers.map(
        (item) => {
          const caps =
            Array.isArray(item.capabilities) && item.capabilities.length > 0
              ? ` · 能力：${item.capabilities.slice(0, 6).join('、')}${item.capabilities.length > 6 ? '…' : ''}`
              : ''
          return `${item.online ? '在线' : '离线'}  ${item.name}${item.cwd ? ` · ${item.cwd}` : ''} · ${new Date(item.lastSeen).toLocaleString()}${caps}`
        },
      )
      return { text: lines.join('\n') }
    },
    presentCall: () => present('查看 DSH 节点', 'read'),
  })

  ctx.tools.register({
    name: 'peer_send',
    description:
      '把一句话发给另一个 DSH 节点（按 peer.name），让它投进目标会话执行。省略 sessionId 时对方会挑最近活跃的会话。返回 taskId，用 peer_wait 取结果。',
    parameters: {
      to: { type: 'string', required: true, description: '目标节点名（对方的 peer.name）。' },
      text: { type: 'string', required: true, description: '要对方执行的内容。' },
      sessionId: { type: 'string', description: '对方的目标会话 id；省略则由对方挑最近活跃会话。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { peer, connection } = requirePeer()
      const to = typeof args?.to === 'string' ? args.to.trim() : ''
      const text = typeof args?.text === 'string' ? args.text : ''
      if (to === '') throw new Error('to 不能为空')
      if (text.trim() === '') throw new Error('text 不能为空')
      const taskId = await sendTask(connection, {
        from: peer.name,
        to,
        sessionId: typeof args?.sessionId === 'string' ? args.sessionId.trim() : '',
        message: text,
      })
      return { text: `已投递给 ${to}，taskId=${taskId}\n用 peer_wait 等结果（对方要开着 DSH，轮询间隔 ${peer.pollMs}ms）。` }
    },
    presentCall: (args) => present('给同事派活', 'edit', args?.to),
  })

  ctx.tools.register({
    name: 'peer_doctor',
    description: '诊断跨 DSH 信箱：显示 peer 配置与连接解析结果，并手动执行一次建表/心跳/查询，把错误原样返回。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const info = {
        configured: peer !== undefined,
        peer: peer ?? null,
        mailboxFound: peerBase !== undefined,
        connection:
          peerConnection === undefined
            ? null
            : { name: peerConnection.name, kind: peerConnection.kind, database: peerConnection.database },
        sessionController: typeof ctx.get === 'function' ? ctx.get('sessionController') !== undefined : false,
      }
      if (!peerReady) return { text: JSON.stringify(info, null, 2) }
      const problems = []
      try {
        await ensureSchema(peerConnection)
        info.schema = 'ok'
      } catch (error) {
        problems.push(`schema: ${error?.message ?? error}`)
      }
      try {
        await heartbeat(peerConnection, peer.name)
        info.heartbeat = 'ok'
      } catch (error) {
        problems.push(`heartbeat: ${error?.message ?? error}`)
      }
      try {
        info.peers = await listPeers(peerConnection)
      } catch (error) {
        problems.push(`list: ${error?.message ?? error}`)
      }
      return { text: JSON.stringify({ ...info, problems }, null, 2) }
    },
    presentCall: () => present('诊断信箱', 'read'),
  })

  ctx.tools.register({
    name: 'peer_find',
    description: '按能力找节点：谁有某台机器的 SSH、某个库的连接、Jenkins 之类。need 写能力片段，如 "ssh:172.16.22.140" 或 "jenkins"。',
    parameters: {
      need: { type: 'string', required: true, description: '能力片段，不区分大小写' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { connection } = requirePeer()
      const need = typeof args?.need === 'string' ? args.need.trim() : ''
      if (need === '') throw new Error('need 不能为空')
      const hits = await findByCapability(connection, need)
      if (hits.length === 0) return { text: `没有节点声明匹配「${need}」的能力。` }
      return {
        text: hits
          .map((hit) => {
            const flags = []
            if (hit.peer.online !== true) flags.push('离线')
            if (hit.peer.name !== '') flags.push(hit.peer.name)
            return `${hit.peer.name}${hit.peer.online === true ? '' : '（离线）'} → ${hit.matched.join('、')}`
          })
          .join('\n'),
      }
    },
    presentCall: () => present('寻找能干这事的节点', 'search'),
  })

  ctx.tools.register({
    name: 'peer_retry',
    description: '把已经结束（done/error/cancelled）的跨机任务重置回待投递，让对方重新执行一次。',
    parameters: {
      taskId: { type: 'string', required: true, description: 'peer_send 返回的 taskId' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { peer, connection } = requirePeer()
      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : ''
      if (taskId === '') throw new Error('taskId 不能为空')
      const result = await retryTask(connection, taskId, peer.name)
      if (result.ok !== true) {
        const reason =
          result.reason === 'not-found'
            ? '没有这个任务'
            : result.reason === 'not-owner'
              ? '只能重试自己发起的任务'
              : '任务还在跑，不能重试'
        return { text: `重试失败：${reason}` }
      }
      return { text: `已重置为待投递（第 ${result.task.attempts + 1} 次尝试），对方下次轮询会重新执行。` }
    },
    presentCall: (args) => present('重试跨机任务', 'edit', args?.taskId),
  })

  ctx.tools.register({
    name: 'peer_broadcast',
    description: '把同一条任务发给多个节点（比如让所有人刷新缓存），返回每个节点的 taskId。',
    parameters: {
      to: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '节点名列表',
      },
      text: { type: 'string', required: true },
      sessionId: { type: 'string', description: '投递到哪个会话（省略则用对方的默认会话）' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { peer, connection } = requirePeer()
      const targets = Array.isArray(args?.to) ? args.to.map((item) => `${item}`.trim()).filter((item) => item !== '') : []
      const message = typeof args?.text === 'string' ? args.text : ''
      if (targets.length === 0) throw new Error('to 至少给一个节点名')
      if (message.trim() === '') throw new Error('text 不能为空')
      const lines = []
      for (const target of targets) {
        const id = await sendTask(connection, {
          from: peer.name,
          to: target,
          sessionId: typeof args?.sessionId === 'string' ? args.sessionId : undefined,
          message,
        })
        lines.push(`${target}: ${id}`)
      }
      return { text: `已广播给 ${targets.length} 个节点：\n${lines.join('\n')}` }
    },
    presentCall: () => present('广播跨机任务', 'send'),
  })

  ctx.tools.register({
    name: 'peer_tasks',
    description: '列出跨机任务（默认我发出的和收到的都列），可按方向 sent/received 和状态 pending/claimed/running/done/error/cancelled 过滤。',
    parameters: {
      direction: { type: 'string', enum: ['all', 'sent', 'received'], description: '默认 all' },
      status: { type: 'string', description: '按状态过滤' },
      limit: { type: 'number', description: '默认 20，最多 100' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { peer, connection } = requirePeer()
      const tasks = await listTasks(connection, {
        peer: peer.name,
        direction: args?.direction === 'sent' ? 'sent' : args?.direction === 'received' ? 'received' : 'all',
        status: typeof args?.status === 'string' && args.status !== '' ? args.status : undefined,
        limit: args?.limit,
      })
      if (tasks.length === 0) return { text: '没有符合条件的任务。' }
      const lines = tasks.map((task) => {
        const outgoing = task.from === peer.name
        const other = outgoing ? task.to : task.from
        const label =
          task.sessionLabel === ''
            ? task.sessionId || '(默认会话)'
            : `${task.sessionLabel}（${task.sessionId.slice(0, 12)}…）`
        const tail =
          task.status === 'done'
            ? `回复：${(task.reply ?? '').slice(0, 60)}`
            : task.status === 'error'
              ? `错误：${(task.error ?? '').slice(0, 60)}`
              : task.progress || ''
        return `${task.status.padEnd(8)} ${outgoing ? '→' : '←'} ${other} · ${label} · ${task.message.slice(0, 40)}${tail === '' ? '' : ` · ${tail}`}\n    id=${task.id}`
      })
      return { text: `共 ${tasks.length} 条：\n${lines.join('\n')}` }
    },
    presentCall: () => present('查看跨机任务', 'read'),
  })

  ctx.tools.register({
    name: 'peer_cancel',
    description: '取消一个还没跑完的跨机任务：pending 直接置为 cancelled，已领取的会在投递前放弃。',
    parameters: {
      taskId: { type: 'string', required: true, description: 'peer_send 返回的 taskId' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { peer, connection } = requirePeer()
      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : ''
      if (taskId === '') throw new Error('taskId 不能为空')
      const result = await cancelTask(connection, taskId, peer.name)
      if (result.ok !== true) {
        const reason =
          result.reason === 'not-found'
            ? '没有这个任务'
            : result.reason === 'not-owner'
              ? '只能取消自己发起的任务'
              : '任务已经结束了'
        return { text: `取消失败：${reason}` }
      }
      return { text: result.pending === true ? '已请求取消，对方下次轮询时会放弃。' : '已取消。' }
    },
    presentCall: (args) => present('取消跨机任务', 'edit', args?.taskId),
  })

  ctx.tools.register({
    name: 'peer_sessions',
    description: '列出本机可以被投递的会话（id、是否空白、是否在跑、最近更新），用来给 peer_send 精确指定 sessionId。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      if (controller === undefined) throw new Error('当前 profile 没有 sessionController')
      const list = await controller.list({}, AbortSignal.timeout(10000))
      const items = Array.isArray(list?.items) ? list.items : []
      if (items.length === 0) return { text: '本机没有会话。' }
      return {
        text: items
          .slice(0, 30)
          .map((item) => {
            const flags = [item.blank ? '空' : '', item.running ? '运行中' : '', item.agentAvailable ? '可投递' : '需唤醒']
              .filter(Boolean)
              .join(' · ')
            return `${item.sessionId} · ${new Date(item.updatedAt).toLocaleString()}${flags ? ` · ${flags}` : ''}`
          })
          .join('\n'),
      }
    },
    presentCall: () => present('列出本机会话', 'read'),
  })

  ctx.tools.register({
    name: 'peer_wait',
    description: '等一个 peer_send 任务的执行结果：返回对方的回复文本，或失败原因，或超时。',
    parameters: {
      taskId: { type: 'string', required: true, description: 'peer_send 返回的 taskId。' },
      timeoutMs: { type: 'number', description: '最多等多久，默认 180000（3 分钟），上限 600000。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { connection } = requirePeer()
      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : ''
      if (taskId === '') throw new Error('taskId 不能为空')
      const budget = clampNumber(args?.timeoutMs, 1000, 600000, 180000)
      const started = Date.now()
      for (;;) {
        const task = await readTask(connection, taskId)
        if (task === undefined) throw new Error(`没有这个任务：${taskId}`)
        if (task.status === 'done') return { text: `任务完成（会话 ${task.sessionId || '对方默认'}）\n${task.reply ?? ''}` }
        if (task.status === 'error') return { text: `任务失败：${task.error ?? '未知原因'}` }
        if (Date.now() - started > budget) {
          return { text: `等待超时（${budget}ms），任务状态仍是 ${task.status}。稍后再用 peer_wait 取。` }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    },
    presentCall: (args) => present('等待同事结果', 'read', args?.taskId),
  })

  // ---- 斜杠命令：/peer 直接发任务，/peers 看节点 ----
  const registerCommands = (service) => {
    if (service === undefined || service === null) return

    ctx.effect(() =>
      service.register({
        name: 'peer',
        description: '给同事的 DSH 节点发一条跨机任务',
        input: { hint: '<节点名> <消息>' },
        async handler(invocation) {
          const raw = `${invocation?.rawInput ?? ''}`.trim()
          const gap = raw.search(/\s/)
          const to = gap < 0 ? raw : raw.slice(0, gap)
          const message = gap < 0 ? '' : raw.slice(gap + 1).trim()
          if (to === '' || message === '') {
            return { kind: 'error', text: '用法：/peer <节点名> <消息>' }
          }
          try {
            const { peer, connection } = requirePeer()
            const peers = await listPeers(connection)
            const target = peers.find((item) => item.name === to)
            if (target === undefined) {
              const known = peers.map((item) => item.name).join('、')
              return { kind: 'error', text: `没有这个节点：${to}${known === '' ? '' : `（已知：${known}）`}` }
            }
            const id = await sendTask(connection, { from: peer.name, to, message })
            return {
              kind: 'success',
              text: `已发给 ${to}（${target.online === true ? '在线' : '离线'}）\ntaskId=${id}`,
            }
          } catch (error) {
            return { kind: 'error', text: `发送失败：${error?.message ?? error}` }
          }
        },
      }),
    )

    ctx.effect(() =>
      service.register({
        name: 'peers',
        description: '列出跨机节点（在线状态、工作目录、能力）',
        handler: async () => {
          try {
            const { connection } = requirePeer()
            const peers = await listPeers(connection)
            if (peers.length === 0) return { kind: 'success', text: '信箱里还没有任何节点心跳。' }
            return {
              kind: 'success',
              text: peers
                .map((item) => {
                  const caps = Array.isArray(item.capabilities) && item.capabilities.length > 0
                    ? ` · 能力：${item.capabilities.slice(0, 6).join('、')}${item.capabilities.length > 6 ? '…' : ''}`
                    : ''
                  return `${item.online === true ? '在线' : '离线'}  ${item.name}${item.cwd === '' ? '' : ` · ${item.cwd}`}${caps}`
                })
                .join('\n'),
            }
          } catch (error) {
            return { kind: 'error', text: `读取失败：${error?.message ?? error}` }
          }
        },
      }),
    )
  }

  let commandsInjected = false
  try {
    if (typeof ctx.inject === 'function') {
      commandsInjected = true
      ctx.inject(['commands'], (scope) => registerCommands(scope?.commands ?? scope?.get?.('commands')))
    }
  } catch (error) {
    commandsInjected = false
    log('warn', `斜杠命令响应式注册失败，改用直接取：${error?.message ?? error}`)
  }
  if (!commandsInjected) registerCommands(ctx.get('commands'))

  // 管理面板的 JSON 接口；只有 Web 半边（或带 webServer 的组合）才注册。
  // 注意：新版 DSH 里 webServer 可能比插件晚就绪，所以优先用响应式 inject，
  // 直接 ctx.get() 只在 inject 不可用时兜底。
  const peerSnapshot = async () => {
    try {
      const { connection } = requirePeer()
      const peers = await listPeers(connection)
      return { ok: true, peers }
    } catch (error) {
      return { ok: false, error: `${error?.message ?? error}` }
    }
  }

  const registerApi = (server) => {
    if (server === undefined || server === null) return
    const handler = createApiHandler(ctx, state, { peerSnapshot })
    ctx.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }))
  }

  let apiInjected = false
  try {
    if (typeof ctx.inject === 'function') {
      apiInjected = true
      ctx.inject(['webServer'], (scope) => {
        registerApi(scope?.webServer ?? scope?.get?.('webServer'))
      })
    }
  } catch (error) {
    apiInjected = false
    log('warn', `panel API 注入失败：${error?.message ?? error}`)
  }
  if (!apiInjected) {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) registerApi(webServer)
  }

}
