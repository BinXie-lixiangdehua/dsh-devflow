<#
.SYNOPSIS
  DevFlow 一键安装器 —— 把本插件装进一个 dsh profile。

.DESCRIPTION
  只动四处，且每个被改写的文件都先备份：
    1) 插件落盘            （默认 ~/.dsh/local-plugins/dsh-devflow）
    2) profile 注册 bundle （~/.dsh/profiles/<profile>/package.json）
    3) pnpm install        （让 link: 符号链接真正生效）
    4) 部署 agent preset   （~/.dsh/.agent-presets/devflow/，激活行改写为绝对 file:// URL）

.EXAMPLE
  .\install.ps1 -DryRun
  只打印将要做什么，不写任何文件。

.EXAMPLE
  .\install.ps1 -DshHome 'C:\Users\me\.dsh' -Profile 'web' -SkipPreset
#>
#Requires -Version 5.1
#
# ⚠️ 编辑本文件请务必保存为 UTF-8 **带 BOM**。
#    PowerShell 5.1 对「无 BOM」的 .ps1 会按 ANSI(GBK) 解码，中文串会立刻损坏，
#    并报出「表达式或语句中包含意外的标记」这类语法错误（本机已实测踩过）。
[CmdletBinding()]
param(
  # 插件来源：目录（默认＝本脚本所在目录）或 git 地址
  [string]$Source = '',
  # 从 git 安装时使用的 tag / 分支
  [string]$Ref = 'main',
  # 插件落盘目录
  [string]$InstallDir = '',
  # dsh 家目录
  [string]$DshHome = '',
  # profile 名（~/.dsh/profiles/<name>）
  [string]$Profile = 'web',
  # 覆盖已存在的安装目录
  [switch]$Force,
  # 跳过 preset 部署
  [switch]$SkipPreset,
  # 跳过 profile 里的 pnpm install
  [switch]$SkipPnpm,
  # 只打印动作，不写文件
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PackageName = '@xiaoxie-ide/dsh-devflow'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }

function ReadText([string]$Path) { return [System.IO.File]::ReadAllText($Path) }
function WriteText([string]$Path, [string]$Text) {
  # 必须用 .NET API 写 UTF-8（无 BOM）：PowerShell 的 Set-Content 在本机会按 ANSI 读写，损坏 UTF-8
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function ToFileUrl([string]$WinPath) {
  $p = $WinPath -replace '\\', '/'
  if ($p -notmatch '^[A-Za-z]:') { $p = $p.TrimStart('/') }
  return 'file:///' + $p
}
function Test-Git { return [bool](Get-Command git -ErrorAction SilentlyContinue) }

# ── 0. 解析参数 ───────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = Join-Path $HOME '.dsh' }
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path (Join-Path $DshHome 'local-plugins') 'dsh-devflow' }
if ([string]::IsNullOrWhiteSpace($Source)) { $Source = $ScriptDir }

$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$ProfilePkg = Join-Path $ProfileDir 'package.json'
$PresetRoot = Join-Path (Join-Path $DshHome '.agent-presets') 'devflow'

Say ''
Say 'DevFlow 安装器' 'White'
Say "  插件名        : $PackageName"
Say "  来源          : $Source"
Say "  安装目录      : $InstallDir"
Say "  dsh 家目录    : $DshHome"
Say "  profile       : $Profile  ($ProfileDir)"
Say "  preset 部署到 : $PresetRoot"
if ($DryRun) { Say '  模式          : DryRun（不写任何文件）' 'Yellow' }

$SourceIsDir = Test-Path -LiteralPath $Source -PathType Container
$SourceIsPlugin = $false
if ($SourceIsDir) {
  $srcPkg = Join-Path $Source 'package.json'
  if (Test-Path -LiteralPath $srcPkg) {
    try { $SourceIsPlugin = ((ReadText $srcPkg) | ConvertFrom-Json).name -eq $PackageName } catch { $SourceIsPlugin = $false }
  }
}

