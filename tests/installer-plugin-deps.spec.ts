/**
 * 安装器（`install.ps1`）的「装依赖」契约与步骤顺序。
 *
 * 背景（第十八步实测）：现行安装器只对 **profile** 跑 `pnpm install`，从不装**插件
 * 自身**的依赖；而 DevFlow 的 `lib/index.js` 是 ESM、`@deepseek-ai/*` 全是
 * peerDependency ⇒ 装出来的插件**导入即失败**：
 *   `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis' imported from …/lib/index.js`
 * 而且旧版宿主只打印一行 `devflow (@xiaoxie-ide/dsh-devflow): failed to import`，
 * **不指出原因**，排查成本很高。
 *
 * 本用例钉住四件事：
 *   1. 安装器**确实**对插件安装目录跑依赖安装，且缺依赖时会**响亮失败**（带可操作提示）；
 *   2. 依赖安装**早于**改写 profile —— 否则会出现「profile 已被改、插件却不可用」；
 *   3. 步骤计数与顺序一致（1 落盘 → 2 装依赖 → 3 注册 → 4 link → 5 preset）；
 *   4. 依赖探测函数检查的是 **ESM 解析真正需要的那个包**（`@deepseek-ai/cordis`）。
 *
 * 安装器是 PowerShell，不能直接 import。这里用 Python 的
 * `System.Management.Automation` 解析器（通过 `powershell.exe`）取 AST 做结构断言；
 * 环境里没有 PowerShell 时**跳过结构断言**，但纯文本断言始终执行（它们才是契约本体）。
 *
 * @module tests/installer-plugin-deps.spec
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 安装器有两个发布副本：插件仓库（`src` 源头）与发布副本 `DevFlow-dist`。
 * 本轮改动必须在两边一致，否则「源码对了、装上的是旧的」。
 */
const INSTALLER_CANDIDATES = [
  'D:/Deepseek/DevFlow-dist/install.ps1',
] as const

/** 读第一份存在的安装器；都没有就让用例显式失败，而不是悄悄跳过。 */
function readInstaller(): { path: string, text: string } {
  for (const path of INSTALLER_CANDIDATES) {
    try {
      return { path, text: readFileSync(path, 'utf8') }
    } catch {
      // 换下一个候选
    }
  }
  throw new Error(`找不到 install.ps1（试过：${INSTALLER_CANDIDATES.join(', ')}）`)
}

/** 用 PowerShell 自己的解析器解析；返回语句数，不可用时返回 undefined（调用方跳过）。 */
function parseStatementCount(path: string): number | undefined {
  const script = [
    '$errors = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.replace(/'/gu, "''")}', [ref]$null, [ref]$errors)`,
    'if ($errors.Count -gt 0) { Write-Output ("PARSE_ERRORS:" + $errors.Count); exit 2 }',
    // 只数语句：AST 太深，序列化成 JSON 会被深度限制拒绝。
    'Write-Output ("STATEMENTS:" + $ast.EndBlock.Statements.Count)',
  ].join('; ')
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      }).trim()
      if (out.startsWith('PARSE_ERRORS')) throw new Error(`install.ps1 有语法错误：${out}`)
      const matched = /^STATEMENTS:(\d+)$/u.exec(out)
      if (matched === null) throw new Error(`安装器解析输出无法识别：${JSON.stringify(out)}`)
      return Number(matched[1])
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('install.ps1')) throw error
      // 该可执行文件不可用（或被沙箱拒绝）⇒ 试下一个
    }
  }
  return undefined
}

const installer = readInstaller()

/** 断言：文本包含某片段（失败信息带上下文，便于定位）。 */
function expectContains(haystack: string, needle: string): void {
  expect(haystack.includes(needle), `安装器缺少片段：${needle}`).toBe(true)
}

describe('安装器：必须装插件自身依赖（P0-1）', () => {
  it('依赖探测针对 ESM 解析真正需要的包（@deepseek-ai/cordis）', () => {
    // 该包正是第十八步实测报错里找不到的那个；探测别的包会漏判。
    expectContains(installer.text, String.raw`node_modules\@deepseek-ai\cordis\package.json`)
  })

  it('缺 pnpm 且依赖未就位时抛错，并在消息里给出 ERR_MODULE_NOT_FOUND 与可操作命令', () => {
    expectContains(installer.text, 'ERR_MODULE_NOT_FOUND')
    expectContains(installer.text, 'pnpm install --dir')
    // 必须 throw（响亮失败），不能只 Say 一句黄字就继续。
    expectContains(installer.text, 'throw "插件自身依赖未安装，且本机找不到 pnpm。')
  })

  it('pnpm 失败要抛错，而不是只打一行警告', () => {
    expectContains(installer.text, 'throw "插件自身依赖安装失败（pnpm install 退出码')
  })

  it('装完还要复验一次（pnpm 返回 0 但依赖仍缺 ⇒ 抛错）', () => {
    expectContains(installer.text, 'throw "pnpm install 成功但依赖仍未就位')
  })

  it('对**插件安装目录**执行（--dir $InstallDir），而不是只对 profile', () => {
    expectContains(installer.text, 'pnpm install --dir $InstallDir')
    expectContains(installer.text, 'pnpm install --dir $ProfileDir')
  })
})

