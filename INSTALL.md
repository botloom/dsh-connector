# 安装与分发

这个仓库是 DSH 的「连接器」插件（`@local/ws-connections`），可以：
- 当作本机连接池用（数据库 / Redis / SSH / HTTP / TCP / 消息机器人）
- 当作跨 DSH 协作节点用（`DSH 节点` 连接类型 + PostgreSQL 信箱）

## 方式一：离线安装包（推荐，内网/无外网）

1. 拿到 `conn-plugin-安装包.zip`（含依赖，约 1.8 MB）
2. 解压到任意目录，双击 **`install.cmd`**
   它会：
   - 把插件复制到 `%LOCALAPPDATA%\BHBC\conn-plugin`
   - 在 DSH profile 的 `package.json` 里登记 `link:` 依赖并加入 `dsh.profile.bundles`
   - 在 profile 的 `node_modules\@local\` 下建目录联接
3. **完全退出 DSH 客户端**（不是只关窗口）再启动
4. 面板里新建连接即可

## 方式二：从 GitHub 安装（需要 pnpm + 能访问 GitHub）

仓库：https://github.com/botloom/dsh-connector

DSH 的插件管理器安装 git 源时会先 `git ls-remote` 探测仓库，再用 pnpm 拉取。
在 profile 目录里执行等价操作：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "github:botloom/dsh-connector"
# 然后把 @local/ws-connections 加进 package.json 的 dsh.profile.bundles，重启 DSH
```

或者由 agent 调用插件管理器：

```
plugin_manager(install_bundle, target: "github:botloom/dsh-connector")
```

## 常见错误

### `ERR_PNPM_EPERM ... rename 'ws-connections_tmp_...' -> 'ws-connections'`

说明这个 profile 里**已经有一个** `node_modules\@local\ws-connections`，而且当前正被运行中的 DSH 占用
（这台机器是开发模式，用 `link:` 指向源码目录）。pnpm 想用 git 包替换它，Windows 不允许。

做法二选一：

- **本机已经是 link 状态**：不需要从 GitHub 再装一次，直接用（`install.cmd` 也不会重复装）
- **确实要换成 git 版本**：完全退出 DSH → 删联接 → 再装

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\ws-connections"
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "github:botloom/dsh-connector"
```

要换回开发链接：删掉该目录后跑一次 `install.cmd`。
注意：
- 仓库里**不要提交** `node_modules`（`.gitignore` 已排除，依赖由 pnpm 安装）
- `private: true` 不影响 git 安装
- Git 源的 `engines` 检查发生在安装之后，版本不匹配会自动回滚

## 配置信箱（跨 DSH 协作）

每台机器：

1. 新建一个 **PostgreSQL** 连接指向同一台库服务器（例如 `10.0.0.5:5432`），库名 `dsh_peer`，**允许写入**
2. 新建一个 **DSH 节点** 连接：
   - 本机节点名：每台唯一（如 `dev-a`、`dev-b`）
   - 信箱连接：上一步那个 PostgreSQL 连接的名字
   - 信箱库名：`dsh_peer`
3. 打开面板点「看在线节点」，能看到自己即成功

表由插件自动创建（`dsh_peer_tasks`、`dsh_peers`）。

## 换机器 / 备份

面板左侧顶部有「导出 / 导入」：

1. 旧机器点「导出」→ 得到 `connector-YYYY-MM-DD.json`（**含明文密码**）
2. 新机器点「导入」→ 选这个文件，同名连接会被覆盖、新的会追加

也可以用工具：`conn_export` / `conn_import`（`mode=replace` 是清空后导入）。
文件请当密码本来保管。