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

# ── 目标 dsh 的版本探测 ───────────────────────────────────────────────────────
#
# 「profile 软链指向的宿主」≠「实际运行的宿主」。2026-10-01 本机实测：
#   · ~/.dsh/profiles/node_modules/@deepseek-ai/dsh  →(软链)→ D:\Deepseek\Harness\apps\cli
#     该 package.json 的 version 真值就是 0.1.5-rc.2；
#   · 而 :3080 上实际在跑的是从 D:\Deepseek\Harness-017 起跑的 0.1.7-rc.2。
# 旧探测只做「profile 目录向上找」，于是忠实读出 0.1.5 ⇒ 声明式预设保持 disabled ⇒
# 0.1.7 的选择列表里看不到 DevFlow 预设。
#
# 因此探测按下面的顺序取**第一个有答案的来源**，并把「版本 + 来源路径 + 依据」一起交回：
#   1. -DshVersion 显式给出；
#   2. 运行中的 dsh 进程：读进程的工作目录（PEB，**不需要管理员权限、不需要外部/未签名二进制**）
#      ⇒ 该检出即「真正在跑的宿主」；只采用 DSH_HOME 与本目标家目录一致的进程，避免把
#      另一个 DSH_HOME 的宿主当成本目标的宿主。探测不到的进程会被逐条列出并说明未采用原因。
#   3. dsh 命令入口（Get-Command / where.exe dsh）⇒ 用户实际调用的那条路；
#   4. profile 目录向上找 node_modules\@deepseek-ai\dsh（旧逻辑，即软链目标）——只作兜底。
#
# 都读不到 ⇒ 版本留空，调用方按「不认声明式预设」处理并提示 -PresetDeclaration。
function Read-CheckoutVersion([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return '' }
  foreach ($rel in @('apps\cli\package.json', 'node_modules\@deepseek-ai\dsh\package.json')) {
    $candidate = Join-Path $Root $rel
    if (Test-Path -LiteralPath $candidate) {
      try { return [string]((ReadText $candidate) | ConvertFrom-Json).version } catch { }
    }
  }
  return ''
}

# PEB 读取用的 P/Invoke 只在真的需要时才编译；编译不出来就把整条进程探测降级（不报错）。
$script:DshProcProbeReady = $null
function Test-DshProcProbe {
  if ($null -ne $script:DshProcProbeReady) { return $script:DshProcProbeReady }
  $script:DshProcProbeReady = $false
  try {
    Add-Type -Namespace DshInstall -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr h);
[DllImport("ntdll.dll")]
public static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
'@ -ErrorAction Stop
    $script:DshProcProbeReady = $true
  } catch {
    $script:DshProcProbeReady = $false
  }
  return $script:DshProcProbeReady
}

function Read-RemoteBytes([IntPtr]$Handle, [IntPtr]$Address, [int]$Size) {
  $buffer = New-Object byte[] $Size
  $read = [IntPtr]::Zero
  if (-not [DshInstall.Native]::ReadProcessMemory($Handle, $Address, $buffer, $Size, [ref]$read)) { return $null }
  return $buffer
}

# 读远端进程里一个 UNICODE_STRING（Length/MaximumLength + Buffer 指针）。
function Read-RemoteUnicodeString([IntPtr]$Handle, [IntPtr]$Address) {
  $head = Read-RemoteBytes $Handle $Address 16
  if ($null -eq $head) { return $null }
  $length = [BitConverter]::ToUInt16($head, 0)
  if ([IntPtr]::Size -eq 8) { $pointer = [IntPtr][BitConverter]::ToInt64($head, 8) }
  else { $pointer = [IntPtr][BitConverter]::ToInt32($head, 4) }
  if ($length -eq 0 -or $pointer -eq [IntPtr]::Zero) { return '' }
  $bytes = Read-RemoteBytes $Handle $pointer $length
  if ($null -eq $bytes) { return $null }
  return [System.Text.Encoding]::Unicode.GetString($bytes)
}