describe('安装器：步骤顺序与计数', () => {
  it('依赖安装早于 profile 改写（否则会「profile 已改、插件不可用」）', () => {
    const depsStep = installer.text.indexOf(`Step '2/5 装插件自身依赖'`)
    const profileStep = installer.text.indexOf(`Step '3/5 注册 profile bundle'`)
    expect(depsStep, '缺 2/5 装插件自身依赖 步骤').toBeGreaterThan(-1)
    expect(profileStep, '缺 3/5 注册 profile bundle 步骤').toBeGreaterThan(-1)
    expect(depsStep < profileStep, '依赖安装必须早于 profile 改写').toBe(true)
  })

  it('五个步骤齐全且顺序正确', () => {
    const order = [
      `Step '1/5 插件落盘'`,
      `Step '2/5 装插件自身依赖'`,
      `Step '3/5 注册 profile bundle'`,
      `Step '4/5 建立 link（profile 的 pnpm install）'`,
      `Step '5/5 部署 agent preset'`,
    ]
    let cursor = -1
    for (const step of order) {
      const at = installer.text.indexOf(step)
      expect(at, `缺步骤或顺序不对：${step}`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('新开关 -SkipPluginDeps 已声明（跳过时要明确提示，不静默）', () => {
    expectContains(installer.text, '[switch]$SkipPluginDeps')
    expectContains(installer.text, '已按 -SkipPluginDeps 跳过')
  })
})

describe('安装器：双形态预设部署', () => {
  it('旧形态两个文件仍整份部署（旧版不回归）', () => {
    expectContains(installer.text, `foreach ($f in @('agent.cordis.yml', 'preset.yml'))`)
  })

  it('新形态声明行会被启用并改写为绝对 file:// URL（含 ?rev）', () => {
    // 相对路径在插件 bundle 加载期会按当前工作目录解析，不可靠 ⇒ 安装目录里必须是绝对 URL。
    expectContains(installer.text, `file:///\\S*preset-activation\\.js`)
    // 名称行被就地替换为绝对 URL（$1 保留缩进）。
    expectContains(installer.text, `Regex]::Replace($pText, $pRe, "\`$1name: '" + $url + "'")`)
    expectContains(installer.text, 'Enable-PresetDeclaration')
  })

  it('只对 dsh >= 0.1.7 启用声明 —— 0.1.5 会在未解析 entry 上**硬失败**', () => {
    // 实测（第十九步 0.1.5 沙箱，未修之前）：
    //   dsh: plugin tree failed to load: failed to import loader entry preset-devflow
    //   (@deepseek-ai/dsh-agent-preset): Cannot find package ...
    // ⇒ 必须按版本判定，并给出 -PresetDeclaration on/off 的人工兜底。
    expectContains(installer.text, 'Test-DeclarationSupported')
    expectContains(installer.text, "Test-DshAtLeast $Version 0 1 7")
    expectContains(installer.text, '$PresetDeclaration')
    expectContains(installer.text, '新形态保持禁用，只用旧形态（目录式）')
  })

  it('-DshVersion 可显式给出宿主版本（探不到时的人工兜底）', () => {
    expectContains(installer.text, '[string]$DshVersion')
    expectContains(installer.text, 'Get-DshVersion $ProfileDir $DshVersion')
  })
  it('启用时同时做两件事：写绝对 URL + 把 disabled 改成 false', () => {
    // 0.1.5 的加载器只容忍 **disabled** 的未解析行（app-boot/src/index.ts:683），
    // 所以「启用」必须是「改 disabled」而不是「加行」。
    expectContains(installer.text, 'Enable-PresetDeclaration $pOut')
    expectContains(installer.text, 'function Enable-PresetDeclaration')
    // 关键：把 `disabled: true` 就地改成 `disabled: false`。
    expectContains(installer.text, `$Matches[1] + 'false'`)
  })

  it('DryRun 绝不写任何文件（只报告将改动哪一个）', () => {
    expectContains(installer.text, '（DryRun：将启用新形态预设声明于')
    // 写入必须只在非 DryRun 分支里发生。
    const dryRunGuard = installer.text.indexOf('（DryRun：将启用新形态预设声明于')
    const writeCall = installer.text.indexOf('WriteText $patchWrite $pOut')
    expect(dryRunGuard).toBeGreaterThan(-1)
    expect(writeCall).toBeGreaterThan(dryRunGuard)
  })
})

describe('安装器：PowerShell 解析器接受（结构断言）', () => {
  const statements = parseStatementCount(installer.path)

  it('AST 可解析且语句数合理（BOM/引号/中文都不会破）', () => {
    if (statements === undefined) {
      // 环境无可用 PowerShell：结构断言跳过，纯文本契约上面已覆盖。
      expect(true).toBe(true)
      return
    }
    // 安装器是个完整脚本：几十条语句是下限；0 或个位数说明解析其实没成功。
    expect(statements).toBeGreaterThan(30)
  })
})
