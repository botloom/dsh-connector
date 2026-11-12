# 连接器（ws-connections）—— 统一的连接池

把数据库、Redis、SSH 服务器、HTTP 接口、TCP 端口配置成一个**全局连接池**，
任何会话都能直接查；不再按工作区区分。

## 怎么用

只有输入区一个入口：工具条最左边（模型选择按钮左边）的连接器图标，旁边显示已配置的连接数；
点一下在对话上方弹出管理对话框（Esc 或点遮罩关闭），不用离开当前会话。

**面板只管连接，不管查询**：左边是分组的连接列表，右边是这个连接的「智能体能怎么用 + 连接信息 + 连通性」。

- 右侧会列出该驱动的全部动作（例如 `执行 SQL`、`列出库表`），带参数签名和对应的
  `conn_call · action="…"`，并给一句可直接复制的示例提问；
- 每个连接头部有「测试 / 编辑 / 删除」；新建或编辑时右侧换成表单，表单里有「测试连接」
  （**不用先保存**就能测，编辑已有连接时密码留空会沿用已保存的密码）
- **查询直接在对话里说**，例如「用 mysql@10.0.0.6 查一下昨天新增的告警」，
  智能体会走 `conn_call`/`db_query` 这些工具；面板不再提供 SQL 编辑器或终端，
  这样权限、只读护栏、审计都只有一条路径。

几个关键点：

- **数据库连接可以不填库名**：只填 host/port/账号，调用时再由智能体传 `database`
- **SSH 直接用账号密码**（和 Xshell 一样），不再依赖本机 OpenSSH；也支持私钥 + 私钥口令
- 「新建连接」按类型给出表单（当前 14 种，见下文「内置驱动清单」）
- 连接里的密码 / Token 不会回显：详情只显示「已配置」或环境变量名，编辑时留空表示不修改
- 连接是全局的：换任何会话、任何目录，看到的都是这一份清单

对话框的写入和 `conn_edit` 工具走同一段 Host 逻辑（`lib/store.js`），保存后插件按新配置重载，
对话框自动刷新。

装好后在会话里也可以直接说人话：

- 「这个库现在有哪些慢查询？」→ 模型调 `db_query`
- 「cache 里 user:1 是什么？」→ `redis_exec`
- 「web01 上 nginx 还活着吗？」→ `ssh_exec`
- 「订单服务 /actuator/health 通不通？」→ `http_call`
- 「连不上就先测一下」→ `conn_check`

模型先看到连接清单（插件会把它注入系统提示），再用对应工具执行。

## 工具

| 工具 | 作用 |
| --- | --- |
| `conn_list` | 列出全部连接 |
| `conn_check` | 逐个探测连通性、耗时、失败原因 |
| `conn_catalog` | 列出所有已注册驱动（kind / 分类 / 字段 / 动作与参数） |
| `conn_call` | 统一驱动入口：`connection` + `action` + `args`，连任何已注册类型 |
| `db_query` | PostgreSQL / MySQL / SQLite 上执行一条 SQL，默认只读 |
| `redis_exec` | 执行一条 Redis 命令，危险命令默认拒绝 |
| `ssh_exec` | 通过 SSH 执行远程命令，破坏性命令默认拒绝 |
| `http_call` | 对配置的接口发请求 |
| `conn_edit` | 增删改连接，写入插件配置并重载 |
| `conn_export` | 把全部连接导出成 JSON（含密码） |
| `conn_import` | 从 JSON 导入连接（merge 同名覆盖 / replace 清空后导入） |
| `peer_list` | 列出信箱里的 DSH 节点（在线状态、最后心跳） |
| `peer_send` | 把一句话派给另一台 DSH 节点（可指定对方的会话 id） |
| `peer_wait` | 等一个派活任务的结果（对方跑完的回复文本） |
| `peer_sessions` | 列出本机可投递的会话（id / 是否空白 / 是否在跑） |
| `peer_doctor` | 诊断信箱配置：连接解析、建表、心跳、错误原文 |

