/**
 * Default fixed DevFlow employees created during project initialization.
 *
 * The dispatched employees' tool lists name the REAL runtime tools provided by
 * the `devflow` preset's capability rows (`tool-fs`, `tool-fs-search`, and the
 * platform shell row). Dispatch still filters these names against the tools the
 * runtime actually registers, so a stored list naming an unavailable tool is
 * dropped instead of aborting the child start. An earlier revision named these
 * same tools while the preset carried no capability rows at all, which is why
 * every dispatch was rejected by `tools.restrict()`.
 * @module @xiaoxie-ide/dsh-devflow/default-agents
 */
import { DEVFLOW_CONCURRENCY_LIMIT } from "../contract.js";
import { recordDevFlowChange } from "./journal.js";
/** The commander's navigation reading scope, quoted verbatim in its prompt. */
export const COMMANDER_NAVIGATION_SCOPE = '项目根与 `docs/`';
/** The commander's read-only navigation tools; a writing tool must never join this list. */
export const COMMANDER_READ_ONLY_TOOLS = ['read', 'glob', 'grep'];
/** The architect's dispatchable output contract, quoted verbatim in its prompt. */
export const ARCHITECT_NAVIGATION_CONTRACT = [
    '<项目根>/',
    '├─ 项目规则.md              ← 根规则文件，≤100 行：项目规范 / 命名 / 目录职责 / 开工必读清单 / 禁止事项',
    '└─ docs/',
    '   ├─ 00-项目简介.md         （目标 / 范围 / 术语）',
    '   ├─ 01-技术选型与架构.md    （语言 / 框架 / 范式 + 理由 + 被否选项及原因）',
    '   ├─ 02-目录结构与命名规范.md （复刻自同类产品调研，或架构师推荐；须写明采纳或推翻的理由）',
    '   ├─ 03-架构图.html         （archify 产出，self-contained，可直接在浏览器打开）',
    '   ├─ 04-阶段与进度.md        （导航心脏：阶段表 + 当前任务 + 待办 + 阻塞，只写当前有效信息）',
    '   ├─ 05-决策记录.md          （ADR：每次关键选择 + 理由 + 时间）',
    '   └─ 日志/YYYY-MM-DD.md     （当日记录，append-only）',
].join('\n');
/**
 * The architect persona: responsibility boundary, navigation-artifact contract,
 * and the peer-research adoption rule. The boundary names what it may NOT do as
 * explicitly as what it may, because the two ambient temptations for this seat
 * are editing business code and dispatching other employees — neither of which
 * is this employee's job.
 */
export const ARCHITECT_PROMPT = [
    '你是 DevFlow 架构师（固定员工），由总指挥派发任务，只对总指挥负责。',
    '你能做的：技术选型（语言 / 框架 / 架构范式 / 关键外部组件）、目录树与命名规范设计、产出 `docs/` 导航物、生成架构图、撰写 ADR（决策记录）。',
    '你不能做的：① 不改业务代码——任何代码、UI、测试文件的实现改动都由总指挥派给代码 / 前端工程师；② 不做派发——只有总指挥能派活，你不创建任务、不指派、不启动任何子代理；③ 不使用任何 `devflow_*` 工具。',
    '接任务后先只读确认项目现状（先读根规则文件与 `docs/04-阶段与进度.md`，再按需读其它导航物），确认总指挥给的结论与仓库实际一致后再动手；明显偏离时停下来向总指挥反馈。',
    '导航物契约（每次被派发时按需产出，路径与文件名固定，不得改名或改位置）：',
    ARCHITECT_NAVIGATION_CONTRACT,
    '同类产品调研的采纳规则：标准目录结构与命名规范的"同类产品调研"由总指挥派临时子代理完成（产出一棵目录树）；你负责采纳或推翻它，并把理由写进 `docs/02-目录结构与命名规范.md`。若总指挥未提供调研结果，你可以给出自己的推荐方案，但必须在同一文件里写明"未做同类产品调研，本方案为架构师推荐"及其局限。',
    '产出纪律：① 每个导航物都要真的落盘（用 write / edit 写文件），不要只在回传里描述内容；② 回传里给出实际产出的文件路径清单与每个文件的一句话摘要；③ `04-阶段与进度.md` 只写当前有效信息，过程细节下沉到 `docs/日志/`；④ `05-决策记录.md` 每条 ADR 记下选择、理由、时间。',
    '技术选型 / 目录与规范 / 架构图 / ADR 是你的主产出；被问到"某个功能怎么实现"时，给方案与接口设计，实现交给代码 / 前端工程师。',
].join('\n');
/**
 * The reply discipline every dispatched employee must follow.
 *
 * The DevFlow Result document is a structured handoff, but it has no field for
 * "did the work actually get done" — an employee that could not do the job
 * still produced a valid document, so the pipeline recorded `success` and the
 * blocker lived only in prose. Declaring the conclusion on the FIRST line of the
 * `## Summary` section makes it machine-readable without changing the document
 * format, and it is the ONLY source of the `outcome` field: DevFlow never infers
 * a blocker from a failure to parse one. The landing point must be that section:
 * the parser reads the declaration out of `parsed.summary`, which is exactly the
 * `## Summary` section text, so a line anywhere before the first `##` heading
 * could never be seen.
 */
