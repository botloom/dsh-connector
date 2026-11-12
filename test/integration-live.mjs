/**
 * 对「正在运行」的 DSH 打的集成检查：验证面板接口 + 驱动派发真的通。
 * 只读，不改任何配置、不往任何群里发消息。
 *
 *   node test/integration-live.mjs [http://127.0.0.1:56351]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:56351'
const API = `${BASE}/wsconn/api`

let failed = 0
const results = []

function ok(label, detail = '') {
  results.push(`OK   ${label}${detail ? ` · ${detail}` : ''}`)
}
function bad(label, detail) {
  failed += 1
  results.push(`FAIL ${label} · ${detail}`)
}

async function call(path, init) {
  const response = await fetch(API + path, init)
  const text = await response.text()
  let payload = {}
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 120)}`)
  }
  if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

const get = (path) => call(path)
const post = (path, body) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

/** 期望被拒：返回错误信息；真的放行了返回 null。 */
const expectReject = (path, body) =>
  post(path, body).then(
    () => null,
    (error) => error.message,
  )

const state = await get('/state').catch((error) => {
  bad('/state', error.message)
  return null
})

if (state) {
  ok('/state', `${state.connections?.length ?? 0} 个连接`)

  const kinds = state.kinds
  if (Array.isArray(kinds) && kinds.length > 0) {
    ok('/state.kinds', `${kinds.length} 种：${kinds.map((k) => k.kind).join(', ')}`)
    const broken = kinds.filter((k) => !k.kind || !k.label || !Array.isArray(k.fields))
    if (broken.length > 0) bad('驱动清单字段完整性', broken.map((k) => k.kind).join(','))
  } else {
    bad('/state.kinds', '缺少 kinds（驱动注册表没接进 /state）')
  }
}

const connections = state?.connections ?? []

// 库名必须问连接自己要：pg 和 mysql 完全不同，硬编码会打错库
const sqlConn =
  connections.find((c) => c.kind === 'mysql') ?? connections.find((c) => c.kind === 'postgres') ?? null
const sshConn = connections.find((c) => c.kind === 'ssh') ?? null

if (sqlConn) {
  const listing = await post('/call', { name: sqlConn.name, action: 'databases', args: {} }).catch(
    () => null,
  )
  const items = Array.isArray(listing?.table?.rows) ? listing.table.rows.map((row) => `${row[0]}`) : []
  const system = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', 'template0', 'template1'])
  const database =
    sqlConn.database ??
    items.find((name) => name === 'netInsight_new') ??
    items.find((name) => !system.has(name) && !name.endsWith('_log')) ??
    items.find((name) => !system.has(name)) ??
    null

  if (database) ok('列出库', `${sqlConn.name} → ${items.length} 个，选用 ${database}`)
  else bad('列出库', '没有可用的库')

  if (database) {
    // 1) 统一入口 /call
    const viaCall = await post('/call', {
      name: sqlConn.name,
      action: 'query',
      args: { sql: 'select 1 as ok', database, limit: 5 },
    }).catch((error) => {
      bad('/call SQL', error.message)
      return null
    })
    if (viaCall) {
      const rows = viaCall.table?.rows?.length ?? 0
      rows > 0 ? ok('/call SQL', `${rows} 行`) : bad('/call SQL', '没有返回行')
    }

    // 2) 旧接口仍在
    const legacy = await post('/query', {
      name: sqlConn.name,
      database,
      sql: 'select 1 as ok',
      limit: 5,
    }).catch((error) => {
      bad('/query 兼容', error.message)
      return null
    })
    if (legacy) ok('/query 兼容', `${legacy.rowCount ?? 0} 行`)

    // 3) 只读护栏：探针用「不存在的表 + where 1=0」，即使护栏失效也改不到任何数据，
    //    再靠报错文案区分「被护栏拒绝」和「压根没拦」。
    const guarded = await expectReject('/call', {
      name: sqlConn.name,
      action: 'query',
      args: { sql: 'update dsh_probe_no_such_table set a = 1 where 1 = 0', database },
    })
    if (guarded === null) bad('只读护栏', '写语句被放行了')
    else if (/写|write|allowWrite|只读|denied/i.test(guarded)) ok('只读护栏', `已拒绝：${guarded.slice(0, 56)}`)
    else bad('只读护栏', `报错不是护栏给的（说明没拦）：${guarded.slice(0, 66)}`)
  }
}

if (sshConn) {
  const ssh = await post('/call', {
    name: sshConn.name,
    action: 'exec',
    args: { command: 'echo dsh-connector-ok' },
  }).catch((error) => {
    bad('/call SSH', error.message)
    return null
  })
  if (ssh) {
    const text = `${ssh.text ?? ''}`
    text.includes('dsh-connector-ok')
      ? ok('/call SSH', '输出符合预期')
      : bad('/call SSH', `输出不含预期字符串：${text.slice(0, 80)}`)
  }

  // 命中危险规则但真跑也无害的探针
  const destructive = await expectReject('/call', {
    name: sshConn.name,
    action: 'exec',
    args: { command: 'dd if=/dev/zero of=/dev/null count=1' },
  })
  if (destructive === null) bad('破坏性命令护栏', 'dd 命令被放行了')
  else if (/危险|破坏|destructive|allowDestructive|拒绝/i.test(destructive))
    ok('破坏性命令护栏', `已拒绝：${destructive.slice(0, 50)}`)
  else bad('破坏性命令护栏', `报错不是护栏给的（说明没拦）：${destructive.slice(0, 60)}`)
}

console.log(results.join('\n'))
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