### 配置导入 / 导出

面板左侧顶部有「导出 / 导入」两个按钮，也可以让模型用工具做：

- **导出**：`GET /wsconn/api/export` 或工具 `conn_export`，输出

```json
{
  "version": 1,
  "exportedAt": "2026-11-12T06:04:26.490Z",
  "connections": [ { "name": "pg", "kind": "postgres", "host": "...", "password": "..." } ]
}
```

- **导入**：`POST /wsconn/api/import`（body 就是导出文件的内容，可加 `"mode": "replace"`）或工具 `conn_import`。
  默认 `merge`：同名覆盖、其余追加；`replace`：先清空再导入。
  单条失败（缺 name、kind 不支持等）只记进 `errors`，不影响其它连接。

> ⚠️ 导出的 JSON **包含明文密码**，只适合放进密码管理器或加密封包里传，别丢在共享目录。
### DSH 节点（跨机器协作）

`dsh` 是一种连接类型（分类 `agent`，面板里单独一组），它不连数据库，只记录：
本机节点名（`peerName`）、信箱连接（`mailbox`，指向一个**可写入**的 PostgreSQL/MySQL 连接）、
信箱库名（`database`）、轮询间隔（`pollMs`）。

工作方式：所有机器连同一个库，插件每 `pollMs` 心跳一次并领取发给本机的任务，
用 Host 的 `sessionController.prompt` 投进目标会话，跑完把最后一段 assistant 文本写回任务行。
发起方用 `peer_wait` 取结果。不需要开放任何端口。

表结构（插件启动时自动建）：

- `dsh_peer_tasks`：id / from_peer / to_peer / session_id / message / status / reply / error / 时间戳
- `dsh_peers`：name / cwd / last_seen（心跳）

面板和工具是同一套操作的两个入口：面板负责看和点，工具负责让模型自己改。连接清单还会按
注入系统提示，所以模型不用先调 `conn_list` 就知道能查什么。

## 配置

最省事的方式：让模型用 `conn_edit` 加，例如

> 加一个叫 pg-main 的连接：postgres，10.0.0.5:5432，库 app，用户 readonly，密码在环境变量 PG_PASSWORD 里

`conn_edit` 会把配置写进当前 profile 的 `cordis.patch.yml`（对该插件行做 config 覆盖），
插件随即按新配置重载。连接是全局的，不需要指定工作区。

也可以手写。在当前 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: ws-connections
  name: '@local/ws-connections'
  config:
    timeoutMs: 15000      # 全局默认超时
    maxRows: 50           # db_query 默认返回行数
    connections:
      - name: pg-main
        kind: postgres
        host: 127.0.0.1
        port: 5432
        database: app            # 可选，留空则连上服务器后再选库
        user: readonly
        passwordEnv: PG_PASSWORD # 推荐；也可直接写 password
        allowWrite: false
        timeoutMs: 10000
      - name: cache
        kind: redis
        host: 127.0.0.1
        port: 6379
        db: 0
        passwordEnv: REDIS_PASSWORD
      - name: web01
        kind: ssh
        host: 10.0.0.9
        port: 22
        user: ops
        passwordEnv: WEB01_PASSWORD   # 或 keyPath + keyPassphrase
      - name: order-api
        kind: http
        baseUrl: 'http://10.0.0.20:8080/'
        tokenEnv: ORDER_API_TOKEN
      - name: mq-port
        kind: tcp
        host: 10.0.0.30
        port: 5672
        send: "AMQP\x00\x00\x09\x01"     # 可选，用来读 banner
      - name: local-sqlite
        kind: sqlite
        file: 'C:/work/app/data.db'