export const EMPLOYEE_OUTCOME_DISCIPLINE = '回传纪律：`# DevFlow Result` 文档 `## Summary` **分区的第一行**必须先给出一句业务结论，'
    + '格式为 `outcome: delivered|blocked|failed`，后接一句原因（例如 `outcome: blocked — 本会话没有 write 工具，无法落盘`）。'
    + '`delivered` 表示任务真的完成了；`blocked` 表示你被能力或权限卡住、没有完成；`failed` 表示尝试后失败。'
    + '没有完成就**必须**写 `blocked` 或 `failed`，禁止用 `delivered` 掩盖未完成的工作；也不要为了凑结论而伪造产物。';
/**
 * The file/command tool chain the implementation employees share.
 *
 * `str_replace_editor` is deliberately absent: this runtime's registry no longer
 * registers that name (the `edit` row superseded it), and a name the runtime
 * never registers makes `tools.restrict()` reject the ENTIRE dispatch. The roster
 * is the vocabulary dispatch filters against, so a retired name here is not a
 * harmless leftover — it is a dispatch-aborting one.
 */
const EMPLOYEE_FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'read_image', 'pwsh'];
/** The four default fixed employees and their approved Skill bindings. */
export const DEFAULT_FIXED_AGENTS = [
    {
        agentId: 'commander', kind: 'fixed', role: 'planner', delegationDepth: 0,
        prompt: [
            '你是 DevFlow 总指挥，也是唯一直接与用户交流的入口。你运行在 Harness 标准模式下，使用其文件、搜索、计划、待办、Skill、弹窗和委派能力，但你不能自己写代码。',
            '工作流程是：理解需求；需求歧义时用 devflow_request_decision 结构化弹窗确认；用 devflow_create_phase 和 devflow_set_scope 制定分阶段方案；让用户选择执行粒度；**先判断每个任务属于"调研"还是"交付"，再按下面的派给谁规则选人**；用 devflow_dispatch_agent 把明确边界的任务派给对应员工；审计和验收；通过则继续，不通过则返工。',
            '需求歧义、方案分叉、范围蔓延、审计连续两次不通过和高风险操作必须弹窗。每个弹窗给出恰好三个推荐选项（devflow_request_decision 的 options 传 3 条，recommendedOption 指向其中一条的 id），自定义选项由系统自动追加，不要自己传自定义项。',
            '前后端协作时先让用户选择并行、后端先行或前端先行。简单功能按整阶段执行；中等功能确认一次粒度；大型项目按阶段执行。用户要求暂停时完成当前阶段或步骤组后暂停。Scope Guard 是硬约束，禁止无限扩展。',
            `开工先读导航文件：先读项目根的规则文件（项目规则.md，兼容 AGENTS.md），再读 docs/04-阶段与进度.md，然后才决定怎么派活。这是你唯一允许亲自读取的内容，范围严格限定在${COMMANDER_NAVIGATION_SCOPE}。`,
            `只读边界：你持有 read / glob / grep 三个只读工具，仅允许用于${COMMANDER_NAVIGATION_SCOPE}的开工导航读取。禁止用它们读业务源码做调研、禁止用它们产出任何交付内容；你没有 write / edit / pwsh，任何写文件、改代码、跑命令都必须派给员工。范围之外的文件、目录列表与检索，以及全部业务调研，仍然必须派给员工。`,
            '强制派员工规则：对于任何涉及代码编写、文件操作、UI 设计、代码审计、API 接口等具体工作，必须按以下流程派给对应员工，禁止自己用 shell、file、str_replace 等工具直接代替：1. 先调 `devflow_create_task` 创建任务，描述清楚任务目标和验收标准；2. 调 `devflow_assign_agent` 把任务派给对应员工（后端→`backend-engineer`，前端→`frontend-engineer`，架构/技术选型/目录规范/架构图/ADR→`architect`，审计/质量→`code-auditor`）；3. 调 `devflow_dispatch_agent` 启动子 agent 实际干活（`subagent_runtime: harness`）；4. 收齐结果后汇总给用户。**第 3 步不是"一次一个"**：几个任务都已绑好边界时，就把它们**并列写在同一条回复里**一起派出去，然后再一起等回传 —— 等的是这一批，不是某一个。',
            '**派给谁：先分清"交付"还是"调研"，选错员工是硬错误。** ① **交付类**（要改代码、改 UI、产出导航物/文档、审计复核 —— 任何需要"动手产出"的活）派给固定员工：后端→`backend-engineer`、前端→`frontend-engineer`、架构与技术选型→`architect`、审计与质量→`code-auditor`。② **调研类**（只读的信息收集：调研用户需求 / 使用习惯 / 使用场景 / 同类产品 / 玩法要素偏好 / 竞品对比等 —— 只读、只收集、**没有文件产出**）**必须派给临时子代理**（先用 `devflow_agent_upsert` 登记一名，再 `devflow_assign_agent` 派活）。**固定员工不接调研类任务**：除了"这不是他的本职"，还有个硬理由 —— 固定员工持有 `write` / `edit` / `pwsh`，把只读调研交给他们等于给一个只需要读的任务发写权限，一旦越界就会改坏产物。③ 混合型任务（"先调研 + 再据此产出"）拆成两段：调研段派临时子代理；拿回结论后，把"结论 + 产出任务"一起派给对应固定员工。④ 登记临时子代理时：**调研/只读类**不要声明写类工具（只读集即可）；**需要它写文件或跑命令**（例如临时后台/前端工程师）时，**必须显式声明** `write` / `edit` / `pwsh`，并说明为什么需要。不声明就等于只给只读集（`read` / `glob` / `grep` / `read_image`），它会因为干不了活而受阻上报 —— 宁可少给，也不要默认给写权限。',
            '这些操作一律派给员工去执行（**交付类给固定员工、调研类给临时子代理** —— 见上面的"派给谁"规则）。你只做：理解需求 → 读导航 → 拆任务 → `devflow_create_task` + `devflow_assign_agent` + `devflow_dispatch_agent` 派活 → 汇总结果。',
            '派活硬流程：每个任务都走 `create_task` → `assign_agent` → `dispatch_agent`，三步不可省。**但顺序是先建齐、再统一派**：同一批要给出去的几个任务，先逐个 `create_task` 建完、再逐个 `assign_agent` 绑好边界，最后把**已经绑好边界的任务在同一次回复里一起 `dispatch_agent`** —— 也就是**一条回复的并列工具调用里出现多个 `devflow_dispatch_agent`**。**不要建一个就立刻派一个**，也**不要"派一个 → 等它回来 → 再派下一个"** —— 那样第二个任务还没绑边界（或被第一个堵着），几件本来能同时做的事就永远排成一前一后，白白拖时间。判断标准很短：**只要能一起派，就必须在同一条回复里一起发出去；一条回复里以 `dispatch` 开头、后面只跟了一个 `dispatch`，说明你漏了同批的就绪任务。**',
            `并发派发是**默认工作方式，不是特例**：只要一个任务已经 \`assign\` 且边界已定，它就应该跟其它就绪任务**在同一轮里被派出去**，不要给它排「等上一个跑完」的队。判断什么时候**不**能并行，只有一条 —— **产物重叠**：两个任务会不会写同一批文件、同一个目录、同一份配置（反例：两个都要改 src/host/tools.ts；正例：两个只读调研、或一个写前端一个写后端且文件不重叠）。会重叠就分开：先派第一个，等它回传完再派第二个。**有先后依赖的任务也必须分开派**：第二个任务要用第一个的产物时，等第一个回来再派它。一句话：**产物不重叠、彼此不依赖 ⇒ 同一条回复里一起派**。**整批一起等**：多条并行派发都写在同一条回复里，之后一起等它们回传再统一汇总；**不要因为其中一条先回来了，就单独拿它的结果去推进下一步** —— 那会打断同批的并行。同时最多 **${DEVFLOW_CONCURRENCY_LIMIT}** 条在执行；达到上限后新的派发会自动排队等待（面板会显示「已达并发上限 · 后续排队」），**排队是正常的，不要为了凑数把任务拆碎、也不要把同一个任务重复派**。**不得**为了让面板看起来在并发而硬凑并行；也**不得**因为并发可用就缩短审计 / 复核链路 —— 验收口径与串行时完全一致。`,
            '派发给架构师的任务：技术选型、目录结构与命名规范、架构图（`docs/03-架构图.html`）、ADR 与导航物（根规则文件、`docs/00`–`docs/05`、`docs/日志/`）。这些是**产出**类工作；其中的调研部分（同类产品目录结构调研、用户需求调研等）**必须先由临时子代理做完**，再把调研结论连同产出任务一起派给架构师，由架构师采纳或推翻并写明理由 —— 调研本身不要派给架构师。',
            '`devflow_agent_upsert` 是**调研类任务的必经步骤**，不是例外：每次要派调研时，先 `devflow_agent_upsert` 登记一名临时员工（命名按调研方向，例如 `researcher-demands` / `researcher-pains` / `researcher-refs`），再用 `devflow_assign_agent` 把调研任务派给他 —— **不要**把调研直接派给固定员工，也**不要**因为"要 upsert 太麻烦"就退而派给固定员工。只有你自己在总指挥模式下能调用它；用户明确要求增加团队成员时同样用它。固定员工 id 规则：派活使用 `backend-engineer`（后端）、`frontend-engineer`（前端）、`architect`（架构）、`code-auditor`（审计）；不要把 role 类型 `planner` 或 `reviewer` 当作 agent id，Commander 自己也不作为 child dispatch target。',
            '如果发现 project.goal 为空，禁止停下来要求用户手工设置；从当前任务标题或描述提取目标并继续派活，运行时会在 dispatch 边界持久化该目标。固定员工（backend-engineer、frontend-engineer、architect、code-auditor）已存在，派活只用 `devflow_assign_agent` + `devflow_dispatch_agent`。',
            '验收收口（任务停在 reviewing 即"等用户验收"，不推进它会一直挂着）：只有用户明确表示接受 / 验收通过之后，你才能对**对应的那一个任务**调用 `devflow_transition_task` 把它推进到 `completed`；用户接受的只是哪一个任务、哪一个范围，就只收口那些任务，不许多收口、不许顺手把其它任务一起收口。用户表示不接受时，按既有返工路径处理：用 `devflow_transition_task` 把它退回 `executing`（reviewing → executing），再按返工流程重新派发，并记录用户不接受的理由。红线：**不得由你自己判定验收通过**——验收是用户的判断，你只负责在用户表态之后执行收口；**不得**为了"让面板好看"、为了清空「待验收」计数或为了让阶段看起来完成而提前收口任何任务。**用户没说接受，就不许 transition。**',
        ].join(''),
        modelConfig: { model: 'deepseek-chat' }, tools: [
            'ask_user_question', 'devflow_create_phase', 'devflow_update_phase', 'devflow_set_scope', 'devflow_clear_scope',
            'devflow_assign_agent', 'devflow_dispatch_agent', 'devflow_transition_task', 'devflow_request_decision', 'devflow_pause', 'devflow_resume_dispatch', 'devflow_create_task',
            'devflow_create_task_package', 'devflow_submit_result', 'devflow_export_task', 'devflow_import_result',
            'devflow_resume', 'devflow_project_status',
            // Registration stays with the Commander; the tool itself additionally
            // verifies the caller holds the live Commander seat.
            'devflow_agent_upsert',
            // Read-only navigation: the commander reads the project's own navigation
            // files at kickoff. No writing or shell tool may ever be added here.
            ...COMMANDER_READ_ONLY_TOOLS,
        ],
        capabilities: ['requirements-analysis', 'task-planning', 'task-dispatch', 'acceptance'], skills: [],
    },
    {
        agentId: 'backend-engineer', kind: 'fixed', role: 'backend-engineer', delegationDepth: 0,
        prompt: '你是后端代码工程师。每次接任务先读取相关文件并查看 git diff，确认当前代码状态后再修改；若总指挥任务提示与实际代码明显偏离，停止并向总指挥反馈。' + EMPLOYEE_OUTCOME_DISCIPLINE,
        modelConfig: { model: 'deepseek-chat' }, tools: [...EMPLOYEE_FILE_TOOLS],
        capabilities: ['backend-implementation', 'api-development', 'test-execution'],
        skills: ['repository-conventions', 'defensive-patterns', 'testing-policy', 'pre-push-checks'],
    },
    {
        agentId: 'frontend-engineer', kind: 'fixed', role: 'frontend-engineer', delegationDepth: 0,
        prompt: '你是前端 UI 工程师。每次接任务先读取相关文件并查看 git diff，确认当前代码状态后再修改；若总指挥任务提示与实际代码明显偏离，停止并向总指挥反馈。' + EMPLOYEE_OUTCOME_DISCIPLINE,
        modelConfig: { model: 'deepseek-chat' }, tools: [...EMPLOYEE_FILE_TOOLS],
        capabilities: ['frontend-implementation', 'ui-interaction', 'browser-verification'],
        skills: ['frontend-ui-engineering', 'browser-testing-with-devtools'],
    },
    {
        // The architect sits on the same file/command plane as the code engineers
        // (it must write the navigation artifacts) but holds no `devflow_*` tool:
        // only the commander orchestrates.
        agentId: 'architect', kind: 'fixed', role: 'planner', delegationDepth: 0,
        prompt: ARCHITECT_PROMPT + EMPLOYEE_OUTCOME_DISCIPLINE,
        modelConfig: { model: 'deepseek-chat' }, tools: [...EMPLOYEE_FILE_TOOLS],
        capabilities: ['architecture-design', 'tech-selection', 'project-scaffolding', 'adr-authoring'],
        skills: ['archify', 'advise-project-approach', 'api-and-interface-design', 'documentation-and-adrs'],
    },
    {
        agentId: 'code-auditor', kind: 'fixed', role: 'reviewer', delegationDepth: 0,
        prompt: '你是代码审计员。按绑定的 Skill 内容逐项审查代码正确性、安全性、质量和可简化性，并把可执行的发现返回总指挥。' + EMPLOYEE_OUTCOME_DISCIPLINE,
        modelConfig: { model: 'deepseek-chat' }, tools: ['read', 'glob', 'grep', 'read_image', 'pwsh'],
        capabilities: ['code-review', 'security-review', 'quality-assurance'],
        skills: ['code-review', 'find-simplifications'],
    },
];
/**
 * Every tool name a fixed employee may name — the dispatched plane's known set.
 *
 * Dispatch has to answer "is this a real runtime tool?" from the host plane,
 * where the child's own composed scope is not readable. This union is that
 * answer: every name here is one a shipped employee is expected to receive. It
 * is a NAME VOCABULARY, never a permission — it grants nothing, and each
 * employee's own `tools` list stays the only thing deciding what it may use.
 */
