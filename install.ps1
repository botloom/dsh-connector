#Requires -Version 5.1
<#
.SYNOPSIS
  把「连接器」插件装到本机的 DSH profile 里。

.DESCRIPTION
  做三件事：
    1. 把插件目录复制到 $InstallDir（默认 C:\BHBC\conn-plugin）
    2. 在 DSH profile 的 package.json 里登记 link 依赖 + 加入 bundles
    3. 在 profile 的 node_modules 里建目录联接（junction）

  装完重启 DSH，在连接器面板里新建连接即可。
  本脚本只改 DSH profile，不动 DSH 安装目录。

.PARAMETER InstallDir
  插件复制到哪儿。默认 %LOCALAPPDATA%\BHBC\conn-plugin（不需要管理员权限）。

.PARAMETER Profile
  DSH profile 名，默认 desktop。

.PARAMETER DryRun
  只打印将要做什么，不落盘。

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -InstallDir D:\tools\conn-plugin -DryRun
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'BHBC\conn-plugin'),
  [string]$Profile = 'desktop',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$packageName = '@local/ws-connections'
$source = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$profilePkg = Join-Path $profileDir 'package.json'

function Say($text) { Write-Host $text }

Say "插件源目录： $source"
Say "安装到：     $InstallDir"
Say "DSH profile：$profileDir"
if ($DryRun) { Say '（DryRun：只看不改）' }
Say ''

if (-not (Test-Path (Join-Path $source 'index.js'))) {
  throw "这个脚本要放在插件目录里运行（找不到 index.js）"
}
if (-not (Test-Path $profilePkg)) {
  throw "找不到 DSH profile：$profilePkg（先启动一次 DSH 客户端，让它生成 profile）"
}

# 1) 复制插件
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $robocopy = @(
    $source, $InstallDir,
    '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/R:1', '/W:1',
    '/XD', '.git', 'test-results'
  )
  & robocopy @robocopy | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy 退出码 $LASTEXITCODE）" }
}
Say "[1/3] 复制插件 → $InstallDir"

# 2) 写 profile 的 package.json
$pkg = Get-Content $profilePkg -Raw | ConvertFrom-Json
if ($pkg.dependencies -eq $null) {
  $pkg | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
}
$linkTarget = "link:$($InstallDir -replace '\\', '/')"
$pkg.dependencies | Add-Member -MemberType NoteProperty -Name $packageName -Value $linkTarget -Force

if ($pkg.dsh -eq $null) { $pkg | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{}) }
if ($pkg.dsh.profile -eq $null) { $pkg.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{}) }
$bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $null })
if ($bundles -notcontains $packageName) { $bundles += $packageName }
$pkg.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force

if (-not $DryRun) {
  $json = $pkg | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($profilePkg, $json, (New-Object System.Text.UTF8Encoding($false)))
}
Say "[2/3] 登记依赖 + bundles → $profilePkg"

# 3) 建 junction
$scopeDir = Join-Path $profileDir 'node_modules\@local'
$junction = Join-Path $scopeDir 'ws-connections'
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null
  if (Test-Path $junction) { Remove-Item $junction -Recurse -Force }
  New-Item -ItemType Junction -Path $junction -Target $InstallDir | Out-Null
}
Say "[3/3] 建联接 → $junction"

Say ''
Say '完成。接下来：'
Say '  1. 完全退出 DSH 客户端（不是只关窗口），再启动'
Say '  2. 输入区左边点插头图标 → 新建连接'
Say '  3. 用之前，先加一个可写的 PostgreSQL 连接（信箱用），例如：'
Say '       主机 10.0.0.5  端口 5432  用户 postgres  库 dsh_peer  允许写入'
Say '  4. 再新建一个「DSH 节点」连接：'
Say '       本机节点名：这台机器的名字（例：dev-b，别人用它找你）'
Say '       信箱连接： 上一步那个 PostgreSQL 连接的名字'
Say '       信箱库名： dsh_peer'
Say '  5. 打开面板点「看在线节点」，能看到自己在线就通了'