# 一个 dsh 进程的工作目录与 DSH_HOME。读不到就返回 $null（调用方跳过该进程）。
function Get-DshProcessFacts([int]$ProcessId) {
  $PROCESS_QUERY_INFORMATION = 0x0400
  $PROCESS_VM_READ = 0x0010
  $handle = [DshInstall.Native]::OpenProcess($PROCESS_QUERY_INFORMATION -bor $PROCESS_VM_READ, $false, $ProcessId)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  try {
    $basic = New-Object byte[] 48
    $returned = 0
    $status = [DshInstall.Native]::NtQueryInformationProcess($handle, 0, $basic, 48, [ref]$returned)
    if ($status -ne 0) { return $null }
    if ([IntPtr]::Size -eq 8) { $peb = [IntPtr][BitConverter]::ToInt64($basic, 8) } else { $peb = [IntPtr][BitConverter]::ToInt32($basic, 4) }
    if ($peb -eq [IntPtr]::Zero) { return $null }
    if ([IntPtr]::Size -eq 8) { $parametersOffset = 0x20 } else { $parametersOffset = 0x10 }
    if ([IntPtr]::Size -eq 8) { $cwdOffset = 0x38; $environmentOffset = 0x80 } else { $cwdOffset = 0x24; $environmentOffset = 0x48 }
    $pointerBytes = Read-RemoteBytes $handle ([IntPtr]::Add($peb, $parametersOffset)) 8
    if ($null -eq $pointerBytes) { return $null }
    if ([IntPtr]::Size -eq 8) { $parameters = [IntPtr][BitConverter]::ToInt64($pointerBytes, 0) } else { $parameters = [IntPtr][BitConverter]::ToInt32($pointerBytes, 0) }
    if ($parameters -eq [IntPtr]::Zero) { return $null }
    $cwd = Read-RemoteUnicodeString $handle ([IntPtr]::Add($parameters, $cwdOffset))

    # DSH_HOME 只从环境块里取这一个名字，用来判断这个宿主属于哪个家目录。
    $dshHome = ''
    $environmentPointerBytes = Read-RemoteBytes $handle ([IntPtr]::Add($parameters, $environmentOffset)) 8
    if ($null -ne $environmentPointerBytes) {
      if ([IntPtr]::Size -eq 8) { $environmentPointer = [IntPtr][BitConverter]::ToInt64($environmentPointerBytes, 0) } else { $environmentPointer = [IntPtr][BitConverter]::ToInt32($environmentPointerBytes, 0) }
      if ($environmentPointer -ne [IntPtr]::Zero) {
        $chunkSize = 8192
        $collected = New-Object byte[] 0
        for ($chunk = 0; $chunk -lt 32; $chunk++) {
          $part = Read-RemoteBytes $handle ([IntPtr]::Add($environmentPointer, $chunk * $chunkSize)) $chunkSize
          if ($null -eq $part) { break }
          $collected += $part
          $tail = $part.Length
          if ($tail -ge 4 -and $part[$tail - 1] -eq 0 -and $part[$tail - 2] -eq 0 -and $part[$tail - 3] -eq 0 -and $part[$tail - 4] -eq 0) { break }
        }
        if ($collected.Length -gt 0) {
          $block = [System.Text.Encoding]::Unicode.GetString($collected)
          foreach ($entry in ($block -split "`0")) {
            if ($entry -like 'DSH_HOME=*') { $dshHome = $entry.Substring(9); break }
          }
        }
      }
    }
    return [pscustomobject]@{ Cwd = $cwd; DshHome = $dshHome }
  } catch {
    return $null
  } finally {
    [void][DshInstall.Native]::CloseHandle($handle)
  }
}

# 所有「从源码检出直接起跑」的 dsh 进程（命令行里带 apps/cli/src/bin.ts）。
function Get-RunningDshHosts {
  $found = @()
  if (-not (Test-DshProcProbe)) { return $found }
  $processes = @()
  try {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object {
      $line = $_.CommandLine
      if ($null -eq $line) { return $false }
      if ($line -notlike '*apps/cli/src/bin.ts*' -and $line -notlike '*apps\cli\src\bin.ts*') { return $false }
      # 必须是「node … apps/cli/src/bin.ts <app>」这种直接起跑。排除只是把这段文字
      # 当参数带进来的壳进程（powershell -Command、tsx 包装器），否则它们会被误判成宿主。
      if ($line -like '*-Command*' -or $line -like '*powershell*' -or $line -like '*subprocess-local*') { return $false }
      return $true
    })
  } catch {
    return $found
  }
  foreach ($process in $processes) {
    $facts = Get-DshProcessFacts $process.ProcessId
    if ($null -eq $facts -or [string]::IsNullOrWhiteSpace($facts.Cwd)) { continue }
    $root = $facts.Cwd.TrimEnd('\')
    $version = Read-CheckoutVersion $root
    if ([string]::IsNullOrWhiteSpace($version)) { continue }
    $found += [pscustomobject]@{
      ProcessId = $process.ProcessId
      Cwd = $root
      Version = $version
      DshHome = $facts.DshHome
      MatchesTargetHome = $false
    }
  }
  return $found
}