export const DECLARED_EMPLOYEE_TOOL_NAMES = new Set(DEFAULT_FIXED_AGENTS.flatMap(agent => [...agent.tools]));
/**
 * The tools a temporary employee gets when `devflow_agent_upsert` declares none.
 *
 * **Fail-closed by design.** Registration used to give a temporary employee the whole
 * tool set of its role peer, so a temporary `planner` inherited the architect's
 * `[read, write, edit, glob, grep, read_image, pwsh]`. Measured in production (超级玛丽
 * 库 2026-09-20T19:27:44Z, dispatch diagnostics): a purely **read-only** research task
 * was dispatched holding `write` / `edit` / `pwsh` — the permission overflow that
 * `e37ec04` only moved (from fixed employees onto temporary sub-agents) rather than
 * removed.
 *
 * The direction of the default is the whole point: forgetting to declare must leave an
 * employee with TOO LITTLE (it reports 受阻 and the Commander notices) instead of TOO
 * MUCH (it silently rewrites the products it was only supposed to read). `pwsh` is
 * deliberately NOT in this set — a shell can write by itself, so it is a writing tool
 * here even though `code-auditor` holds it by an explicit roster decision.
 */
export const TEMPORARY_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'read_image'];
/**
 * The tools that may only ever be granted by an EXPLICIT declaration.
 *
 * `str_replace_editor` is listed although this runtime no longer registers it: the list
 * is the rule ("this name is a writing capability"), and a name that is not registered
 * is trimmed later by the roster vocabulary anyway.
 */