```

旧的 `workspaces: [{ path, connections: [...] }]` 配置仍然能用：读取时会自动合并成一个池子，
第一次通过面板或 `conn_edit` 写入时会搬进顶层 `connections`。

### 各 kind 的字段

| kind | 必填 | 可选 |
| --- | --- | --- |
| `postgres` / `mysql` | — | `host`(127.0.0.1) `port` `database`(可选) `user` `password`/`passwordEnv` `ssl` `sslRejectUnauthorized` `allowWrite` `timeoutMs` |
| `sqlite` | `file` | `allowWrite` `timeoutMs` |
| `redis` | — | `host`(127.0.0.1) `port`(6379) `db`(0) `user` `password`/`passwordEnv` `tls` `servername` `tlsRejectUnauthorized` `allowDangerous` `timeoutMs` |
| `ssh` | `host` | `port`(22) `user` `password`/`passwordEnv`（或 `keyPath`+`keyPassphrase`） `agent` `allowDestructive` `timeoutMs` |
| `http` | `baseUrl` | `headers` `token`/`tokenEnv` `username`+`password`/`passwordEnv` `allowAnyUrl` `timeoutMs` |
| `tcp` | `host` `port` | `send` `timeoutMs` |

DB 连接留空 `database` 就是「服务器级连接」：能连、能列库，执行 SQL 时在面板里选库，
或者给 `db_query` 传 `database`。SSH 支持密码登录（`ssh2` 直连），不再需要本机 OpenSSH。

## 安全边界

默认全部只读，破坏性操作要两道门：

- **SQL**：非 `SELECT/SHOW/EXPLAIN/WITH(纯读)/PRAGMA(读)` 的语句默认拒绝；
  需要写时，连接要 `allowWrite: true`，且调用时传 `write: true`。
  `EXPLAIN ANALYZE UPDATE ...` 这种「看着像 explain 其实会写」的语句按写处理。
- **Redis**：`FLUSHALL/FLUSHDB/CONFIG SET/EVAL/SHUTDOWN/MIGRATE` 等默认拒绝，
  连接加 `allowDangerous: true` 才放行（`CONFIG GET` 这类读命令不受限）。
- **SSH**：`rm -rf /`、`mkfs`、`dd of=/dev/...`、`shutdown/reboot`、fork bomb 等默认拒绝，
  连接加 `allowDestructive: true` 才放行。
- **HTTP**：只允许请求 `baseUrl` 同源的地址，跨域要 `allowAnyUrl: true`。
- 密码只从 `passwordEnv` / `tokenEnv` 或配置读取，工具输出里不会出现密码。

## 驱动

- PostgreSQL：`pg`
- MySQL：`mysql2`
- SQLite：Node 内置 `node:sqlite`
- SSH：`ssh2`（纯 JS 直连，支持密码 / 私钥 / agent）
- Redis / HTTP / TCP：只用 Node 内置模块

`pg`、`mysql2`、`ssh2` 已随插件目录一起安装（`node_modules/`）。
升级：在插件目录执行 `npm install pg mysql2 ssh2`。

## 自测

```powershell
node test/self-test.mjs
```

不连外部服务：起假的 Redis / HTTP / TCP 服务，用临时 SQLite 库，跑 70 项检查
（配置归一化、旧配置合并、SQL 守卫、各连接器、9 个工具的端到端输出、面板接口与 conn_edit 落盘）。

## 参考

写这类「插件 UI」时看过的开源资料（都不是本插件的依赖，只是参考）：

| 项目 | 可参考的点 |
| --- | --- |
| [anweat/dsh-plugin-dev-guide](https://github.com/anweat/dsh-plugin-dev-guide/blob/HEAD/docs/plugin-frontend.md) | 前端插件指南：哪些槽位最稳（`conversation.input.left/right`、`shell.overlay`、`settings.section` 等）、设计令牌、构建协议 |
| [YS-BW/dsh-plugins](https://github.com/YS-BW/dsh-plugins) | 每个包都是独立 cordis bundle，带 `dsh-hello` 模板和 tsdown 客户端构建预设，适合当脚手架 |
| [yxys288/dsh-reasoning-slider](https://github.com/yxys288/dsh-reasoning-slider) | 同样是输入区控件（把推理档位换成滑杆），最接近本插件的输入区按钮形态 |
| [summerscar/dsh-plugins](https://github.com/summerscar/dsh-plugins) / [hzopc1031/dsh-plugins](https://github.com/hzopc1031/dsh-plugins) | 插件 monorepo、npm 发布与社区索引登记的实例 |
| [tusharcora/dsh-agent-crew](https://github.com/tusharcora/dsh-agent-crew) | 更复杂的面板 UI（看板、审批卡），看多面板怎么组织 |
| [koishijs/webui](https://github.com/koishijs/webui) | cordis 同门的插件控制台，列表/表单/空状态的范式 |

界面范式（只借结构，不引依赖）：[shadcn/ui](https://ui.shadcn.com) 的卡片 + 状态色组织、
[Radix Themes](https://www.radix-ui.com/themes) 的焦点环与密度、
[Ant Design Pro](https://pro.ant.design) 的连接管理表格；
连接管理器的常见做法（状态点 + 端点 + 一行操作）可看 TablePlus / DBeaver / RedisInsight。

约束：插件浏览器半边只能 `require('react')` 和平台内置的 `ctx` / `styles` / `host`，
不能引入第三方组件库，所以视觉全靠 `--dsw-alias-*` 主题变量 + 自写 CSS。

## 排错

- 报连接失败：先 `conn_check`，它会分别给出「TCP 不通」「认证失败」「HTTP/查询失败」的原始原因；
  TCP 不通基本就是网络/VPN/防火墙或端口不对。
- 报「环境变量 XXX 没有设置」：Harness 进程的环境里缺这个变量；改用 `password` 直接写，
  或把变量配置到启动 Harness 的环境里。
- 连接同名：读取时保留第一个，后加的会被忽略并在日志里提示。

## 扩展新连接类型

Host 侧已经改成**驱动注册表**：新增一种连接类型 = 加一个驱动文件，不再改
`lib/config.js`、`lib/connectors/index.js`、`index.js` 里的任何 `switch`。

### 内置驱动清单

| kind | label | category | actions |
| --- | --- | --- | --- |
| `postgres` | PostgreSQL | database | `query`(sql/params/database/limit/write) · `databases` |
| `mysql` | MySQL | database | 同上 |
| `sqlite` | SQLite | database | 同上 |
| `redis` | Redis | cache | `exec`(command) |
| `ssh` | SSH | server | `exec`(command/timeoutMs) |
| `http` | HTTP | api | `request`(path/method/body/headers) |
| `tcp` | TCP | server | `check` |
| `elasticsearch` | Elasticsearch | search | `health` · `query`(path/body/method) · `search`(index/dsl/size) |
| `dingtalk` | 钉钉机器人 | message | `send`(text/msgtype/atMobiles) |
| `feishu` | 飞书机器人 | message | `send`(text/title) |
| `wecom` | 企业微信机器人 | message | `send`(text/msgtype) |
| `slack` | Slack Webhook | message | `send`(text) |
| `telegram` | Telegram Bot | message | `send`(text) |
| `webhook` | 通用 Webhook | api | `request` · `send`（别名） |

消息类驱动的 `probe()` 只做 URL 可达性探测（GET / HEAD），**不会真的往群里发消息**。

### 本轮新增 / 改动的文件

| 文件 | 说明 |
| --- | --- |
| `lib/drivers/index.js`（新） | 注册表：`registerDriver` / `getDriver` / `listDrivers` / `driverManifests` / `normalizeKind` / `loadExternalDrivers` |
| `lib/drivers/*.js`（新） | 14 个内置驱动；`sql-common.js` 是三个 SQL 驱动的共用动作 |
| `lib/driver-kit.js`（新） | 驱动共用工具：取默认值、URL 校验、带超时 `fetch`、JSON 格式化、错误脱敏 |
| `lib/secret.js`（新） | `readSecret` / `readSecretValue`（同时供 connectors 与 drivers 用，断开 ESM 循环） |
| `lib/config.js`（改） | `normalizeConnection` 走 `normalizeKind → driver.validate`；`readSecret` 继续 re-export |
| `lib/connectors/index.js`（改） | `probeConnection` 改为 `getDriver(kind).probe()` |
| `lib/api.js`（改） | 新增 `POST /call`、`/state.kinds`；`redact()` 按驱动 `secretFields` 隐藏字段 |
| `index.js`（改） | 新增 `conn_catalog` / `conn_call`；`conn_edit` 接受任意已注册 kind；旧工具保留为薄封装 |
| `lib/connectors/{sql,redis,ssh,http}.js`（改） | `readSecret` 改从 `lib/secret.js` 引入 |
| `test/self-test.mjs`（改） | 工具数量断言从 7 改为 9 |

### 加一个新驱动：3 步

**第 1 步：写驱动文件** `lib/drivers/<kind>.js`，`export default` 一个对象。
底层能力优先复用 `lib/connectors/*.js`，新协议用 Node 内置模块（全局 `fetch` /
`node:https` / `node:crypto`），不要新增 npm 依赖：

```js
export default {
  kind: 'dingtalk',          // 唯一 id，小写
  label: '钉钉机器人',
  category: 'message',       // database|cache|server|api|search|message
  aliases: ['ding'],         // 可选
  fields: [                  // UI 表单字段，顺序即渲染顺序
    { name: 'webhook', label: 'Webhook 地址', type: 'text', required: true },
    { name: 'secret', label: '签名密钥', type: 'password' },
  ],
  secretFields: ['secret', 'token', 'password'],  // redact() 会隐藏这些字段
  actions: [
    { id: 'send', label: '发送消息', primary: true,
      params: [{ name: 'text', label: '内容', type: 'text', required: true }] },
  ],

  validate(conn) {           // 抛 Error = 配置非法；返回补好默认值的对象
    if (!conn.webhook) throw new Error(`连接 ${conn.name} 缺少 webhook`)
    return { ...conn }
  },
  async probe(conn, opts) {  // 连通性测试，返回 { detail, elapsedMs }
    return { detail: 'webhook 可达', elapsedMs: 1 }
  },
  async call(conn, action, args, opts) {
    // 返回 { text } 或 { text, table: { columns, rows }, meta }
    return { text: '已发送' }
  },
  async callArgs(conn, args, opts) {},  // 可选：兼容旧的直接调用方式
}
```

> 安全约定：`fields` 里不要回显密钥；`probe()` 不能产生副作用（尤其不能发消息）；
> `call()` 抛错时不要把带 `access_token` / `bot<token>` 的完整 URL 原样带出去，
> 可复用 `lib/driver-kit.js` 的 `scrub()` / `requestJson()`（已经做了脱敏）。

**第 2 步：注册**

- 内置：在 `lib/drivers/index.js` 里 `import` 并加进 `BUILTIN_DRIVERS`。
- 外部（不改本包）：把插件配置加上 `driversDir: 'C:/my-drivers'`，
  目录下每个 `*.js` / `*.mjs` 的 `export default` 会被 `loadExternalDrivers()` 自动注册；
  单个文件失败只打 warn，不影响其它驱动（别名冲突也会在这里报出来）。

**第 3 步：验证**

```powershell
node --check lib/drivers/<kind>.js
node test/self-test.mjs
```

再在会话里让模型 `conn_catalog` 确认新 kind 出现，`conn_edit` 建连接，
`conn_check` 探测，最后 `conn_call` 传 `connection` / `action` / `args` 调一次。

## 面板（UI）

输入区左侧的插头按钮打开面板。**这里不提供手动查询** —— 连接器是给智能体用的，
查询/执行都回到对话里做；面板只负责把连接配好、测通、并说明「智能体能拿它做什么」。

- **左侧**：按 `category` 分组的连接列表（数据库 / 缓存 / 服务器 / 搜索 / 接口 / 消息），
  顶部是搜索（`⌘K`）、全部测试、新建；右键菜单：`编辑` / `测试` / `复制示例提问` / `删除`。
- **右侧**：只放**连接信息**一张卡片 —— 类型、地址、主机/端口/用户/库名、读写、密钥状态
  （只显示「已配置」或环境变量名，不回显密钥）。点「测试」后，探测结论显示在标题下方。
- **新建 / 编辑**：类型用卡片网格选，字段按「基本信息 / 认证 / 高级」分组，开关是 iOS 胶囊。

关键点：表单字段完全由 `GET /wsconn/api/state` 里的 `kinds`（`driverManifests()`）驱动，
加一个新驱动前端**一行都不用改**。`kinds` 缺失时（旧 host）退回内置的 6 种类型清单，不会白屏。

### API（面板用的）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/wsconn/api/state` | 连接列表（密钥已脱敏）+ `kinds` 驱动清单 |
| POST | `/wsconn/api/test` | 探测连通性，支持未保存的表单草稿 |
| POST | `/wsconn/api/connection` | 增 / 改 / 删连接 |
| POST | `/wsconn/api/call` | 统一执行入口，给自动化/自测用；面板本身不再调用 |
| POST | `/wsconn/api/{query,redis,ssh,http,databases}` | 旧接口，保留兼容与自测 |

> 面板不提供执行入口，是为了避免「面板里能查、智能体也能查」两套语义：
> 权限、只读护栏、审计都只有智能体工具那一条路径。

### 交互冒烟测试（真 DOM）

`.design/` 里有一套隔离依赖（react / react-dom / jsdom，**不属于插件运行时**），
用 jsdom 真渲染面板并模拟点击：

```powershell
node .design/ui-test.mjs
```

覆盖：打开面板、连接分组与搜索、点连接只看连接信息（断言只有一张卡片、没有能力卡片）、
测试按钮与结论、右键菜单（第一项是「编辑」）、编辑表单、取消返回，
并断言界面上**没有** SQL 编辑器 / 终端（23 项）。

### 设计校验（离线看效果）

`.design/` 下有一套 harness：把 `client.js` 的 CSS 抽出来配等价 DOM，
生成浅色/深色 × 面板/表单四个页面，用 headless Chrome 截图肉眼校验。

```powershell
node .design/build.mjs
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$out = (Resolve-Path .design).Path
foreach ($n in 'panel','form','panel-dark','form-dark') {
  & $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 `
    --window-size=1180,800 --screenshot="$out\$n.png" "file:///$($out.Replace('\','/'))/$n.html"
}
```

坑：`client.js` 的 CSS 是模板字符串，里面混着 `${T.accent}` 这类插值，
直接抽源码会得到非法 CSS（`color-mix()` 整条失效，截图一片灰），`build.mjs` 里做了令牌替换。

**别用宿主的 `--dsw-alias-brand-primary` 当强调色**：它指向
`--dsw-static-neutral-bluish-1000`（中性色，深色主题下接近白），
拿它做主按钮会得到「白底白字」。强调色在 `T.accent` 里写死系统蓝 `#0a84ff`。
视觉规范见 `.design/README.md`。

## 联调自测（对正在运行的实例）

```powershell
node test/integration-live.mjs http://127.0.0.1:56351
```

只读检查：`/state` 与 `kinds`、`/call` 的 SQL 与 SSH 派发、旧 `/query` 仍可用、
只读护栏拒写语句、破坏性命令护栏拒 `dd`。**不会**改配置、也不会往任何群里发消息。

护栏探针特意用「命中规则但本身无害」的命令（`dd` 到 `/dev/null`、`update 不存在的表 where 1=0`），
即使护栏失效也不会砸到数据；同时按报错文案区分「被护栏拒绝」和「压根没拦」，
避免测试自己给出假绿灯。
