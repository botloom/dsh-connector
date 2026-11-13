/**
 * ws-connections 本地验证（扁平连接池版）：不装插件，直接 import 模块跑。
 * 覆盖：配置归一化/旧配置合并、连接解析、SQL 守卫、各连接器、
 *       store 写入、面板接口、apply() 注册的工具端到端输出。
 */

import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function expectReject(name, fn, pattern) {
  try {
    await fn()
    check(name, false, '没有抛错')
  } catch (error) {
    const message = `${error?.message ?? error}`
    check(name, pattern === undefined || pattern.test(message), message.slice(0, 160))
  }
}

const workspace = mkdtempSync(path.join(tmpdir(), 'wsconn-'))
const dbFile = path.join(workspace, 'demo.sqlite')
{
  const db = new DatabaseSync(dbFile)
  db.exec('create table users (id integer primary key, name text, note text)')
  db.exec("insert into users (name, note) values ('alice','hi'),('bob',null)")
  db.close()
}

// ---------- 假 Redis ----------
function parseRespCommand(buffer) {
  if (buffer.length === 0 || buffer[0] !== 42) return null
  const lineEnd = buffer.indexOf('\r\n')
  if (lineEnd === -1) return null
  const count = Number(buffer.toString('utf8', 1, lineEnd))
  let offset = lineEnd + 2
  const args = []
  for (let index = 0; index < count; index += 1) {
    const head = buffer.indexOf('\r\n', offset)
    if (head === -1) return null
    const length = Number(buffer.toString('utf8', offset + 1, head))
    const start = head + 2
    if (buffer.length < start + length + 2) return null
    args.push(buffer.toString('utf8', start, start + length))
    offset = start + length + 2
  }
  return { args, offset }
}

