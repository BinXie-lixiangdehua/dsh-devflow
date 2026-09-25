<#
.SYNOPSIS
  DevFlow 一键安装器 —— 把本插件装进一个 dsh profile。

.DESCRIPTION
  只动四处，且每个被改写的文件都先备份：
    1) 插件落盘            （默认 ~/.dsh/local-plugins/dsh-devflow）
    2) profile 注册 bundle （~/.dsh/profiles/<profile>/package.json）
    3) pnpm install        （让 link: 符号链接真正生效）
    4) 装插件自身依赖      （插件安装目录内 pnpm install —— 缺这一步插件导入即失败）
    5) 部署 agent preset   （旧形态 ~/.dsh/.agent-presets/devflow/ + 新形态声明行改写）

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
  # 跳过插件自身依赖安装（插件安装目录内的 pnpm install）
  [switch]$SkipPluginDeps,
  # 只打印动作，不写文件
  [switch]$DryRun,
  # 预设声明形态：auto（按目标 dsh 版本判定）/ on（强制启用）/ off（强制不启用）
  [ValidateSet('auto','on','off')]
  [string]$PresetDeclaration = 'auto',
  # 目标 dsh 版本（留空则自动探测；探不到时用 `-PresetDeclaration on/off` 兜底）
  [string]$DshVersion = ''
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

<#
  插件自身依赖是否已就位。

  DevFlow 的 lib/index.js 是 ESM，`@deepseek-ai/*` 全部是 peerDependency，必须能从
  插件安装目录解析；profile 的 pnpm install **不会**把 peer 装进插件目录。缺这一步
  的后果是宿主启动时报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'`
  —— 且旧版只打印一行 “failed to import”，不指出原因。