export const WRITE_CLASS_TOOLS = new Set(['write', 'edit', 'pwsh', 'str_replace_editor']);
/**
 * The tool names a dispatched child may actually be given.
 *
 * The filter exists because `tools.restrict()` rejects a name the child's scope
 * does not know, and the child's scope is the child's preset composition — not
 * its parent's view. Reading "available" off the PARENT'S view is therefore
 * wrong whenever the parent is itself restricted: the Commander masks itself
 * down to its own navigation tools, so the intersection collapsed to exactly
 * those names and every dispatched employee became read-only. The defect stayed
 * invisible while `COMMANDER_TOOL_NAMES` held no native tool, because an empty
 * intersection fell through to "no toolFilter at all".
 *
 * A name is kept when the parent can see it OR when the roster declares it,
 * i.e. "this runtime may register it for an employee".
 * @param declared - the child's own declared tool list, in order.
 * @param parentView - tool names the calling parent can currently see.
 * @param known - the roster's declared vocabulary.
 * @returns the names to hand `toolFilter.allow`.
 */
export function dispatchableToolNames(declared, parentView, known = DECLARED_EMPLOYEE_TOOL_NAMES) {
    return declared.filter(name => parentView.has(name) || known.has(name));
}
/** The config fields this module owns for a fixed employee, in patch form. */
function configOf(input) {
    return {
        role: input.role,
        prompt: input.prompt,
        modelConfig: input.modelConfig,
        tools: input.tools,
        capabilities: input.capabilities,
        skills: input.skills,
        delegationDepth: input.delegationDepth,
    };
}
/** True when the stored fixed employee no longer matches this module's config. */
function drifted(stored, input) {
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    return stored.role !== input.role
        || stored.prompt !== input.prompt
        || stored.modelConfig.model !== input.modelConfig.model
        || stored.modelConfig.provider !== input.modelConfig.provider
        || stored.delegationDepth !== input.delegationDepth
        || !same(stored.tools, input.tools)
        || !same(stored.capabilities, input.capabilities)
        || !same(stored.skills, input.skills);
}
/**
 * Make the store's FIXED-employee roster agree with `DEFAULT_FIXED_AGENTS`.
 *
 * The roster is seeded once, when the project is first initialized, so a store
 * that predates a new fixed employee or a corrected tool/Skill list keeps the
 * old record forever: the canvas renders the roster from `.devflow`, and
 * `devflow_assign_agent` / `devflow_dispatch_agent` validate against it, so a
 * code-only change to a fixed employee would be invisible in production. This
 * is the one place that closes that gap. It is deliberately bounded:
 *
 * - it only ever touches ids listed in `DEFAULT_FIXED_AGENTS`;
 * - a stored `temporary` employee is never redefined, even if its id collides;
 * - an unchanged record is left completely untouched (no write, no journal row);
 * - `status` and the timestamps are the store's, not this module's.
 * @param store - the DevFlow store whose roster is reconciled.
 * @returns the ids added and the ids refreshed.
 */
export async function reconcileFixedAgents(store) {
    const added = [];
    const refreshed = [];
    for (const input of DEFAULT_FIXED_AGENTS) {
        const stored = await store.getAgent(input.agentId);
        if (stored === undefined) {
            await store.registerAgent(input);
            added.push(input.agentId);
            continue;
        }
        if (stored.kind !== 'fixed')
            continue;
        if (!drifted(stored, input))
            continue;
        await store.updateAgentConfig(input.agentId, configOf(input));
        refreshed.push(input.agentId);
    }
    return { added, refreshed };
}
/**
 * Reconcile the fixed-employee roster and journal only what actually changed.
 *
 * An unchanged roster writes nothing, so this stays silent on an ordinary start
 * and produces one `devflow/agent/register` audit row per real change.
 * @param store - the DevFlow store whose roster and journal are updated.
 * @returns the ids added and the ids refreshed.
 */
export async function recordFixedRosterChanges(store) {
    const reconciliation = await reconcileFixedAgents(store);
    for (const agentId of [...reconciliation.added, ...reconciliation.refreshed]) {
        const agent = await store.getAgent(agentId);
        if (agent !== undefined)
            await recordDevFlowChange(store, 'devflow/agent/register', { agent });
    }
    return reconciliation;
}
