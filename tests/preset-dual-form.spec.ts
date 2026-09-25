/**
 * 预设「双形态」一致性与不回归。
 *
 * 背景（第十八步实测）：dsh 0.1.7 起 agent preset 由「声明行」声明，旧的家目录
 * 目录式预设（`$DSH_HOME/.agent-presets/devflow/`）在新版**没有任何读取方**；而
 * 现行 0.1.5 只认目录式。于是同一份产品必须同时提供两种形态，且**两边的插件
 * 清单必须逐字一致** —— 否则两版会跑出不同的预设。
 *
 * 本用例钉住三件事：
 *   1. 新形态声明（`cordis.patch.yml`）与旧形态（`presets/devflow/agent.cordis.yml`）
 *      的插件清单逐条一致（id / name / 顺序），激活行含 isolate realm；
 *   2. `preset.yml` 的展示元数据被逐字带入新形态；
 *   3. 旧形态两个文件仍然存在且仍可部署（防「为了新版把旧版弄坏」）。
 *
 * 这里**不引入 YAML 依赖**：自带一个严格的极小 YAML 子集读取器，只覆盖这两个
 * 文件实际使用的语法；一旦文件形态漂移到它不认识的写法，读取器会**抛错**而不是
 * 静默读空 —— 这样用例不会因为解析器变瞎而假装通过。
 *
 * @module tests/preset-dual-form.spec
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PATCH = new URL('../cordis.patch.yml', import.meta.url)
const LEGACY_AGENT = new URL('../presets/devflow/agent.cordis.yml', import.meta.url)
const LEGACY_META = new URL('../presets/devflow/preset.yml', import.meta.url)
/** 安装器只在发布副本里维护（源码仓库是同步过去的那一份）。 */
const INSTALLER = 'D:/Deepseek/DevFlow-dist/install.ps1'

const DEVFLOW_PRESET_ID = 'devflow'
/** 激活行在仓库内保持相对写法（安装器会改写成绝对 file:// URL）。 */
const ACTIVATION_SOURCE_PATH = '../../lib/host/preset-activation.js'

// ── 极小 YAML 子集读取器 ────────────────────────────────────────────────────
// 支持：块序列（`- `）、块映射（`key:`）、单/双引号标量与裸标量、`!!js <expr>`
// 标签（原样保留其后的表达式文本）、注释与空行、空值（`key:` 后跟缩进子块）。
// 不支持：块标量（`>` / `|`）、流式集合、锚点/别名 —— 遇到即抛错。

/** 该行是否为「纯注释或空行」。 */
function isBlank(raw: string): boolean {
  return raw.trim() === '' || raw.trimStart().startsWith('#')
}

/** 去掉行尾注释（只在没有引号时安全）。 */
function stripComment(text: string): string {
  const at = text.indexOf(' #')
  return at === -1 ? text : text.slice(0, at)
}

/** 把一个标量文本解析为 JS 值（引号 / `!!js` / 布尔数字裸量）。 */
function scalar(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('!!js ')) return { __js: trimmed.slice('!!js '.length).trim() }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed)
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  if (quoted !== null) return quoted[2]
  if (trimmed.startsWith('>') || trimmed.startsWith('|')) {
    throw new Error(`preset-dual-form: 块标量未支持（${JSON.stringify(trimmed)}）`)
  }
  return trimmed
}

/** `key: value` 切分（value 可为空）。 */
function splitPair(text: string): { key: string, value: string } {
  const at = text.indexOf(':')
  if (at === -1) throw new Error(`preset-dual-form: 不是映射行：${JSON.stringify(text)}`)
  return { key: text.slice(0, at).trim(), value: text.slice(at + 1).trim() }
}

interface Line { readonly indent: number, readonly text: string }

/** 读取一个缩进块（映射或序列），由 `start` 起。 */
function readBlock(lines: readonly Line[], start: number): { value: unknown, next: number } {
  const first = lines[start]
  if (first === undefined) return { value: undefined, next: start }
  return first.text.startsWith('- ') || first.text === '-'
    ? readSequence(lines, start, first.indent)
    : readMapping(lines, start, first.indent)
}