function Get-NormalizedHome([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  try { $full = [System.IO.Path]::GetFullPath($Path) } catch { $full = $Path }
  return $full.TrimEnd('\').ToLowerInvariant()
}

# 一次探测的全部结果：Version 为空 = 读不到（调用方按「不认声明」处理）。
function Get-DshProbe([string]$ProfileDirectory, [string]$Explicit, [string]$TargetHome) {
  $probe = [pscustomobject]@{
    Version = ''
    SourceKind = ''
    SourcePath = ''
    ProfileVersion = ''
    ProfileSourcePath = ''
    RunningHosts = @()
  }
  if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
    $probe.Version = $Explicit
    $probe.SourceKind = '参数 -DshVersion（显式指定）'
    $probe.SourcePath = '(未探测)'
    return $probe
  }

  # 先算 profile 向上解析的结果：既是兜底来源，也是「两者不一致」告警的对照。
  $directory = $ProfileDirectory
  for ($i = 0; $i -lt 8; $i++) {
    if ([string]::IsNullOrEmpty($directory)) { break }
    $candidate = Join-Path $directory 'node_modules\@deepseek-ai\dsh\package.json'
    if (Test-Path -LiteralPath $candidate) {
      try {
        $probe.ProfileVersion = [string]((ReadText $candidate) | ConvertFrom-Json).version
        $probe.ProfileSourcePath = $candidate
      } catch { }
      break
    }
    $cli = Join-Path $directory 'apps\cli\package.json'
    if (Test-Path -LiteralPath $cli) {
      try {
        $probe.ProfileVersion = [string]((ReadText $cli) | ConvertFrom-Json).version
        $probe.ProfileSourcePath = $cli
      } catch { }
      break
    }
    $directory = Split-Path -Parent $directory
  }

  # 来源 2：运行中的宿主，按 DSH_HOME 归属筛选。
  $target = Get-NormalizedHome $TargetHome
  $defaultTarget = Get-NormalizedHome (Join-Path $HOME '.dsh')
  $hosts = @(Get-RunningDshHosts)
  foreach ($live in $hosts) {
    $liveHome = Get-NormalizedHome $live.DshHome
    if ([string]::IsNullOrEmpty($liveHome)) { $live.MatchesTargetHome = ($target -eq $defaultTarget) }
    else { $live.MatchesTargetHome = ($liveHome -eq $target) }
    if ($live.MatchesTargetHome -and [string]::IsNullOrWhiteSpace($probe.Version)) {
      $probe.Version = $live.Version
      $probe.SourceKind = "运行中的 dsh 进程（PID $($live.ProcessId)，DSH_HOME 与本目标一致）"
      $probe.SourcePath = Join-Path $live.Cwd 'apps\cli\package.json'
      if (-not (Test-Path -LiteralPath $probe.SourcePath)) { $probe.SourcePath = Join-Path $live.Cwd 'node_modules\@deepseek-ai\dsh\package.json' }
    }
  }
  $probe.RunningHosts = $hosts
  if (-not [string]::IsNullOrWhiteSpace($probe.Version)) { return $probe }

  # 来源 3：用户实际调用的 dsh 入口。
  $entry = ''
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    if (-not [string]::IsNullOrWhiteSpace($command.Source)) { $entry = $command.Source }
    elseif (-not [string]::IsNullOrWhiteSpace($command.Path)) { $entry = $command.Path }
  }
  if ([string]::IsNullOrWhiteSpace($entry)) {
    try {
      $where = @(& where.exe dsh 2>$null)
      if ($LASTEXITCODE -eq 0 -and $where.Count -gt 0) { $entry = [string]$where[0] }
    } catch { }
  }
  if (-not [string]::IsNullOrWhiteSpace($entry)) {
    if (Test-Path -LiteralPath $entry) { $entry = (Get-Item -LiteralPath $entry).FullName }
    $directory = Split-Path -Parent $entry
    for ($i = 0; $i -lt 6; $i++) {
      if ([string]::IsNullOrEmpty($directory)) { break }
      $version = Read-CheckoutVersion $directory
      if (-not [string]::IsNullOrWhiteSpace($version)) {
        $probe.Version = $version
        $probe.SourceKind = "dsh 命令入口（$entry）"
        $probe.SourcePath = $directory
        return $probe
      }
      $directory = Split-Path -Parent $directory
    }
  }

  # 来源 4：profile 软链目标（旧逻辑）。
  if (-not [string]::IsNullOrWhiteSpace($probe.ProfileVersion)) {
    $probe.Version = $probe.ProfileVersion
    $probe.SourceKind = 'profile 目录向上解析 @deepseek-ai/dsh（软链目标）'
    $probe.SourcePath = $probe.ProfileSourcePath
  }
  return $probe
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
      } elseif ($line -match '^(\s*disabled:\s*)false\s*$') {
        # 出厂即启用（本版起的默认形态）：已经是目标状态，记为「已处理」。
        # 必须这样记：否则下面的兜底会**再插一条 `disabled: false`**，同一 mapping 出现
        # 两个 `disabled` 键 ⇒ js-yaml 报 duplicated mapping key ⇒ parsePatchList 抛
        # "failed to parse overlay" ⇒ 宿主启动失败。
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

# ── 0.5 版本闸门：本插件自本版起要求 dsh >= 0.1.7 ─────────────────────────────
# 为什么必须**在写任何文件之前**拒绝：出厂模板的预设声明行是「启用 + 包内子路径」，
# 而 0.1.5 遇到「已启用但解析不到」的行会**中止启动**（vendored cordis loader 抛
# failed to import loader entry → app-boot 报 plugin tree failed to load）。把它挡在
# 安装入口，才不会留下「装上了、但宿主起不来」的静默崩溃路径。本次拒绝不改任何文件。
$dshGateProbe = Get-DshProbe $ProfileDir $DshVersion $DshHome
$dshGateVersion = $dshGateProbe.Version
Say ''
Say ("  目标 dsh 版本 : " + $(if ([string]::IsNullOrWhiteSpace($dshGateVersion)) { '（读不到）' } else { $dshGateVersion }))
Say ("  版本探测来源  : " + $(if ([string]::IsNullOrWhiteSpace($dshGateProbe.SourceKind)) { '（未探测到）' } else { $dshGateProbe.SourceKind }))
if ([string]::IsNullOrWhiteSpace($dshGateVersion)) {
  throw @"
本插件要求 dsh >= 0.1.7，但探测不到目标 dsh 的版本。
  探测来源：$($dshGateProbe.SourcePath)
  · 请用 -DshVersion <版本> 显式指定（例如 -DshVersion 0.2.0-rc.2），或
  · 确认目标 profile 上已正确安装 dsh 后再装本插件。
  自本版起不再支持 dsh 0.1.5：它会把本插件的预设声明行当成致命错误。
  本次安装未改动任何文件。
"@
}
if (-not (Test-DshAtLeast $dshGateVersion 0 1 7)) {
  throw @"
本插件自本版起要求 dsh >= 0.1.7，检测到的是 $dshGateVersion。
  探测来源：$($dshGateProbe.SourceKind)
  dsh 0.1.5 不再受支持，原因有两条：
    · 它没有官方插件管理器（`packages/boot/plugin-manager` 自 0.1.7 起才存在）；
    · 它缺少 `@deepseek-ai/dsh-agent-preset`，而本插件的预设声明行出厂即启用 ⇒
      它会以 `plugin tree failed to load: failed to import loader entry …` 中止启动。
  请先把 dsh 升级到 0.1.7 或更高，再安装本插件。
  本次安装未改动任何文件。
"@
}
Say '  ✅ 版本闸门通过（dsh >= 0.1.7）' 'Green'

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

    # ── 新形态（dsh 0.1.7+）：核验插件自带 cordis.patch.yml 里的预设声明行 ──────
    # 该文件是本插件的 bundle patch（`dsh.bundle.patch` 指向它）。自本版起它**出厂即
    # `disabled: false` + 包内子路径**，安装器**不再需要改写**（旧版要写绝对 file:// URL
    # 并把 disabled 改成 false，是因为那行嵌在 `config.plugins` 里、app-boot 的路径锚定
    # `anchorInsertedPluginNames` 不会递归到它，相对路径会以 profile 目录为基准而落空）。
    # 0.1.5 兼容为何取消：0.1.5 遇到「已启用但解析不到」的行会**中止启动** ——
    #   vendored cordis loader 先抛（`vendor/loader/src/config/entry.ts:280-282`
    #   → `config/group.ts:79-80`），app-boot 再报 `plugin tree failed to load`
    #   （`packages/boot/app-boot/src/index.ts:832`）；其审计 `assertEntriesLoaded`
    #   （`:688-694`，JSDoc 原话「Disabled entries are the only valid」在 `:683-684`）
    #   同样拒绝 fiber-less 的启用行。0.1.5 里没有 `@deepseek-ai/dsh-agent-preset`
    #   （只有复数名），启用即必炸。本版起改为**在写任何文件之前就拒绝 dsh < 0.1.7**。
    # 补充：0.1.7/0.2.0 对「非必需行」只 warning、不中断启动
    #   （`auditStartupEntries`，`packages/boot/app-boot/src/index.ts:925-939`）。
    $dshProbe = $dshGateProbe
    $dshVer = $dshGateVersion
    $enableDeclaration = switch ($PresetDeclaration) {
      'on' { $true }
      'off' { $false }
      default { Test-DeclarationSupported $dshVer }
    }
    Say ("  目标 dsh 版本 : " + $(if ([string]::IsNullOrWhiteSpace($dshVer)) { '（读不到）' } else { $dshVer }))
    Say ("  探测来源路径  : " + $(if ([string]::IsNullOrWhiteSpace($dshProbe.SourcePath)) { '（未探测到）' } else { $dshProbe.SourcePath }))
    Say ("  探测依据      : " + $(if ([string]::IsNullOrWhiteSpace($dshProbe.SourceKind)) { '（未探测到）' } else { $dshProbe.SourceKind }))
    if (@($dshProbe.RunningHosts).Count -gt 0) {
      foreach ($live in @($dshProbe.RunningHosts)) {
        $verdict = if ($live.MatchesTargetHome) { '采用' } else { '未采用：DSH_HOME 与本目标不一致' }
        $homeText = if ([string]::IsNullOrEmpty($live.DshHome)) { '<未设置=默认家目录>' } else { $live.DshHome }
        Say ("  运行中 dsh    : PID $($live.ProcessId)  $($live.Version)  cwd=$($live.Cwd)  DSH_HOME=$homeText  [$verdict]")
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($dshProbe.ProfileVersion) -and $dshProbe.ProfileVersion -ne $dshVer) {
      Say "  ⚠️ 检出不一致  : profile 软链目标是 $($dshProbe.ProfileVersion)（$($dshProbe.ProfileSourcePath)），" 'Yellow'
      Say "                  而实际采用 $dshVer。不一致时以「运行中的宿主」为准；若判断有误，请用 -PresetDeclaration on/off 显式覆盖。" 'Yellow'
    }
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
        # 本版起的出厂形态就是「包内子路径 + 已启用」⇒ 上面两步都不会改写，这是**预期**，
        # 不能当成「没找到声明行」报警（旧逻辑用 `$pOut -eq $pText` 判"没找到"，会误报）。
        $newFormRe = "(?m)^\s*name:\s*['`"]?@xiaoxie-ide/dsh-devflow/preset-activation['`"]?\s*$"
        if ($pOut -eq $pText) {
          if ($pText -match $newFormRe) {
            Say '  ✅ 新形态预设声明已是出厂形态（已启用 + 包内子路径），安装器无需改写' 'Green'
          } else {
            Say '  ⚠️ 在 cordis.patch.yml 里没找到新形态预设声明行，未启用' 'Yellow'
          }
        } elseif ($DryRun) {
          Say "  （DryRun：将启用新形态预设声明于 $patchWrite，本次不写）" 'Yellow'
        } else {
          Copy-Item -LiteralPath $patchWrite -Destination "$patchWrite.bak-devflow-$stamp" -Force
          WriteText $patchWrite $pOut
          Say "  ✅ 新形态预设声明已启用 -> $patchWrite" 'Green'
        }
      }
    } else {
      Say '  已按 -PresetDeclaration off 跳过（新形态声明保持原样，仅用旧形态目录式预设）' 'Gray'
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