#>
function Test-PluginDeps([string]$Dir) {
  $probe = Join-Path $Dir 'node_modules\@deepseek-ai\cordis\package.json'
  return (Test-Path -LiteralPath $probe)
}
# 比较两个 dsh 版本号（形如 0.1.7-rc.1 / 0.1.5-rc.2-140-g26091bec18）。
# 只比较主.次.补丁：rc 与否、领先多少提交都不影响「是否 >= 0.1.7」这个判断，
# 因为实测要分的两边是 0.1.5 与 0.1.7 —— 不会踩在边界上。
function Test-DshAtLeast([string]$Version, [int]$Major, [int]$Minor, [int]$Patch) {
  $m = [regex]::Match($Version, '(\d+)\.(\d+)\.(\d+)')
  if (-not $m.Success) { return $false }
  $v = @([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
  $want = @($Major, $Minor, $Patch)
  for ($i = 0; $i -lt 3; $i++) {
    if ($v[$i] -gt $want[$i]) { return $true }
    if ($v[$i] -lt $want[$i]) { return $false }
  }
  return $true
}

# 目标 dsh 的版本号。宿主不一定以包依赖形式出现（本机就是从源码检出直接跑的
# node --import tsx/esm apps/cli/src/bin.ts），所以这里给一串候选探测：
# 一、-DshVersion 显式给出；
# 二、从 profile 目录向上找 node_modules 里的 @deepseek-ai/dsh；
# 三、宿主源码/构建检出的根 package.json（从 profile 向上找 apps/cli/package.json，
#     它的上一级就是根；本机两个宿主都在 apps/cli/package.json 里带版本）。
# 都读不到就返回空串，调用方按「不认声明」处理并提示 -PresetDeclaration。
function Get-DshVersion([string]$ProfileDirectory, [string]$Explicit) {
  if (-not [string]::IsNullOrWhiteSpace($Explicit)) { return $Explicit }
  $dir = $ProfileDirectory
  for ($i = 0; $i -lt 8; $i++) {
    if ([string]::IsNullOrEmpty($dir)) { break }
    $candidate = Join-Path $dir 'node_modules\@deepseek-ai\dsh\package.json'
    if (Test-Path -LiteralPath $candidate) {
      try { return [string]((ReadText $candidate) | ConvertFrom-Json).version } catch { }
    }
    $cli = Join-Path $dir 'apps\cli\package.json'
    if (Test-Path -LiteralPath $cli) {
      try { return [string]((ReadText $cli) | ConvertFrom-Json).version } catch { }
    }
    $dir = Split-Path -Parent $dir
  }
  return ''
}

# 是否启用「新形态」预设声明（dsh >= 0.1.7 才有 @deepseek-ai/dsh-agent-preset）。
# 判据是**版本号**，不是「包在不在」：0.1.5 的 profile 里也会出现 @deepseek-ai/*
# （peer 解析所致），用包存在与否判会误判。
function Test-DeclarationSupported([string]$Version) {
  if ([string]::IsNullOrWhiteSpace($Version)) { return $false }
  return (Test-DshAtLeast $Version 0 1 7)
}
# 把 - id: preset-devflow 这条声明行自己的 disabled: 改成 false。
# 逐行扫描：只在该条目的范围内改，不碰别的行（同一个 patch 文件里还有宿主控制器行）。
function Enable-PresetDeclaration([string]$Text) {
  $lines = $Text -split "
"
  $inBlock = $false
  $blockIndent = 0
  $touched = $false
  for ($i = 0; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    $indent = $line.Length - $line.TrimStart().Length
    if ($line -match '^\s*- id:\s*preset-devflow\s*$') {
      $inBlock = $true
      $blockIndent = $indent
      continue
    }
    if ($inBlock) {
      # 下一条同级或更浅的条目 ⇒ 本块结束
      if ($line.Trim() -ne '' -and $indent -le $blockIndent) { $inBlock = $false; continue }
      if ($line -match '^(\s*disabled:\s*)true\s*$') {
        $lines[$i] = $Matches[1] + 'false'
        $touched = $true
        $inBlock = $false
      }
    }
  }
  $out = $lines -join "
"
  # 没找到 disabled 行就补在 id 行之后（保持缩进），保证语义确定。
  if (-not $touched) {
    $out = [System.Text.RegularExpressions.Regex]::Replace($out,
      "(?m)^(\s*)- id: preset-devflow\s*$",
      "$0
$1  disabled: false")
  }
  return $out
}

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
Step '1/5 插件落盘'
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


# ── 2. 装插件自身依赖 ─────────────────────────────────────────────────────────
# 必须在第 2 步改 profile **之前**完成：缺依赖属于“这次安装根本不能用”，
# 宁可在这里响亮地失败，也不要先把 profile 改坏再让宿主静默起不来。
Step '2/5 装插件自身依赖'
if ($SkipPluginDeps) {
  Say '  已按 -SkipPluginDeps 跳过（你需要自行在插件安装目录执行 pnpm install）' 'Yellow'
} elseif (Test-PluginDeps $InstallDir) {
  Say "  ✅ 依赖已就位（$InstallDir\node_modules）" 'Green'
} else {
  $pnpm0 = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm0) {
    throw "插件自身依赖未安装，且本机找不到 pnpm。请先执行：pnpm install --dir `"$InstallDir`" —— 否则宿主会以 ERR_MODULE_NOT_FOUND 启动失败（找不到包 '@deepseek-ai/cordis'）。"
  }
  Say "  pnpm install --dir $InstallDir"
  if ($DryRun) {
    Say '  （DryRun：不执行）' 'Yellow'
  } else {
    & pnpm install --dir $InstallDir
    if ($LASTEXITCODE -ne 0) {
      throw "插件自身依赖安装失败（pnpm install 退出码 $LASTEXITCODE）。请手动重跑：pnpm install --dir `"$InstallDir`" —— 缺依赖会让宿主以 ERR_MODULE_NOT_FOUND 启动失败。"
    }
    if (-not (Test-PluginDeps $InstallDir)) {
      throw "pnpm install 成功但依赖仍未就位（缺 node_modules\@deepseek-ai\cordis）。请检查插件安装目录：$InstallDir"
    }
    Say '  ✅ 插件依赖已安装' 'Green'
  }
}

# ── 2. profile 注册 bundle ────────────────────────────────────────────────────
Step '3/5 注册 profile bundle'
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
Step '4/5 建立 link（profile 的 pnpm install）'
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

# ── 5. 部署 preset ────────────────────────────────────────────────────────────
Step '5/5 部署 agent preset'
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

    # ── 新形态（dsh 0.1.7+）：启用插件自带 cordis.patch.yml 里的预设声明行 ──────
    # 该文件是本插件的 bundle patch（`dsh.bundle.patch` 指向它）。声明行**出厂即
    # `disabled: true`**：0.1.5 的加载器会**硬失败**在解析不到的 entry 上
    #   `dsh: plugin tree failed to load: failed to import loader entry preset-devflow
    #    (@deepseek-ai/dsh-agent-preset): Cannot find package ...`
    # 而它自己的审计明确写着「Disabled entries are the only valid」未解析项
    # （`packages/boot/app-boot/src/index.ts:683`）⇒ 只有**禁用**的行才能两版共存。
    # 因此：≥0.1.7 才把它改成 enabled 并写入绝对 URL；0.1.5 保持禁用。
    $dshVer = Get-DshVersion $ProfileDir $DshVersion
    $enableDeclaration = switch ($PresetDeclaration) {
      'on' { $true }
      'off' { $false }
      default { Test-DeclarationSupported $dshVer }
    }
    Say ("  目标 dsh 版本 : " + $(if ([string]::IsNullOrWhiteSpace($dshVer)) { '（读不到）' } else { $dshVer }))
    if ($enableDeclaration) {
      $patchRead = if ($DryRun) { Join-Path $Source 'cordis.patch.yml' } else { Join-Path $InstallDir 'cordis.patch.yml' }
      $patchWrite = Join-Path $InstallDir 'cordis.patch.yml'
      if (-not (Test-Path -LiteralPath $patchRead)) {
        Say "  ⚠️ 找不到 bundle patch（$patchRead），新形态预设声明未启用" 'Yellow'
      } else {
        $pText = ReadText $patchRead
        $pRe = "(?m)^(\s*)name:\s*['`"]?(?:\.\./\.\./lib/host/preset-activation\.js|file:///\S*preset-activation\.js(?:\?rev=[^\s'`"]*)?)['`"]?\s*$"
        $pOut = [System.Text.RegularExpressions.Regex]::Replace($pText, $pRe, "`$1name: '" + $url + "'")
        # 启用该声明行：把它自己的 `disabled:` 改成 false（只动 preset-devflow 这一条）。
        $pOut = Enable-PresetDeclaration $pOut
        if ($pOut -eq $pText) {
          Say '  ⚠️ 在 cordis.patch.yml 里没找到新形态预设声明行，未启用' 'Yellow'
        } elseif ($DryRun) {
          Say "  （DryRun：将启用新形态预设声明于 $patchWrite，本次不写）" 'Yellow'
        } else {
          Copy-Item -LiteralPath $patchWrite -Destination "$patchWrite.bak-devflow-$stamp" -Force
          WriteText $patchWrite $pOut
          Say "  ✅ 新形态预设声明已启用 -> $patchWrite" 'Green'
        }
      }
    } else {
      Say '  目标 dsh 不认声明式预设（< 0.1.7）⇒ 新形态保持禁用，只用旧形态（目录式）' 'Gray'
    }
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