/** 读取块序列，成员缩进均为 `indent`。 */
function readSequence(lines: readonly Line[], start: number, indent: number): { value: unknown[], next: number } {
  const out: unknown[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || line.indent !== indent) break
    if (!(line.text.startsWith('- ') || line.text === '-')) break
    const inline = line.text === '-' ? '' : line.text.slice(2)
    // 取本成员的全部行：首行按 `- ` 之后的缩进（indent + 2），后续行取更深缩进。
    let j = i + 1
    while (j < lines.length && lines[j] !== undefined && lines[j]!.indent > indent) j++
    if (inline === '') {
      if (j === i + 1) out.push(undefined)
      else out.push(readBlock(lines, i + 1).value)
      i = j
      continue
    }
    if (inline.includes(':')) {
      // 成员本身是映射：合成首行，其余更深缩进行照抄，整体作为一个映射解析。
      const member: Line[] = [{ indent: indent + 2, text: inline }]
      for (let k = i + 1; k < j; k++) member.push(lines[k]!)
      out.push(readMapping(member, 0, indent + 2).value)
      i = j
      continue
    }
    out.push(scalar(inline))
    i = j
  }
  return { value: out, next: i }
}

/** 读取块映射，键缩进均为 `indent`。 */
function readMapping(lines: readonly Line[], start: number, indent: number): { value: Record<string, unknown>, next: number } {
  const out: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || line.indent !== indent) break
    if (line.text.startsWith('- ')) break
    const pair = splitPair(line.text)
    if (pair.value === '') {
      const peek = lines[i + 1]
      if (peek !== undefined && peek.indent > indent) {
        const child = readBlock(lines, i + 1)
        out[pair.key] = child.value
        i = child.next
      } else {
        out[pair.key] = undefined
        i++
      }
      continue
    }
    out[pair.key] = scalar(pair.value)
    i++
  }
  return { value: out, next: i }
}

/** 解析一个 YAML 文件（顶层必须是一个块，且整份文件被消费完）。 */
function parseYaml(source: string): unknown {
  const lines: Line[] = []
  for (const raw of source.split(/\r?\n/u)) {
    if (isBlank(raw)) continue
    const indent = raw.length - raw.trimStart().length
    lines.push({ indent, text: stripComment(raw.trim()) })
  }
  if (lines.length === 0) return undefined
  const { value, next } = readBlock(lines, 0)
  if (next !== lines.length) {
    throw new Error(`preset-dual-form: 有 ${lines.length - next} 行未被解析（形态超出子集读取器）`)
  }
  return value
}

// ── 读取与切片 ──────────────────────────────────────────────────────────────

/** 插件清单的规范投影：只看 id 与 name，顺序敏感。 */
function pluginListOf(rows: unknown): readonly string[] {
  if (!Array.isArray(rows)) throw new Error('preset-dual-form: plugins 不是列表')
  return rows.map((row) => {
    if (typeof row !== 'object' || row === null) throw new Error('preset-dual-form: 插件行不是映射')
    const { id, name } = row as { id?: unknown, name?: unknown }
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new Error(`preset-dual-form: 插件行缺 id/name：${JSON.stringify(row)}`)
    }
    return `${id}<-${name}`
  })
}

/** 从 bundle patch 里取出新形态 preset 声明的**整行**（含 disabled 等字段）。 */
function newFormDeclarationRow(patchSource: string): Record<string, unknown> {
  const doc = parseYaml(patchSource)
  if (!Array.isArray(doc)) throw new Error('preset-dual-form: cordis.patch.yml 顶层不是列表')
  const found: Record<string, unknown>[] = []
  for (const entry of doc) {
    const insert = (entry as { insert?: unknown }).insert
    if (!Array.isArray(insert)) continue
    for (const row of insert) {
      const record = row as Record<string, unknown>
      if (record.id === 'preset-devflow') found.push(record)
    }
  }
  expect(found.length, 'cordis.patch.yml 里的 preset-devflow 声明行应恰好 1 条').toBe(1)
  return found[0]!
}

/** 从 bundle patch 里取出新形态 preset 声明。 */
function newFormDeclaration(patchSource: string): Record<string, unknown> {
  const declared = newFormDeclarationRow(patchSource)
  if (typeof declared.name !== 'string') throw new Error('preset-dual-form: 声明行缺 name')
  if (declared.config === undefined) throw new Error('preset-dual-form: 声明行缺 config')
  return declared.config as Record<string, unknown>
}

/** 从旧形态 agent.cordis.yml 取出插件行（顶层即序列）。 */
function legacyPluginRows(source: string): unknown[] {
  const doc = parseYaml(source)
  if (!Array.isArray(doc)) throw new Error('preset-dual-form: agent.cordis.yml 顶层不是列表')
  return doc
}

// ── 用例 ────────────────────────────────────────────────────────────────────

const patchSource = readFileSync(PATCH, 'utf8')
const legacyAgentSource = readFileSync(LEGACY_AGENT, 'utf8')
const legacyMetaSource = readFileSync(LEGACY_META, 'utf8')