if (-not (Test-Path -LiteralPath $ProfilePkg)) {
  throw "找不到 profile 配置：$ProfilePkg —— 请确认 dsh 已安装且 profile 名正确（-Profile）。"
}

# ── 1. 插件落盘 ───────────────────────────────────────────────────────────────
Step '1/4 插件落盘'
if ($SourceIsDir -and $SourceIsPlugin) {
  $same = ([System.IO.Path]::GetFullPath($Source)).TrimEnd('\') -ieq ([System.IO.Path]::GetFullPath($InstallDir)).TrimEnd('\')
  if ($same) {
    Say "  已在目标位置，跳过复制：$InstallDir"
  } else {
    Say "  从本地目录复制：$Source  ->  $InstallDir"
    if (-not $DryRun) {
      if (Test-Path -LiteralPath $InstallDir) {
        if (-not $Force) { throw "安装目录已存在：$InstallDir（加 -Force 覆盖，或改 -InstallDir）" }
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
      }
      Copy-Item -LiteralPath $Source -Destination $InstallDir -Recurse -Force
    }
  }
} else {
  if (-not (Test-Git)) { throw '需要 git 才能从地址安装，但本机找不到 git。' }
  if (Test-Path -LiteralPath $InstallDir) {
    Say "  目录已存在，尝试 git pull --ff-only：$InstallDir"
    if (-not $DryRun) {
      Push-Location $InstallDir
      try { & git pull --ff-only } finally { Pop-Location }
    }
  } else {
    Say "  git clone --depth 1 --branch $Ref  $Source  ->  $InstallDir"
    if (-not $DryRun) {
      $parent = Split-Path -Parent $InstallDir
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      & git clone --depth 1 --branch $Ref $Source $InstallDir
      if ($LASTEXITCODE -ne 0) { throw "git clone 失败（exit $LASTEXITCODE）" }
    }
  }
}

$Entry = Join-Path $InstallDir 'lib\index.js'
$Client = Join-Path $InstallDir 'lib\client.js'
if (-not $DryRun) {
  if (-not (Test-Path -LiteralPath $Entry))  { throw "缺少构建产物：$Entry —— 请在安装目录执行 pnpm install; pnpm build" }
  if (-not (Test-Path -LiteralPath $Client)) { throw "缺少构建产物：$Client —— 请在安装目录执行 pnpm install; pnpm build" }
  Say '  ✅ lib/index.js 与 lib/client.js 都在（无需构建）' 'Green'
}

# ── 2. profile 注册 bundle ────────────────────────────────────────────────────
Step '2/4 注册 profile bundle'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$ProfilePkg.bak-devflow-$stamp"
Say "  备份：$backup"
if (-not $DryRun) {
  Copy-Item -LiteralPath $ProfilePkg -Destination $backup -Force
  $pkg = (ReadText $ProfilePkg) | ConvertFrom-Json
  if ($null -eq $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
  $linkValue = 'link:' + ($InstallDir -replace '\\', '/')
  $pkg.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $linkValue -Force
  if ($null -eq $pkg.dsh) { throw 'profile package.json 里没有 dsh 字段，格式与预期不符，已停在落盘之后（可用备份还原）。' }
  if ($null -eq $pkg.dsh.profile) { throw 'profile package.json 里没有 dsh.profile，格式与预期不符。' }
  $bundles = @($pkg.dsh.profile.bundles)
  if ($bundles -notcontains $PackageName) { $bundles = $bundles + $PackageName }
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  WriteText $ProfilePkg ($pkg | ConvertTo-Json -Depth 10)
  Say "  ✅ dependencies[$PackageName] = $linkValue" 'Green'
  Say "  ✅ dsh.profile.bundles = $($bundles -join ', ')" 'Green'
}

# ── 3. pnpm install ───────────────────────────────────────────────────────────
Step '3/4 建立 link（pnpm install）'
if ($SkipPnpm) {
  Say '  已按 -SkipPnpm 跳过（你需要自行在 profile 目录执行 pnpm install）' 'Yellow'
} else {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm) {
    Say '  ⚠️ 找不到 pnpm —— 请自行执行：pnpm install --dir "<profile 目录>"' 'Yellow'
  } else {
    Say "  pnpm install --dir $ProfileDir"
    if (-not $DryRun) {
      & pnpm install --dir $ProfileDir
      if ($LASTEXITCODE -ne 0) { Say "  ⚠️ pnpm install 返回 $LASTEXITCODE —— 请手动重跑确认" 'Yellow' }
      else { Say '  ✅ 依赖已链接' 'Green' }
    }
  }
}

# ── 4. 部署 preset ────────────────────────────────────────────────────────────
Step '4/4 部署 agent preset'
if ($SkipPreset) {
  Say '  已按 -SkipPreset 跳过' 'Yellow'
} else {
  $presetSrc = Join-Path (Join-Path $InstallDir 'presets') 'devflow'
  if (-not (Test-Path -LiteralPath $presetSrc)) {
    # DryRun（尚未落盘）或 来源目录 != 安装目录 时，退回从来源取 preset 内容。
    # 注意：激活行里的绝对路径始终指向「安装目录」，与内容来源无关。
    $fallback = Join-Path (Join-Path $Source 'presets') 'devflow'
    if (Test-Path -LiteralPath $fallback) { $presetSrc = $fallback }
  }
  if (-not (Test-Path -LiteralPath $presetSrc)) {
    Say "  ⚠️ 找不到 preset 内容（$presetSrc），跳过" 'Yellow'
  } else {
    $activation = Join-Path $InstallDir 'lib\host\preset-activation.js'
    $rev = $stamp
    if ((Test-Git) -and (Test-Path -LiteralPath $InstallDir)) {
      # 只有在安装目录真实存在时才取 sha（DryRun 下目录尚未创建，Push-Location 会抛）
      Push-Location $InstallDir
      try { $sha = (& git rev-parse --short HEAD 2>$null); if ($LASTEXITCODE -eq 0 -and $sha) { $rev = $sha.Trim() } } finally { Pop-Location }
    }
    $url = (ToFileUrl $activation) + '?rev=' + $rev
    if (-not $DryRun) { if (-not (Test-Path -LiteralPath $PresetRoot)) { New-Item -ItemType Directory -Path $PresetRoot -Force | Out-Null } }
    foreach ($f in @('agent.cordis.yml', 'preset.yml')) {
      $from = Join-Path $presetSrc $f
      $to = Join-Path $PresetRoot $f
      if (-not (Test-Path -LiteralPath $from)) { Say "  ⚠️ 缺少 $from，跳过" 'Yellow'; continue }
      if (Test-Path -LiteralPath $to) {
        $bak = "$to.bak-devflow-$stamp"
        Say "  备份：$bak"
        if (-not $DryRun) { Copy-Item -LiteralPath $to -Destination $bak -Force }
      }
      $text = ReadText $from
      if ($f -eq 'agent.cordis.yml') {
        $re = '(?m)^(\s*)name:\s*[''"]?\.\./\.\./lib/host/preset-activation\.js[''"]?\s*$'
        if ($text -notmatch $re) { Say "  ⚠️ 在 $f 里没找到激活行（../../lib/host/preset-activation.js），原样拷贝" 'Yellow' }
        else { $text = [System.Text.RegularExpressions.Regex]::Replace($text, $re, "`$1name: '$url'") }
      }
      if (-not $DryRun) { WriteText $to $text }
      Say "  ✅ $f  ->  $to"
    }
    Say "  激活行指向：$url" 'Green'
  }
}

# ── 完成 ──────────────────────────────────────────────────────────────────────
Say ''
Say '安装完成。' 'Green'
Say '接下来：'
Say '  1) 重启 dsh（host 侧改动必须重启才生效）'
Say '  2) 新建会话并选择 DevFlow preset'
Say '  3) 画布与名册会出现在右侧栏'
Say ''
Say '回滚：'
Say "  - 还原 profile：$backup"
Say "  - 删除 preset：$PresetRoot"
Say ''