function startFakeRedis() {
  return new Promise((resolve) => {
    const server = createTcpServer((socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const parsed = parseRespCommand(buffer)
          if (parsed === null) return
          buffer = buffer.subarray(parsed.offset)
          const [command] = parsed.args
          const upper = command.toUpperCase()
          const info = '# Server\r\nredis_version:7.2.4\r\n'
          if (upper === 'AUTH' || upper === 'SELECT') socket.write('+OK\r\n')
          else if (upper === 'PING') socket.write('+PONG\r\n')
          else if (upper === 'INFO') socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`)
          else if (upper === 'HGETALL') socket.write('*2\r\n$1\r\na\r\n$1\r\nb\r\n')
          else if (upper === 'KEYS') socket.write('*1\r\n$4\r\nkey1\r\n')
          else socket.write(`-ERR unknown command '${command}'\r\n`)
        }
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function main() {
  const redis = await startFakeRedis()
  const http = await new Promise((resolve) => {
    const server = createHttpServer((request, response) => {
      if (request.url === '/missing') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-node': 'fake' })
      response.end(JSON.stringify({ ok: true, path: request.url, auth: request.headers.authorization ?? null }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
  const tcp = await new Promise((resolve) => {
    const server = createTcpServer((socket) => {
      socket.write('WELCOME-TO-MQ\r\n')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })

  const config = {
    timeoutMs: 3000,
    maxRows: 5,
    connections: [
      { name: 'sqlite-demo', kind: 'sqlite', file: dbFile },
      { name: 'sqlite-write', kind: 'sqlite', file: dbFile, allowWrite: true },
      { name: 'cache', kind: 'redis', host: '127.0.0.1', port: redis.port, passwordEnv: 'WSCONN_REDIS_PASSWORD' },
      { name: 'api', kind: 'http', baseUrl: `http://127.0.0.1:${http.port}/api/`, tokenEnv: 'WSCONN_TOKEN' },
      { name: 'mq-port', kind: 'tcp', host: '127.0.0.1', port: tcp.port, send: 'PING\r\n' },
      { name: 'pg-broken', kind: 'postgres', host: '127.0.0.1', port: 59999, database: 'x', user: 'u' },
    ],
  }

  process.env.WSCONN_REDIS_PASSWORD = 'secret'
  process.env.WSCONN_TOKEN = 'token-123'

  // ---------- 配置 ----------
  const { normalizeConfig, resolveConnection, describeConnection, normalizeConnection } = await load('lib/config.js')
  const state = normalizeConfig(config)
  check('配置无 warning', state.warnings.length === 0, state.warnings.join(' | '))
  check('连接池大小', state.connections.length === 6, `${state.connections.length}`)
  check(
    'describeConnection 不泄露密码',
    !describeConnection(state.connections[2]).includes('secret'),
    describeConnection(state.connections[2]),
  )
  check('数据库连接可以不填库名', normalizeConnection({ name: 'x', kind: 'postgres', host: 'h' }, 't').database === undefined)

  const legacy = normalizeConfig({
    workspaces: [
      { path: 'C:/a', connections: [{ name: 'a1', kind: 'tcp', host: 'h', port: 1 }] },
      { path: 'C:/b', connections: [{ name: 'b1', kind: 'tcp', host: 'h', port: 2 }] },
    ],
  })
  check('旧 workspaces 配置被合并', legacy.connections.length === 2, legacy.connections.map((c) => c.name).join(','))
  const dup = normalizeConfig({
    connections: [{ name: 'x', kind: 'tcp', host: 'h', port: 1 }],
    workspaces: [{ path: 'C:/a', connections: [{ name: 'X', kind: 'tcp', host: 'h', port: 2 }] }],
  })
  check('同名连接保留第一个', dup.connections.length === 1 && dup.connections[0].port === 1 && dup.warnings.length === 1)

  check('按名字取连接（大小写不敏感）', resolveConnection(state.connections, 'CACHE').name === 'cache')
  const withNotes = normalizeConnection({ name: 'n', kind: 'tcp', host: 'h', port: 1, notes: '  常用目录 /data  ' }, '测试')
  check('notes 会去首尾空格并保留', withNotes.notes === '常用目录 /data', JSON.stringify(withNotes.notes))
  const emptyNotes = normalizeConnection({ name: 'n', kind: 'tcp', host: 'h', port: 1, notes: '   ' }, '测试')
  check('notes 为空时不写字段', emptyNotes.notes === undefined)
  await expectReject('未知连接报可用列表', async () => resolveConnection(state.connections, 'nope'), /可用连接/)
  await expectReject('多连接必须指定', async () => resolveConnection(state.connections), /请用 connection 指定/)
  check('只有一个连接时可省略', resolveConnection([state.connections[0]]).name === 'sqlite-demo')
  await expectReject(
    '禁用的连接不能调用',
    async () => resolveConnection([{ name: 'off', kind: 'tcp', host: 'h', port: 1, disabled: true }], 'off'),
    /已禁用/,
  )
  check(
    '面板可以取到禁用连接',
    resolveConnection([{ name: 'off', kind: 'tcp', host: 'h', port: 1, disabled: true }], 'off', { allowDisabled: true })
      .disabled === true,
  )
  await expectReject(
    '全部禁用时提示先启用',
    async () => resolveConnection([{ name: 'off', kind: 'tcp', host: 'h', port: 1, disabled: true }]),
    /都被禁用/,
  )

  // ---------- SQL 守卫 ----------
  const { assertSafeWrite, classifySql, splitStatements } = await load('lib/sqlguard.js')
  check('select 只读', classifySql('select 1').readOnly === true)
  check('分号在字符串里不切', splitStatements("select ';'").length === 1)
  check('WITH 写 CTE 非只读', classifySql('with x as (delete from t returning *) select * from x').readOnly === false)
  check('EXPLAIN ANALYZE UPDATE 非只读', classifySql('explain analyze update t set a=1').readOnly === false)
  check('PRAGMA 读只读', classifySql('pragma table_info(users)').readOnly === true)
  await expectReject('DROP 默认被拒', async () => assertSafeWrite('drop table t', {}), /结构变更/)
  await expectReject('TRUNCATE 默认被拒', async () => assertSafeWrite('truncate table t', {}), /结构变更/)
  await expectReject('DELETE 无 WHERE 被拒', async () => assertSafeWrite('delete from t', {}), /WHERE/)
  await expectReject('UPDATE 无 WHERE 被拒', async () => assertSafeWrite('update t set a = 1', {}), /WHERE/)
  assertSafeWrite('drop table t', { allowDdl: true })
  assertSafeWrite('delete from t where id = 1', {})
  assertSafeWrite('update t set a = 1 where id = 2', {})
  check('写语句第二道门按预期放行/拦截', true)

  // ---------- SQLite ----------
  const { querySql, probeSql, listDatabases } = await load('lib/connectors/sql.js')
  const sqliteConn = state.connections[0]
  const selectResult = await querySql(sqliteConn, { sql: 'select id, name, note from users order by id' }, { timeoutMs: 3000 })
  check('SQLite 查询行数', selectResult.rowCount === 2, `${selectResult.rowCount}`)
  await expectReject(
    'SQLite 只读连接拒绝写',
    async () => querySql(sqliteConn, { sql: "insert into users (name) values ('c')" }, { timeoutMs: 3000 }),
    /只读/,
  )
  const writeConn = state.connections[1]
  await expectReject(
    '允许写但没传 write 仍拒绝',
    async () => querySql(writeConn, { sql: "insert into users (name) values ('c')" }, { timeoutMs: 3000 }),
    /write: true/,
  )
  const wrote = await querySql(writeConn, { sql: 'insert into users (name) values (?)', params: ['c'], write: true }, { timeoutMs: 3000 })
  check('SQLite 允许写时插入成功', wrote.rowCount >= 1, JSON.stringify(wrote.notice))
  await expectReject('多语句被拒', async () => querySql(writeConn, { sql: 'select 1; select 2' }, { timeoutMs: 3000 }), /一条语句/)
  await expectReject(
    '没选库时提示先选库',
    async () => querySql({ name: 'pg-nodb', kind: 'postgres', host: '127.0.0.1', port: 1, user: 'u' }, { sql: 'select 1' }, { timeoutMs: 1000 }),
    /指定库/,
  )
  const probed = await probeSql(sqliteConn, { timeoutMs: 3000 })
  check('SQLite 探测', /SQLite/.test(probed.detail), probed.detail)
  const tables = await listDatabases(sqliteConn, { timeoutMs: 3000 })
  check('SQLite 列表', tables.kind === 'tables' && tables.items.includes('users'), tables.items.join(','))

  // ---------- Redis ----------
  const { runRedis, probeRedis, splitCommandLine, assertSafeRedisCommand } = await load('lib/connectors/redis.js')
  const redisConn = state.connections[2]
  check('命令切分', splitCommandLine('HGETALL  "user:1" x').join('|') === 'HGETALL|user:1|x')
  check('Redis PING', (await runRedis(redisConn, ['PING'], { timeoutMs: 3000 })) === 'PONG')
  check('Redis 探测带版本', /7\.2\.4/.test((await probeRedis(redisConn, { timeoutMs: 3000 })).detail))
  await expectReject('Redis 危险命令被拒', async () => assertSafeRedisCommand(redisConn, ['FLUSHALL']), /FLUSHALL/)
  check('Redis CONFIG GET 放行', assertSafeRedisCommand(redisConn, ['CONFIG', 'GET', 'maxmemory']) === undefined)

  // ---------- HTTP / TCP ----------
  const { runHttp, probeHttp } = await load('lib/connectors/http.js')
  const httpConn = state.connections[3]
  const response = await runHttp(httpConn, { path: 'users' }, { timeoutMs: 3000 })
  check('HTTP 200 + Bearer', response.status === 200 && /"path":"\/api\/users"/.test(response.body) && /Bearer token-123/.test(response.body))
  await expectReject('HTTP 跨域地址被拒', async () => runHttp(httpConn, { path: 'http://example.com/x' }, { timeoutMs: 3000 }), /只允许/)
  check('HTTP 探测', /HTTP 200/.test((await probeHttp(httpConn, { timeoutMs: 3000 })).detail))

  const { probeTcp } = await load('lib/connectors/tcp.js')
  const tcpConn = state.connections[4]
  check('TCP banner', /WELCOME-TO-MQ/.test((await probeTcp(tcpConn, { timeoutMs: 3000 })).detail))

  // ---------- 驱动加载 ----------
  const pgConn = state.connections[5]
  await expectReject(
    'PostgreSQL 驱动可用（连接被拒）',
    async () => querySql(pgConn, { sql: 'select 1' }, { timeoutMs: 2000 }),
    /ECONNREFUSED|连不上|timeout/i,
  )
  const { probeConnection } = await load('lib/connectors/index.js')
  check('dispatch 走 tcp', (await probeConnection(tcpConn, 3000)).detail.includes('端口可达'))

  // ---------- store ----------
  const { applyConnectionChange, applyImport, draftConnection, exportPayload } = await load('lib/store.js')
  const added = applyConnectionChange(config, {
    action: 'add',
    name: 'cache2',
    connection: { kind: 'redis', host: 'h', port: 6379 },
  })
  check('store add 落到扁平池', added.config.connections.length === 7 && added.config.connections.some((c) => c.name === 'cache2'))
  const updated = applyConnectionChange(
    { connections: [{ name: 'db', kind: 'sqlite', file: dbFile, password: 'secret' }] },
    { action: 'update', name: 'db', connection: { kind: 'sqlite', file: dbFile, password: '' } },
  )
  check('store update 保留未填的密码', updated.config.connections[0].password === 'secret')
  const toggled = applyConnectionChange(
    { connections: [{ name: 'db', kind: 'sqlite', file: dbFile }] },
    { action: 'toggle', name: 'db', disabled: true },
  )
  const clearedNotes = applyConnectionChange(
    { connections: [{ name: 'n', kind: 'tcp', host: 'h', port: 1, notes: '旧的说明' }] },
    { action: 'update', name: 'n', connection: { notes: '' } },
  )
  check('update 能清空 notes', clearedNotes.config.connections[0].notes === undefined)
  const keptNotes = applyConnectionChange(
    { connections: [{ name: 'n', kind: 'tcp', host: 'h', port: 1, notes: '旧的说明' }] },
    { action: 'update', name: 'n', connection: { timeoutMs: 5000 } },
  )
  check('update 不带 notes 时保留', keptNotes.config.connections[0].notes === '旧的说明')
  const { parseRoutes } = await load('lib/peer.js')
  const routes = parseRoutes('# 注释行\n*session-a | 闲聊 | 兜底\nsession-b | 技能 | 技能需求\n\nsession-c')
  check(
    'parseRoutes 解析默认/标签/注释',
    routes.length === 3 &&
      routes[0].default === true &&
      routes[0].label === '闲聊' &&
      routes[1].id === 'session-b' &&
      routes[2].label === '',
    JSON.stringify(routes),
  )
  check('parseRoutes 空输入', parseRoutes('').length === 0 && parseRoutes(undefined).length === 0)
  check('store toggle 禁用', toggled.config.connections[0].disabled === true && /已禁用/.test(toggled.message))
  const toggledBack = applyConnectionChange(toggled.config, { action: 'toggle', name: 'db', disabled: false })
  check('store toggle 重新启用', toggledBack.config.connections[0].disabled === false)
  const renamed = applyConnectionChange(
    { connections: [{ name: 'db', kind: 'sqlite', file: dbFile }] },
    { action: 'update', name: 'db', connection: { name: 'db2', kind: 'sqlite', file: dbFile } },
  )
  check('store update 支持改名', renamed.config.connections[0].name === 'db2', renamed.config.connections[0].name)
  await expectReject(
    'store 改名撞名被拒',
    async () =>
      applyConnectionChange(
        {
          connections: [
            { name: 'a', kind: 'tcp', host: 'h', port: 1 },
            { name: 'b', kind: 'tcp', host: 'h', port: 2 },
          ],
        },
        { action: 'update', name: 'a', connection: { name: 'b', kind: 'tcp', host: 'h', port: 1 } },
      ),
    /已存在/,
  )
  await expectReject(
    'store 重复 add 被拒',
    async () => applyConnectionChange(config, { action: 'add', name: 'cache', connection: { kind: 'redis', host: 'h' } }),
    /已存在/,
  )
  const removed = applyConnectionChange(config, { action: 'delete', name: 'cache' })
  check('store delete', removed.config.connections.length === 5 && !removed.config.connections.some((c) => c.name === 'cache'))
  const migrated = applyConnectionChange(
    { workspaces: [{ path: 'C:/a', connections: [{ name: 'old', kind: 'tcp', host: 'h', port: 1 }] }] },
    { action: 'add', name: 'new', connection: { kind: 'tcp', host: 'h', port: 2 } },
  )
  check(
    '第一次写入时把旧 workspaces 搬进扁平池',
    migrated.config.connections.length === 2 &&
      migrated.config.connections[0].name === 'old' &&
      migrated.config.workspaces[0].connections.length === 0,
    migrated.config.connections.map((c) => c.name).join(','),
  )
  const merged = draftConnection({ name: 'db', kind: 'sqlite', file: 'C:/x.db', password: 'secret' }, { file: 'C:/y.db', password: '' })
  check('草稿合并保留已存密码', merged.password === 'secret' && merged.file === path.resolve('C:/y.db'))
  await expectReject('草稿必须是对象', async () => draftConnection(undefined, null), /对象/)

  const exported = exportPayload({ connections: [{ name: 'db', kind: 'sqlite', file: dbFile, password: 'secret' }] })
  check(
    'export 含连接与时间戳',
    exported.connections.length === 1 &&
      typeof exported.exportedAt === 'string' &&
      exported.connections[0].password === 'secret',
  )
  const imported = applyImport({ connections: [] }, exported, 'merge')
  check('import merge 新增', imported.added.length === 1 && imported.config.connections[0].name === 'db')
  const replaced = applyImport(
    { connections: [{ name: 'x', kind: 'tcp', host: 'h', port: 1 }] },
    { connections: [{ name: 'db', kind: 'sqlite', file: dbFile }] },
    'replace',
  )
  check(
    'import replace 先清空',
    replaced.config.connections.length === 1 && replaced.config.connections[0].name === 'db',
  )
  const partial = applyImport(
    { connections: [] },
    { connections: [{ name: 'ok', kind: 'tcp', host: 'h', port: 1 }, { name: '', kind: 'tcp' }] },
  )
  check('import 单条失败不影响其它', partial.added.length === 1 && partial.errors.length === 1, partial.errors[0])
  await expectReject('import 缺 connections 被拒', async () => applyImport({ connections: [] }, { nope: 1 }), /connections/)

  // ---------- 面板接口 ----------
  const { createApiHandler, API_PREFIX } = await load('lib/api.js')
  function callApi(handler, method, route, body) {
    return new Promise((resolve) => {
      const listeners = {}
      const req = {
        method,
        url: API_PREFIX + route,
        on(event, callback) {
          ;(listeners[event] = listeners[event] ?? []).push(callback)
          return req
        },
        destroy() {},
      }
      const res = {
        statusCode: 0,
        body: '',
        writeHead(status) {
          this.statusCode = status
        },
        end(text) {
          this.body = text
          resolve(this)
        },
      }
      handler(req, res)
      setImmediate(() => {
        if (body !== undefined) {
          for (const callback of listeners.data ?? []) callback(Buffer.from(JSON.stringify(body)))
        }
        for (const callback of listeners.end ?? []) callback()
      })
    })
  }

  const readHandler = createApiHandler({ fiber: {}, get: () => undefined }, normalizeConfig(config))
  const stateResponse = await callApi(readHandler, 'GET', '/state')
  const statePayload = JSON.parse(stateResponse.body)
  check('API /state 200', stateResponse.statusCode === 200)
  check('API /state 返回扁平连接池', Array.isArray(statePayload.connections) && statePayload.connections.length === 6)
  const redisView = statePayload.connections.find((connection) => connection.name === 'cache')
  check('API 不回传密码/令牌', redisView.password === undefined && redisView.token === undefined && redisView.hasPassword === false)
  check('API 带 endpoint 摘要', typeof redisView.endpoint === 'string' && redisView.endpoint.includes('Redis'))

  const testResponse = await callApi(readHandler, 'POST', '/test', { name: 'cache' })
  check('API /test 成功', JSON.parse(testResponse.body).ok === true, testResponse.body.slice(0, 120))
  const testBad = await callApi(readHandler, 'POST', '/test', { name: 'nope' })
  check('API /test 未知连接 400', testBad.statusCode === 400, testBad.body)

  const draftOk = await callApi(readHandler, 'POST', '/test', {
    name: 'sqlite-demo',
    connection: { kind: 'sqlite', file: dbFile },
  })
  check('API 草稿测试成功', JSON.parse(draftOk.body).ok === true, draftOk.body.slice(0, 140))
  const draftBad = await callApi(readHandler, 'POST', '/test', {
    name: 'no-such-connection',
    connection: { kind: 'postgres', host: '127.0.0.1', port: 59996, database: 'x', user: 'u' },
  })
  check('API 草稿测试失败可见', JSON.parse(draftBad.body).ok === false, draftBad.body.slice(0, 140))

  const dbList = await callApi(readHandler, 'POST', '/databases', { name: 'sqlite-demo' })
  const dbListBody = JSON.parse(dbList.body)
  check('API /databases 列表', dbListBody.ok === true && dbListBody.items.includes('users'), dbList.body.slice(0, 140))

  const queryRes = await callApi(readHandler, 'POST', '/query', { name: 'sqlite-demo', sql: 'select count(*) as n from users', limit: 10 })
  const queryBody = JSON.parse(queryRes.body)
  check('API /query 返回列与行', queryBody.ok === true && queryBody.columns[0] === 'n' && Number(queryBody.rows[0][0]) >= 1)

  const writeRes = await callApi(readHandler, 'POST', '/query', { name: 'sqlite-demo', sql: 'delete from users' })
  check('API /query 默认拒写', writeRes.statusCode === 400 && /只读/.test(writeRes.body), writeRes.body.slice(0, 120))

  const redisRes = await callApi(readHandler, 'POST', '/redis', { name: 'cache', command: 'PING' })
  check('API /redis 执行', JSON.parse(redisRes.body).text === 'PONG')

  let persisted
  let liveConfig = config
  const writeCtx = {
    fiber: { entry: { id: 'ws-connections' } },
    get: (service) =>
      service === 'configEditor'
        ? { edit: async (_entry, change) => { persisted = change(liveConfig); liveConfig = persisted } }
        : undefined,
  }
  const writeHandler = createApiHandler(writeCtx, normalizeConfig(config))
  const saveResponse = await callApi(writeHandler, 'POST', '/connection', {
    action: 'add',
    name: 'pg1',
    connection: { kind: 'postgres', database: 'app', host: 'h', user: 'u' },
  })
  check('API /connection 保存', JSON.parse(saveResponse.body).ok === true && persisted.connections.some((c) => c.name === 'pg1'))

  // ---------- apply()：工具端到端 ----------
  const { apply } = await load('index.js')
  const registered = []
  const sections = []
  const warnings = []
  const fakeContext = {
    logger: { warn: (m) => warnings.push(m), info: () => {}, error: () => {} },
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    fiber: { entry: { id: 'ws-connections' } },
    get: (name) => {
      if (name === 'systemPrompt') return { section: (section) => (sections.push(section), () => {}) }
      if (name === 'configEditor') {
        return { edit: async (_entry, change) => { persisted = change(liveConfig); liveConfig = persisted } }
      }
      return undefined
    },
  }
  apply(fakeContext, config)
  const tool = (name) => registered.find((definition) => definition.name === name)
  const requiredTools = ['conn_catalog', 'conn_call', 'conn_list', 'conn_check', 'db_query', 'redis_exec', 'ssh_exec', 'http_call', 'conn_edit']
  const toolNames = registered.map((d) => d.name)
  check('注册核心工具', requiredTools.every((name) => toolNames.includes(name)), toolNames.join(','))
  check('注册了 prompt section', sections.length === 1)

  const exec = { agent: { id: 'session-1' }, signal: new AbortController().signal }
  const listText = (await tool('conn_list').execute({}, exec)).text
  check('conn_list 列出全部连接', /已配置 6 个连接/.test(listText) && /sqlite-demo/.test(listText), listText.split('\n')[0])
  const checkText = (await tool('conn_check').execute({ name: 'cache' }, exec)).text
  check('conn_check Redis OK', /^OK\s+cache/.test(checkText), checkText)
  const failText = (await tool('conn_check').execute({ name: 'pg-broken' }, exec)).text
  check('conn_check 失败可见', /^FAIL\s+pg-broken/.test(failText), failText.slice(0, 120))

  const queryText = (await tool('db_query').execute({ sql: 'select * from users order by id', connection: 'sqlite-demo', limit: 1 }, exec)).text
  check('db_query 输出表格', /sqlite-demo · SELECT/.test(queryText) && /alice/.test(queryText), queryText.split('\n')[0])
  check('db_query 说明截断', /只显示前 1 行/.test(queryText))
  await expectReject('db_query 拒绝对 redis 用 SQL', async () => tool('db_query').execute({ sql: 'select 1', connection: 'cache' }, exec), /不是 SQL 连接/)

  const redisText = (await tool('redis_exec').execute({ command: 'HGETALL user:1', connection: 'cache' }, exec)).text
  check('redis_exec 输出', /cache · HGETALL/.test(redisText), redisText.split('\n')[0])
  const httpText = (await tool('http_call').execute({ path: 'users', connection: 'api' }, exec)).text
  check('http_call 输出', /api · 200/.test(httpText), httpText.split('\n')[0])
  await expectReject('ssh_exec 拒绝非 ssh 连接', async () => tool('ssh_exec').execute({ command: 'echo hi', connection: 'mq-port' }, exec), /需要 ssh 连接/)

  const promptText = sections[0].text({})
  check('prompt 含连接清单', /连接器（已配置连接）/.test(promptText) && /- cache/.test(promptText), promptText.split('\n')[1])

  const editText = (
    await tool('conn_edit').execute(
      { action: 'add', name: 'pg-new', connection: { kind: 'postgres', host: '10.0.0.9', port: 5432, database: 'app', user: 'readonly', passwordEnv: 'PG_PASSWORD' } },
      exec,
    )
  ).text
  check('conn_edit 写入配置', /已新增连接 pg-new/.test(editText), editText)
  check('conn_edit 落到扁平 connections', persisted.connections.some((c) => c.name === 'pg-new'), JSON.stringify(persisted.connections.map((c) => c.name)))
  await expectReject('conn_edit 重复 add 被拒', async () => tool('conn_edit').execute({ action: 'add', name: 'pg-new', connection: { kind: 'tcp', host: 'h', port: 1 } }, exec), /已存在/)
  const deleteText = (await tool('conn_edit').execute({ action: 'delete', name: 'pg-new' }, exec)).text
  check('conn_edit 删除', /已删除连接 pg-new/.test(deleteText))

  redis.server.close()
  http.server.close()
  tcp.server.close()
  rmSync(workspace, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  }
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('测试脚本自身出错：', error)
  process.exit(2)
})