describe('预设双形态：新形态声明与旧形态逐条一致', () => {
  it('新形态是 @deepseek-ai/dsh-agent-preset 的一条声明行，id 为 devflow', () => {
    const config = newFormDeclaration(patchSource)
    expect(config.id).toBe(DEVFLOW_PRESET_ID)
    expect(config.order).toBe(50)
  })

  it('声明行出厂即 disabled —— 两版共存的**关键**（0.1.5 的加载器会硬失败在未解析 entry 上）', () => {
    // 实测（第十九步，0.1.5 沙箱）：
    //   dsh: plugin tree failed to load: failed to import loader entry preset-devflow
    //   (@deepseek-ai/dsh-agent-preset): Cannot find package ...
    // 而 0.1.5 自己的审计写着「Disabled entries are the only valid」未解析项
    // （packages/boot/app-boot/src/index.ts:683）。⇒ 默认必须是 disabled: true。
    const declared = newFormDeclarationRow(patchSource)
    expect(declared.disabled).toBe(true)
  })

  it('安装器只在 dsh >= 0.1.7 时才启用该声明（判据是版本号，不是「包在不在」）', () => {
    const installer = readFileSync(INSTALLER, 'utf8')
    expect(installer).toContain('Test-DshAtLeast $Version 0 1 7')
    expect(installer).toContain('Enable-PresetDeclaration')
    // 0.1.5 的 profile 里也会出现 @deepseek-ai/*（peer 解析所致）⇒ 不能用包存在与否判。
    expect(installer).toContain("'auto','on','off'")
  })

  it('插件清单（id<-name，顺序敏感）与旧形态 agent.cordis.yml 完全一致', () => {
    const config = newFormDeclaration(patchSource)
    const declared = pluginListOf(config.plugins)
    const legacy = pluginListOf(legacyPluginRows(legacyAgentSource))
    expect(declared).toEqual(legacy)
    // 顺序与内容都钉住：清单非空、且首个是激活行。
    expect(declared.length).toBeGreaterThan(0)
    expect(declared[0]).toBe(`devflow-activation<-${ACTIVATION_SOURCE_PATH}`)
  })

  it('激活行带 isolate realm（否则新版注册表按服务泄漏拒绝该预设）', () => {
    const config = newFormDeclaration(patchSource)
    const rows = config.plugins as readonly Record<string, unknown>[]
    const activation = rows.find(row => row.id === 'devflow-activation')
    expect(activation, '激活行必须存在').toBeDefined()
    expect(activation!.isolate).toEqual({ agentPresetActivation: true })
  })

  it('展示元数据（name / description / order）逐字来自 preset.yml', () => {
    const meta = parseYaml(legacyMetaSource) as Record<string, unknown>
    const config = newFormDeclaration(patchSource)
    expect(config.name).toBe(meta.name)
    expect(config.description).toBe(meta.description)
    expect(config.order).toBe(meta.order)
  })

  it('bundle patch 仍以字符串声明（0.1.5 按字符串处理 patch 字段，改成列表会坏旧版）', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})

describe('旧形态不回归', () => {
  it('目录式两个文件仍在，且 agent.cordis.yml 的激活行仍是仓库内相对路径', () => {
    const rows = legacyPluginRows(legacyAgentSource) as readonly Record<string, unknown>[]
    const activation = rows.find(row => row.id === 'devflow-activation')
    expect(activation, '旧形态激活行必须仍在').toBeDefined()
    expect(activation!.name).toBe(ACTIVATION_SOURCE_PATH)
    expect(activation!.isolate).toEqual({ agentPresetActivation: true })
    // preset.yml 的三个展示字段一个都不能少（install.ps1 整份部署它）。
    const meta = parseYaml(legacyMetaSource) as Record<string, unknown>
    for (const key of ['name', 'description', 'order']) {
      expect(meta[key], `preset.yml 缺 ${key}`).toBeDefined()
    }
  })

  it('宿主控制器行（两版通用）未被改动', () => {
    const doc = parseYaml(patchSource) as readonly Record<string, unknown>[]
    const house = doc
      .flatMap(entry => (Array.isArray(entry.insert) ? entry.insert : []) as readonly Record<string, unknown>[])
      .find(row => row.id === 'devflow')
    expect(house).toBeDefined()
    expect(house!.name).toBe('@xiaoxie-ide/dsh-devflow')
    expect(house!.config).toEqual({ stateDir: '.devflow' })
  })
})
