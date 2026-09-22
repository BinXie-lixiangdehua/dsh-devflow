# DevFlow

**版本 `0.1.0`** · 首发快照（2026-09-23）

面向 **[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)** 的**多 Agent 工作流编排插件**。

它把一个 dsh 会话变成一个小型交付组织，并把这个组织的过程**画出来**：

- **角色**：总指挥（规划与派发）· 固定员工（架构师 / 后端 / 前端 / 代码审计）· 按任务临时创建的临时子代理。
- **状态机**：派发 → 执行 → 审计 → 返工 → 验收收口。每一步都是落盘业务实体（`<工作区>/.devflow`）+ 追加式 journal。
- **派发面**：`devflow_*` 工具（任务 / 边界 / 委派 / 派发 / 状态流转 / 名册），并发上限 5 且超限排队，每次交接都有派发诊断。
- **可视化面板**：画布（一条边＝一次派发）、名册条（固定 / 临时、实时 `并发 N/5`）、节点详情栏，挂载在 dsh 右侧栏。

---

## 前置要求

| | |
|---|---|
| Node | `^22.19.0` 或 `>=24` |
| pnpm | 任意较新版本 |
| dsh | 已安装，且有一个可编辑的 profile（如 `~/.dsh/profiles/web`） |
| 系统 | **Windows 为实测平台**（preset 在 win32 接 `tool-pwsh`，其他平台接 `tool-bash`） |

## 一键安装

> 仓库**当前为私有** —— 下面这条命令需要你的 Git 凭据。**公开之后任何人可直接执行。**

**Windows（PowerShell）**，复制这一行：

```powershell
git clone https://github.com/BinXie-lixiangdehua/dsh-devflow.git "$env:USERPROFILE\.dsh\local-plugins\dsh-devflow"; & "$env:USERPROFILE\.dsh\local-plugins\dsh-devflow\install.cmd"
```

常用参数：

```powershell
.\install.ps1 -DryRun                 # 只打印将要做什么，不写任何文件
.\install.ps1 -DshHome 'C:\Users\me\.dsh' -Profile 'web'
.\install.ps1 -SkipPreset             # 不部署 preset（只装插件本体）
.\install.ps1 -Ref 'v0.1.0'           # 安装指定 tag / 分支
```

## 安装脚本到底改了什么

**只动四处**，且每个被改写的文件都会先备份：

1. **落盘**：克隆（或复制）到 `~/.dsh/local-plugins/dsh-devflow`（默认）。
2. **注册 profile bundle**：在 `~/.dsh/profiles/<profile>/package.json` 里加 `"@xiaoxie-ide/dsh-devflow": "link:<安装目录>"`，并把包名加进 `dsh.profile.bundles`。原文件备份为 `package.json.bak-devflow-<时间戳>`。
3. **建立 link**：在 profile 里跑一次 `pnpm install`，让 `link:` 符号链接真正生效。
4. **部署 agent preset**：把 `presets/devflow/{agent.cordis.yml, preset.yml}` 拷到 `~/.dsh/.agent-presets/devflow/`，并把第 1 行的激活路径从"相对检出路径"改写为绝对 `file:///.../lib/host/preset-activation.js?rev=<sha>`。

然后**重启 dsh**，开会话，选 **DevFlow** preset —— 安装就完成了。

> `?rev=` 令牌的用途：常驻挂载只在组合的戳记变化时才重新导入，且 URL 不变时会被 ESM 模块缓存拦住。改完 `lib/` 之后**递增 `rev`**，才能让运行中的宿主拿到新模块而不必重启。

## 手动安装

```powershell
# 1. 把代码放到你想放的位置
git clone https://github.com/BinXie-lixiangdehua/dsh-devflow.git D:\plugins\dsh-devflow

# 2. 在 profile 里注册（编辑 ~/.dsh/profiles/web/package.json）
#    dependencies:        "@xiaoxie-ide/dsh-devflow": "link:D:\\plugins\\dsh-devflow"
#    dsh.profile.bundles: 加入 "@xiaoxie-ide/dsh-devflow"

# 3. 让 link 生效
pnpm install --dir "$env:USERPROFILE\.dsh\profiles\web"

# 4. 部署 preset：拷 presets\devflow\*.yml 到 ~/.dsh/.agent-presets/devflow/
#    并把 agent.cordis.yml 里的  ../../lib/host/preset-activation.js
#    改成                      'file:///D:/plugins/dsh-devflow/lib/host/preset-activation.js?rev=local'
```

## 从源码构建

`lib/` 是**刻意提交**的 —— 这样安装不需要任何构建工具链。改了 `src/` 之后请重新构建并提交产物：

```bash
pnpm install
pnpm typecheck   # 两个 project 的 tsc
pnpm build       # tsc + tsdown  ->  lib/index.js, lib/client.js
pnpm check       # 对两个 bundle 跑 node --check
pnpm test        # vitest
```

**闸门顺序不可颠倒**：`typecheck → build → check → test`（`check` 检查的是 `lib/`，跑在 `build` 之前等于检查旧产物）。

重建后请递增部署副本里的 `?rev=` 令牌，或重启 dsh。

## 卸载

1. 删除 `~/.dsh/.agent-presets/devflow/`。
2. 回退第 2 步：去掉依赖行与 `dsh.profile.bundles` 里的条目（或直接用 `package.json.bak-devflow-<时间戳>` 还原）。
3. 在 profile 里再跑一次 `pnpm install`，然后删掉插件目录。

`.devflow` 目录在**你的项目工作区里**，不在本仓库内；它是你的项目状态，需要清空时请自行处理。

## 目录结构

```
src/host/          插件宿主侧：工具面、状态机、存储、journal、守卫
src/client/        面板：画布、投影、名册、右侧栏 slot
presets/devflow/   dsh agent preset（激活行 + 能力行）
tests/             vitest 用例（单元 + 守卫/隔离）
lib/               构建产物 —— 刻意提交，保证"零构建安装"
cordis.patch.yml   dsh bundle patch
install.ps1/.cmd   上面那条一键安装命令
```

## 版本

插件还在演进期，故为 `0.x`。每次发布快照都会打一个**附注标签**（`v0.1.0`、`v0.1.1`…），且 `package.json` 的 `version` 与标签一致 —— 这样 `git checkout v0.1.0` 与"锁版本安装"指的是同一份东西。

## 许可

MIT，见 [LICENSE](LICENSE)。
