/* 派发流画布（第三栏内容层）样式：画布占满，其余控件均为画布上的浮层。
   本文件自带两套皮肤（浅色 iOS 扁平 / 暗金液态玻璃），全部颜色走 --flow-* 变量：
   皮肤只改"背景层"，五态语义色与四类关系线型不受皮肤影响。 */
import {
  FLOW_DASH_PERIOD,
  FLOW_DONE_SWEEP_MS,
  FLOW_DASH_HEAD,
  FLOW_DASH_TAIL,
  FLOW_ENTER_MS,
  FLOW_FLOW_OPACITY_WEAK,
  FLOW_FLOW_WIDTH,
  FLOW_FLOW_WIDTH_WEAK,
  FLOW_GLOW_GOLD,
  FLOW_GLOW_LIGHT,
  FLOW_GLOW_REWORK_GOLD,
  FLOW_GLOW_REWORK_LIGHT,
} from './motion.ts'

/** 一次扫光的时长（秒），与 motion.ts 的 FLOW_DONE_SWEEP_MS 同源。 */
const FLOW_SWEEP_SECONDS = (FLOW_DONE_SWEEP_MS / 1000).toFixed(2)
/** 卡片入场的时长（秒），与 motion.ts 的 FLOW_ENTER_MS 同源。 */
const FLOW_ENTER_SECONDS = (FLOW_ENTER_MS / 1000).toFixed(3)

export const DEVFLOW_FLOW_CSS = `
/* ===== 皮肤变量 ===== */
.devflow-canvas.devflow-flow{
  --flow-run:var(--blue);--flow-done:var(--green);--flow-warn:var(--amber);--flow-bad:var(--red);--flow-lost:#6b7d8f;
  --flow-link:#4a7fa8;
  /* 流动亮头：比语义色更亮的同色相高亮（§一·前.1）。三种速率各一档，排队最弱。 */
  --flow-glow:${FLOW_GLOW_GOLD};--flow-glow-rework:${FLOW_GLOW_REWORK_GOLD};--flow-glow-weak:#8fb6d8;
  --flow-ink:#e8eef4;--flow-muted:#93a4b4;--flow-line:rgba(177,201,219,.28);--flow-line-soft:rgba(177,201,219,.14);
  --flow-bg:rgba(14,25,38,.74);--flow-surface-solid:#16283a;--flow-card:rgba(24,42,60,.56);
  --flow-panel:rgba(13,23,35,.78);--flow-chip:rgba(13,23,35,.70);--flow-inset:rgba(255,255,255,.07);--flow-sheen:rgba(255,255,255,.06);
  --flow-accent:var(--blue);--flow-accent-ink:#dff3fb;--flow-accent-soft:rgba(84,184,211,.16);
  --flow-shadow:0 6px 18px rgba(0,0,0,.28);
  --flow-grid:rgba(177,201,219,.07);
  --flow-blur:16px;
}
/* 暗金：深底 + 克制的暗金点缀（徽标、选中态、关键分隔、图标描边）。 */
html[data-devflow-skin=gold] .devflow-canvas.devflow-flow{
  --flow-bg:rgba(12,14,18,.72);--flow-surface-solid:#191d25;--flow-card:rgba(32,36,46,.54);
  --flow-panel:rgba(16,18,23,.80);--flow-chip:rgba(16,18,23,.70);
  --flow-ink:#efe7d8;--flow-muted:#a2967f;--flow-line:rgba(214,188,132,.30);--flow-line-soft:rgba(214,188,132,.16);
  --flow-accent:#d8b45a;--flow-accent-ink:#f6e9c8;--flow-accent-soft:rgba(216,180,90,.16);
  --flow-inset:rgba(255,255,255,.06);--flow-sheen:rgba(255,255,255,.07);
  --flow-shadow:0 8px 22px rgba(0,0,0,.42);
  --flow-grid:rgba(214,188,132,.06);
  /* 暗金皮肤：亮头维持"比语义色更亮"的同色相高亮，不引入金色。 */
  --flow-glow:${FLOW_GLOW_GOLD};--flow-glow-rework:${FLOW_GLOW_REWORK_GOLD};--flow-glow-weak:#8fb6d8;
}
/* 浅色：干净的白/浅灰底、iOS 扁平（弱阴影、统一圆角、留白充足）。
   五态色只做"同色相加深"，保证浅底上的对比度；关系线型完全不变。 */
html[data-devflow-skin=light] .devflow-canvas.devflow-flow{
  --flow-run:#0b6f8d;--flow-done:#12734f;--flow-warn:#96620f;--flow-bad:#b3261e;--flow-lost:#6b7280;
  --flow-link:#7c8794;
  --flow-ink:#1c1c1e;--flow-muted:#6b7280;--flow-line:rgba(60,60,67,.18);--flow-line-soft:rgba(60,60,67,.10);
  --flow-bg:rgba(247,247,249,.80);--flow-surface-solid:#ffffff;--flow-card:rgba(255,255,255,.70);
  --flow-panel:rgba(255,255,255,.84);--flow-chip:rgba(255,255,255,.78);
  --flow-accent:#0a84ff;--flow-accent-ink:#0a3f78;--flow-accent-soft:rgba(10,132,255,.12);
  --flow-inset:rgba(255,255,255,.9);--flow-sheen:rgba(255,255,255,.85);
  --flow-shadow:0 1px 2px rgba(0,0,0,.06);
  --flow-grid:rgba(60,60,67,.05);
  /* 浅色皮肤：白底上必须有足够对比，所以亮头取同色相"更深更饱和"的一档。 */
  --flow-glow:${FLOW_GLOW_LIGHT};--flow-glow-rework:${FLOW_GLOW_REWORK_LIGHT};--flow-glow-weak:#5f7f9c;
}
html[data-devflow-skin=light] .devflow-canvas.devflow-flow{background:var(--flow-surface-solid);color:var(--flow-ink)}

/* 面板必须"正好装进宿主给的面板槽"：.devflow-canvas 默认是 content-box，
   height:100% 再加 18/36 的上下内边距就会比槽高 54px ⇒ 宿主面板体变成可滚动，
   滚轮在画布上会把它滚走（R2 实测：整块面板上移 54px）。改成 border-box 后
   面板体没有可滚动余量，画布滚轮只做缩放。 */
.devflow-canvas.devflow-flow{box-sizing:border-box;height:100%;min-height:0;padding:0;overflow:hidden;overscroll-behavior:contain;color:var(--flow-ink)}
.devflow-flow{display:flex;flex-direction:column;gap:0;height:100%;min-height:0;overflow:hidden}
.devflow-flow-canvas{position:relative;display:flex;flex:1 1 auto;min-height:0;min-width:0}
/* 液态玻璃：面板容器一层，卡片一层，侧栏与底部提示行各一层——数量受控。 */
.devflow-flow-viewport{position:relative;flex:1 1 auto;height:100%;min-width:0;min-height:0;box-sizing:border-box;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-bg);-webkit-backdrop-filter:blur(var(--flow-blur)) saturate(140%);backdrop-filter:blur(var(--flow-blur)) saturate(140%);overflow:hidden;overflow:clip;cursor:grab;touch-action:none;user-select:none;overscroll-behavior:contain}
.devflow-flow-viewport[data-panning=true]{cursor:grabbing}
.devflow-flow-grid{position:absolute;inset:0;background-image:linear-gradient(var(--flow-grid) 1px,transparent 1px),linear-gradient(90deg,var(--flow-grid) 1px,transparent 1px);background-size:24px 24px}
.devflow-flow-world{position:absolute;left:0;top:0;transform-origin:0 0}
.devflow-flow-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:1}
/* 关系看线型（dash pattern），状态看颜色（stroke）。皮肤只改背景层，这两条不变。 */
.devflow-flow-edge{fill:none;stroke:var(--flow-link);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.devflow-flow-edge[data-edge-semantic=requirement]{stroke-width:1.2;stroke-dasharray:2 3}
.devflow-flow-edge[data-edge-semantic=dispatch]{stroke-dasharray:none}
.devflow-flow-edge[data-edge-semantic=delivery]{stroke-dasharray:9 3 2 3}
.devflow-flow-edge[data-edge-semantic=rework]{stroke-dasharray:12 4}
.devflow-flow-edge[data-edge-semantic=subagent]{stroke-dasharray:2 4}
.devflow-flow-edge[data-edge-state=executing]{stroke:var(--flow-run)}
.devflow-flow-edge[data-edge-state=done]{stroke:var(--flow-done)}
.devflow-flow-edge[data-edge-state=rework]{stroke:var(--flow-bad)}
/* 第五态：未收尾/失联——灰、细、更稀的虚线（静态，不流动）。 */
.devflow-flow-edge[data-edge-state=lost]{stroke:var(--flow-lost);stroke-width:1.1;stroke-dasharray:14 6;opacity:.8}
/* 第六种表现：收尾终态（第四步）。它不是"失联"——它是"这条派发已经收尾了"，所以用
   更沉、更整齐的点线（明确"结束"，不暗示"还在等"），并且**一律静止**
   （动 = 正在发生；收尾不是正在发生）。这是本轮唯一新增的表现，五态语义/颜色/图例未动。 */
.devflow-flow-edge[data-edge-state=closed]{stroke:var(--flow-lost);stroke-width:1.3;stroke-dasharray:2 4;opacity:.55}
.devflow-flow-edge[data-selected=true]{stroke-width:3.2}
.devflow-flow-arrow{fill:none;stroke:var(--flow-link);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.devflow-flow-arrow[data-arrow-state=executing]{stroke:var(--flow-run)}
.devflow-flow-arrow[data-arrow-state=done]{stroke:var(--flow-done)}
.devflow-flow-arrow[data-arrow-state=rework]{stroke:var(--flow-bad)}
.devflow-flow-arrow[data-arrow-state=lost]{stroke:var(--flow-lost);opacity:.8}
.devflow-flow-arrow[data-edge-semantic=requirement]{stroke:var(--flow-muted)}
.devflow-flow-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.devflow-flow-edge-label{fill:var(--flow-muted);font-size:10px;font-family:var(--ds-font-family-code,ui-monospace,monospace);pointer-events:none}
/* ===== 线的动效（第三步C）：动 = 正在发生，静止 = 已经结束 =====
   纯 SVG 属性 + CSS 动画：没有 requestAnimationFrame 循环、没有逐帧读布局。
   流动虚线的周期恒为 ${FLOW_DASH_PERIOD}px，位移速度 = 周期 / 时长，时长由
   motion.ts 的 motionProfile() 按状态算好、写在元素行内样式里，所以
   执行中 = 52px/s、返工 = 1.4×、排队 = 0.5×，方向恒为"起点 → 终点"。
   动效元素恒定存在（身份不随数据刷新重建），静止状态只是被隐藏。
   §一·前.1：亮头 12px ⇒ ${FLOW_DASH_HEAD}px（周期仍 ${FLOW_DASH_PERIOD}px，速度公式不变），
   描边加粗一档、不透明度 1.0，颜色取 --flow-glow（比语义色更亮的同色相高亮）。
   层次不丢：排队仍最弱（更细 + 半透明），已完成仍只掠一次，未收尾仍静止。 */
.devflow-flow-flow{fill:none;stroke:var(--flow-glow);stroke-width:${FLOW_FLOW_WIDTH};stroke-linecap:round;stroke-dasharray:${FLOW_DASH_HEAD} ${FLOW_DASH_TAIL};opacity:1;animation:devflow-flow-run 1.846s linear infinite;pointer-events:none}
g[data-flow-rate=still] .devflow-flow-flow,g[data-flow-rate=paused] .devflow-flow-flow{visibility:hidden;animation:none}
g[data-flow-rate=strong] .devflow-flow-flow{stroke:var(--flow-glow-rework);stroke-width:${FLOW_FLOW_WIDTH}}
g[data-flow-rate=weak] .devflow-flow-flow{stroke:var(--flow-glow-weak);stroke-width:${FLOW_FLOW_WIDTH_WEAK};opacity:${FLOW_FLOW_OPACITY_WEAK}}
/* 高亮 / 选中的线停下来：这时用户看的是"这一条是什么"，而不是"它在不在跑"。
   半透明只给高亮态，执行中/返工在正常阅读时保持 1.0。 */
g[data-highlight=true] .devflow-flow-flow,.devflow-flow-edge[data-selected=true]~.devflow-flow-flow{animation-play-state:paused;opacity:.35}
@keyframes devflow-flow-run{from{stroke-dashoffset:0}to{stroke-dashoffset:-${FLOW_DASH_PERIOD}}}
/* 刚刚完成：沿"起点 → 终点"扫一次（pathLength 归一化到 100，虚线 100 100 即"整条线"，
   偏移 100 → 0 就是从起点画到终点），${FLOW_SWEEP_SECONDS}s 内跑完并淡出，此后永久静止。 */
.devflow-flow-sweep{fill:none;stroke:var(--flow-done);stroke-width:2.8;stroke-linecap:round;stroke-dasharray:100 100;visibility:hidden;pointer-events:none}
g[data-fresh=true] .devflow-flow-sweep{visibility:visible;animation:devflow-flow-done ${FLOW_SWEEP_SECONDS}s ease-out 1 both}
@keyframes devflow-flow-done{0%{stroke-dashoffset:100;opacity:0}12%{opacity:.95}72%{opacity:.8}100%{stroke-dashoffset:0;opacity:0}}
/* 卡片的当场生成：data-enter=true 时播一次。
   入场只改透明度与极小缩放，**不改尺寸/位置/边框/语义色**——其它节点因此一动不动
   （不位移画布其它节点是本轮的硬约束）；一次性、≤FLOW_ENTER_MS，之后永久静止。
   data-enter 由纯函数判定"本次渲染里该 id 还没被见过"：首帧也入场（boss 2026-09-18
   裁决 A）⇒ 打开画布 / 刷新 / 切换会话 / 切换皮肤都会全量入场一次；同一批节点重复
   渲染不入场，空闲画布仍然不会自我驱动。 */
@keyframes devflow-flow-enter{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:scale(1)}}
.devflow-flow-card[data-enter=true]{animation:devflow-flow-enter ${FLOW_ENTER_SECONDS}s ease-out 1 both}
/* 真实变化才重新武装流动层：data-rearmed 只作取证标记，动画本身仍由 data-flow-rate
   决定（静止/暂停一律不动的铁律不受影响）。 */
g[data-rearmed=true] .devflow-flow-flow{will-change:stroke-dashoffset}
/* 阶段关联：R2 起**画布上不再画任何**阶段元素（无框、无名、无计数、无左侧栏）。
   这里只剩右侧栏列表里用到的一个状态点。 */
.devflow-flow-banddot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--flow-muted)}
.devflow-flow-banddot[data-status=in_progress]{background:var(--flow-run)}
.devflow-flow-banddot[data-status=completed]{background:var(--flow-done)}
/* 角色卡片：玻璃质感比其它容器明显一点（更厚的模糊 + 内侧高光），但不用发光/噪点/霓虹。
   box-sizing:border-box 必需：布局按 FLOW_NODE_WIDTH 预留宽度。 */
.devflow-flow-card{position:absolute;z-index:2;box-sizing:border-box;padding:9px 10px;border:1px solid var(--flow-line);border-radius:14px;background:var(--flow-card);background-image:linear-gradient(180deg,var(--flow-sheen),rgba(255,255,255,0) 46%);-webkit-backdrop-filter:blur(22px) saturate(165%);backdrop-filter:blur(22px) saturate(165%);box-shadow:var(--flow-shadow),inset 0 1px 0 var(--flow-inset);cursor:grab;touch-action:none}
.devflow-flow-card:active{cursor:grabbing}
.devflow-flow-card[data-kind=requirement]{border-color:var(--flow-line)}
.devflow-flow-card[data-kind=commander]{border-color:var(--flow-accent)}
.devflow-flow-card[data-kind=temporary]{border-style:dashed}
.devflow-flow-card[data-state=done]{border-color:var(--flow-done)}
.devflow-flow-card[data-state=rework]{border-color:var(--flow-bad)}
/* 收尾终态：中性点线边框，和"未收尾"的灰虚线区分开（收尾是结束，不是悬着）。 */
.devflow-flow-card[data-state=closed]{border-color:var(--flow-lost);border-style:dotted}
.devflow-flow-card[data-selected=true]{box-shadow:0 0 0 2px var(--flow-accent-soft),var(--flow-shadow)}
.devflow-flow-card[data-highlight=true]{box-shadow:0 0 0 2px var(--flow-warn),var(--flow-shadow)}
.devflow-flow-name{margin:0;font-size:13px;font-weight:600;color:var(--flow-ink)}
.devflow-flow-sub{margin:2px 0 0;color:var(--flow-muted);font-size:11px}
/* 卡片只放摘要：任务标题最多两行，超出省略（详情在右侧栏）。 */
.devflow-flow-task{display:-webkit-box;margin:6px 0 0;overflow:hidden;color:var(--flow-ink);font-size:12px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.devflow-flow-skill{margin:4px 0 0;color:var(--flow-muted);font-size:11px;overflow-wrap:anywhere}
.devflow-flow-badge{display:inline-block;margin-top:6px;padding:1px 7px;border:1px solid var(--flow-line);border-radius:999px;color:var(--flow-muted);font-size:11px}
.devflow-flow-badge.run{color:var(--flow-run);border-color:var(--flow-run)}
.devflow-flow-badge.done{color:var(--flow-done);border-color:var(--flow-done)}
.devflow-flow-badge.wait{color:var(--flow-warn);border-color:var(--flow-warn)}
.devflow-flow-badge.bad{color:var(--flow-bad);border-color:var(--flow-bad)}
.devflow-flow-badge.queue{color:var(--flow-muted);border-style:dashed}
.devflow-flow-badge.lost{color:var(--flow-lost);border-color:var(--flow-lost);border-style:dashed}
/* 已暂停（§一·前.2）：派发被暂停不是"未收尾"，所以实线 + 中性色，不借用失联的样式。 */
.devflow-flow-badge.paused{color:var(--flow-muted);border-color:var(--flow-muted);border-style:solid}
/* 已收尾（第四步）：终态，中性色点线；它既不是"失联"也不是"完成"。 */
.devflow-flow-badge.closed{color:var(--flow-lost);border-color:var(--flow-lost);border-style:dotted}
.devflow-flow-tag{display:inline-block;margin-left:5px;padding:0 5px;border:1px solid var(--flow-line);border-radius:999px;color:var(--flow-muted);font-size:10px}
.devflow-flow-tag.live{color:var(--flow-run);border-color:var(--flow-run)}
.devflow-flow-tag.plan{color:var(--flow-accent);border-color:var(--flow-accent)}
.devflow-flow-tag.subagent{color:var(--flow-accent);border-color:var(--flow-accent)}
.devflow-flow-tag.user{color:var(--flow-muted);border-color:var(--flow-line)}
/* ===== 卡片边框的动效（第三步C）：同样只有"正在发生"才动 =====
   执行中 = 一圈 4s 的绕行高光 + 4s 的明暗呼吸；返工 = 3.4s、更亮一点但绝不闪；
   排队 = 静态虚线且更弱；已完成 / 未收尾 / 待派发 = 完全静止。
   高光画在 ::after 上（1px 内环 + mask 挖空），卡片自己的 border-color 和
   box-shadow 一分不动 —— 所以选中环、指挥官金边、卡片高度都不受影响。
   @property 让 --flow-beam 成为可插值的角度；不支持 @property 的引擎只是
   高光不绕行（呼吸仍在），不会闪。mask-composite 不支持时整块降级不画。 */
@property --flow-beam{syntax:'<angle>';inherits:false;initial-value:0deg}
@supports ((-webkit-mask-composite:xor) or (mask-composite:exclude)){
  .devflow-flow-card::after{position:absolute;inset:0;padding:1px;border-radius:inherit;background:conic-gradient(from var(--flow-beam),transparent 0deg,var(--flow-beam-color,var(--flow-run)) 42deg,transparent 118deg);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;opacity:0;pointer-events:none;content:''}
  .devflow-flow-card[data-state=active]::after{--flow-beam-color:var(--flow-run);animation:devflow-flow-beam 4s linear infinite,devflow-flow-breathe 4s ease-in-out infinite}
  .devflow-flow-card[data-state=rework]::after{--flow-beam-color:var(--flow-bad);animation:devflow-flow-beam 3.4s linear infinite,devflow-flow-breathe-strong 3.4s ease-in-out infinite}
}
@keyframes devflow-flow-beam{from{--flow-beam:0deg}to{--flow-beam:360deg}}
@keyframes devflow-flow-breathe{0%,100%{opacity:.28}50%{opacity:.66}}
@keyframes devflow-flow-breathe-strong{0%,100%{opacity:.42}50%{opacity:.92}}
/* 已暂停（§一·前.2）：卡片明确写出"已暂停"，边框回到中性色，卡片动效完全停止
   （铁律"动＝正在发生"：暂停就不是正在发生）。恢复后状态与动效一起回来。 */
.devflow-flow-card[data-state=paused]{border-color:var(--flow-muted)}
.devflow-flow-card[data-state=paused]::after{animation:none;opacity:0}
.devflow-flow-card[data-state=planned]:not([data-kind=requirement]){border-style:dashed;border-color:var(--flow-line-soft)}
/* 浮层：全部 absolute 叠在画布上，文本变化不会推动画布盒子（防跳动）。 */
.devflow-flow-float{position:absolute;z-index:3;pointer-events:none;box-sizing:border-box}
.devflow-flow-info{left:10px;top:10px;display:flex;flex-direction:column;gap:4px;max-width:calc(100% - 60px)}
.devflow-flow-identrow{display:flex;align-items:flex-start;gap:6px}
.devflow-flow-ident{display:block;flex:1 1 auto;min-width:0;overflow-wrap:anywhere;padding:5px 9px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-chip);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:var(--flow-muted);font-size:11px;line-height:1.45}
.devflow-flow-ident[data-freshness=refreshing]{color:var(--flow-run);border-color:var(--flow-run)}
.devflow-flow-ident[data-freshness=error]{color:var(--flow-warn);border-color:var(--flow-warn)}
.devflow-flow-ident[data-connection=live]{border-color:var(--flow-line)}
.devflow-flow-ident[data-connection=polling]{border-color:var(--flow-warn)}
/* 皮肤切换：几何图形图标（非 emoji），位于身份行右侧；可 Tab 聚焦、有 aria-label。
   pointer-events:auto 必需 —— 它所在的 .devflow-flow-float 是"穿透"的，缺了这句点击会被穿透掉。 */
.devflow-flow-skin{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:var(--flow-accent);pointer-events:auto;cursor:pointer}
.devflow-flow-skin:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-skin:focus-visible{outline:2px solid var(--flow-accent);outline-offset:2px}
.devflow-flow-skinicon{display:block;width:12px;height:12px;border-radius:50%;background:currentColor}
.devflow-flow-skinicon[data-shape=moon]{background:transparent;box-shadow:inset -3.5px -2.5px 0 0 currentColor}
.devflow-flow-skinicon[data-shape=ring]{background:transparent;border:2px solid currentColor}
/* 重新打开概览浮层：几何图标（外框 + 右上角小方点），与皮肤按钮同尺寸同交互。 */
.devflow-flow-overviewicon{position:relative;display:block;width:12px;height:9px;border:1.6px solid currentColor;border-radius:2px}
.devflow-flow-overviewicon::after{position:absolute;right:-3px;top:-4px;width:5px;height:4px;border:1.4px solid currentColor;border-radius:1px;background:var(--flow-chip);content:''}
.devflow-flow-channel{display:block;padding:4px 9px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-chip);color:var(--flow-muted);font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.devflow-flow-channel[data-connection=polling]{border-color:var(--flow-warn);color:var(--flow-warn)}
.devflow-flow-zoomchip{display:inline-block;align-self:flex-start;padding:3px 8px;border:1px solid var(--flow-line-soft);border-radius:999px;background:var(--flow-chip);color:var(--flow-muted);font-size:11px}
/* 底部一个纵向栈：提示行 → 图例 → （花名册 + 工具条）。三者同处一个 flex 列，
   高度随内容增长，彼此永远不可能像上一轮那样互相压住（实测曾横向重叠 80–171px）。 */
.devflow-flow-bottomstack{left:10px;right:10px;bottom:10px;z-index:8;display:flex;flex-direction:column;gap:5px;align-items:stretch;padding:7px 9px;border:1px solid var(--flow-line-soft);border-radius:14px;background:var(--flow-panel);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%)}
.devflow-flow-bottom{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.devflow-flow-bottomrow{display:flex;align-items:flex-end;justify-content:flex-start;gap:10px}
.devflow-flow-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:100%;margin-left:auto;pointer-events:auto}
.devflow-flow-action{padding:5px 9px;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);color:var(--flow-ink);font-size:12px;line-height:1.2}
.devflow-flow-action:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-action[data-primary=true]{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-action[aria-pressed=true]{border-color:var(--flow-accent);background:var(--flow-accent-soft);color:var(--flow-accent-ink)}
html[data-devflow-skin=light] .devflow-flow-action[aria-pressed=true]{color:var(--flow-accent-ink)}
.devflow-flow-viewswitch{display:inline-flex;gap:5px;padding-left:5px;border-left:1px solid var(--flow-line-soft)}
/* 并发上限 N/5（boss 要求必须展现）。放在名册同一区、同一行，和名册一起收缩：
   它是运行事实，不是工具按钮，所以用 chip 样式而非 action 样式。到顶时换成 warn 色
   并追加「已达并发上限 · 后续排队」——上限被看见，排队才不是「悄悄拖时间」。 */
.devflow-flow-concurrency{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:5px 9px;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);color:var(--flow-ink);font-size:12px;line-height:1.2;pointer-events:auto}
.devflow-flow-concurrency b{font-weight:600}
.devflow-flow-concurrency[data-at-limit=true]{border-color:var(--flow-warn);color:var(--flow-warn)}
.devflow-flow-concurrencynote{color:var(--flow-warn);font-size:11px}
.devflow-flow-roster{flex:0 1 auto;width:min(240px,42vw);pointer-events:auto}
.devflow-flow-rosterhead{display:flex;align-items:center;gap:6px;width:100%;padding:5px 9px;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);color:var(--flow-ink);text-align:left}
.devflow-flow-rosterkicker{position:absolute;width:1px;height:1px;overflow:hidden;white-space:nowrap}
.devflow-flow-rosterhead strong{flex:1;font-size:12px;font-weight:500}
.devflow-flow-rosterhint{color:var(--flow-muted);font-size:11px}
.devflow-flow-roster[data-open=true] .devflow-flow-rosterhead{border-color:var(--flow-accent);border-bottom-left-radius:0;border-bottom-right-radius:0}
.devflow-flow-rosterbody{max-height:min(320px,46vh);overflow:auto;padding:7px 8px;border:1px solid var(--flow-line);border-top:0;border-radius:0 0 10px 10px;background:var(--flow-panel)}
.devflow-flow-pcard{margin-bottom:6px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-surface-solid);padding:7px 9px}
.devflow-flow-rostergroup{margin:8px 0 6px;padding-top:7px;border-top:1px dashed var(--flow-line)}
.devflow-flow-rostergroup>strong{display:block;margin-bottom:4px;color:var(--flow-muted);font-size:11px;font-weight:500}
.devflow-flow-rostergroup>small{display:block;color:var(--flow-muted);font-size:11px}
.devflow-flow-pcard:last-child{margin-bottom:0}
.devflow-flow-pcard[data-plan=true]{border-style:dashed;border-color:var(--flow-warn)}
.devflow-flow-pcardbutton{display:flex;align-items:center;gap:5px;width:100%;padding:0;border:0;background:transparent;text-align:left}
.devflow-flow-pcardbutton strong{flex:1;color:var(--flow-ink);font-size:12px;font-weight:500}
.devflow-flow-pcard>small{display:block;color:var(--flow-muted);font-size:11px}
.devflow-flow-pdet{margin-top:6px;padding-top:6px;border-top:1px solid var(--flow-line-soft);color:var(--flow-muted);font-size:11px}
.devflow-flow-pdet p{margin:0 0 3px;overflow-wrap:anywhere}
.devflow-flow-hint{flex:1 1 auto;min-width:0;color:var(--flow-muted);font-size:11px}
/* 提示压成一行，减少纵向占用，保证画布高度占比。 */
.devflow-flow-notices{display:block;min-width:0;color:var(--flow-warn);font-size:11px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.devflow-flow-notices span{margin-right:12px}
.devflow-flow-legend{display:flex;align-items:center;flex-wrap:wrap;gap:9px;color:var(--flow-muted);font-size:11px;pointer-events:auto}
.devflow-flow-legendgroup{display:inline-flex;align-items:center;gap:8px;padding-right:8px;border-right:1px solid var(--flow-line-soft)}
.devflow-flow-legendgroup:last-of-type{border-right:0}
.devflow-flow-legend span{display:inline-flex;align-items:center;gap:4px}
/* 关系样例：线型 + 箭头方向（颜色跟随状态语义，不由皮肤决定）。 */
.devflow-flow-line{position:relative;display:inline-block;width:22px;height:0;border-top:1.6px solid var(--flow-link)}
.devflow-flow-line::after{position:absolute;right:-1px;top:-3.4px;width:0;height:0;border-top:3px solid transparent;border-bottom:3px solid transparent;border-left:5px solid currentColor;color:var(--flow-link);content:''}
.devflow-flow-line.is-requirement{border-top-style:dotted;border-top-color:var(--flow-muted);color:var(--flow-muted)}
.devflow-flow-line.is-dispatch{border-top-style:solid}
.devflow-flow-line.is-delivery{border-top-style:dashed;border-top-color:var(--flow-done);color:var(--flow-done)}
.devflow-flow-line.is-delivery::after{right:auto;left:-1px;border-left:0;border-right:5px solid currentColor}
.devflow-flow-line.is-rework{border-top-style:dashed;border-top-color:var(--flow-bad);color:var(--flow-bad)}
.devflow-flow-line.is-subagent{border-top-style:dotted}
.devflow-flow-line.is-subagent::after{right:auto;left:-4px;border-left:0;border-right:5px solid currentColor}
/* 状态样例：只表达颜色。 */
.devflow-flow-swatch{display:inline-block;width:16px;height:0;border-top:1.8px solid var(--flow-link)}
.devflow-flow-swatch.is-queued{border-top-color:var(--flow-link)}
.devflow-flow-swatch.is-executing{border-top-color:var(--flow-run)}
.devflow-flow-swatch.is-done{border-top-color:var(--flow-done)}
.devflow-flow-swatch.is-rework{border-top-color:var(--flow-bad)}
.devflow-flow-swatch.is-lost{border-top-color:var(--flow-lost)}
.devflow-flow-legendtoggle{padding:2px 7px;border:1px solid var(--flow-line);border-radius:999px;background:var(--flow-chip);color:var(--flow-ink);font-size:10px;line-height:1.4}
.devflow-flow-legendtoggle:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-legendpanel{right:10px;top:56px;width:min(360px,calc(100% - 20px));max-height:calc(100% - 150px);overflow:auto;overscroll-behavior:contain;pointer-events:auto;padding:11px 12px;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-panel);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);box-shadow:var(--flow-shadow);color:var(--flow-muted);font-size:11px;line-height:1.5}
.devflow-flow-legendpanel h3{margin:8px 0 4px;color:var(--flow-accent);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.devflow-flow-legendpanel h3:first-child{margin-top:0}
.devflow-flow-legendpanel ul{margin:0;padding:0;list-style:none}
.devflow-flow-legendpanel li{display:flex;align-items:center;gap:7px;padding:3px 0}
.devflow-flow-legendnote{margin:9px 0 0;padding:7px 8px;border-left:2px solid var(--flow-accent);background:var(--flow-accent-soft);color:var(--flow-muted);font-size:11px}
.devflow-flow-note{left:10px;right:10px;top:64px;pointer-events:auto;margin:0;padding:7px 9px;border:1px solid var(--flow-warn);border-radius:10px;background:var(--flow-panel);color:var(--flow-warn);font-size:11px;line-height:1.45}
/* 交接详情与节点详情共用右侧栏；这里只保留旧的浮层类名以兼容既有用例。 */
.devflow-flow-xfer{right:10px;top:56px;width:min(340px,calc(100% - 20px));max-height:calc(100% - 150px);overflow:auto;overscroll-behavior:contain;pointer-events:auto;padding:11px 12px;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-panel);box-shadow:var(--flow-shadow)}
.devflow-flow-xfer>header h3{margin:2px 0 0;font-size:14px;color:var(--flow-ink)}
.devflow-flow-table{margin:8px 0 0}
.devflow-flow-table>div{padding:7px 0;border-bottom:1px solid var(--flow-line-soft)}
.devflow-flow-table dt{color:var(--flow-muted);font:10px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}
.devflow-flow-table dd{margin:3px 0 0;overflow-wrap:anywhere;color:var(--flow-ink);font-size:12px;line-height:1.45}
.devflow-flow-xferdetail{margin:9px 0 0;padding:8px 9px;border-left:2px solid var(--flow-accent);background:var(--flow-accent-soft);color:var(--flow-muted);font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.devflow-flow-xferclose{margin-top:9px;padding:4px 9px;border:1px solid var(--flow-line);border-radius:10px;background:transparent;color:var(--flow-ink);font-size:11px}
.devflow-flow-xferclose:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
/* 审计 / 本会话：既有能力的次要入口（工具栏右侧两个按钮），不再占 Tab 栏。 */
/* 状态条抬到底部三条浮层之上：它是会话级提示，可能随时出现，绝不能盖住工具条。 */
.devflow-flow .devflow-refresh-notice,.devflow-flow .devflow-selection-notice,.devflow-flow .devflow-error-notice{position:absolute;left:10px;right:10px;bottom:118px;z-index:9;margin:0;padding:6px 9px;border-radius:10px;background:var(--flow-panel);font-size:11px;line-height:1.4}
.devflow-flow .devflow-refresh-notice{border:1px solid var(--flow-run)}
.devflow-flow .devflow-selection-notice{border:1px solid var(--flow-run)}
.devflow-flow .devflow-error-notice{border:1px solid var(--flow-bad)}
/* 受阻横幅：员工如实上报「做不了」时的可见终态。用警示色 + 一眼可分的中文，
   且**不带任何按钮** —— 它要的是修配置，不是一个可以点的选择。 */
.devflow-flow .devflow-blocked-banner{position:absolute;left:10px;right:10px;top:10px;z-index:11;display:flex;flex-direction:column;gap:4px;margin:0;padding:7px 10px;border:1px solid var(--flow-bad);border-radius:10px;background:var(--flow-panel);font-size:11px;line-height:1.45}
.devflow-flow .devflow-blocked-head{color:var(--flow-bad);font-weight:600}
.devflow-flow .devflow-blocked-row{display:block}
.devflow-flow .devflow-blocked-why{display:block;color:var(--flow-muted);padding-left:10px}
.devflow-flow-panel{display:flex;flex:1 1 auto;flex-direction:column;gap:0;min-height:0;overflow:hidden}
.devflow-flow-secondary{height:100%}
.devflow-flow-secondaryhead{display:flex;align-items:center;gap:10px;flex:0 0 auto;padding:0 0 8px}
.devflow-flow-secondaryhead button{padding:5px 10px;border:1px solid var(--flow-line);border-radius:10px;background:transparent;color:var(--flow-accent);font-size:12px}
.devflow-flow-secondaryhead strong{font-size:13px;color:var(--flow-ink)}
.devflow-flow-secondarybody{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 12px;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-panel)}
.devflow-flow .devflow-inspector{padding:0;max-height:none;border:0;background:transparent}
.devflow-flow .devflow-inspector>header{padding-bottom:10px}
.devflow-flow .devflow-inspector h2{font-size:15px}
.devflow-flow .devflow-tools,.devflow-flow .devflow-audit{padding:2px 0 0}
/* 右侧详情栏：节点详情 / 交接详情 / 阶段关联共用同一栏位，一次只显示一种。
   宽档停靠（挤压画布，画布自动重新适配），窄档改为覆盖式抽屉（不挤压画布）。 */
.devflow-flow-inspector{display:flex;flex:0 0 300px;flex-direction:column;gap:0;box-sizing:border-box;width:300px;margin-left:8px;padding:11px 12px;border:1px solid var(--flow-line);border-radius:14px;background:var(--flow-panel);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);box-shadow:var(--flow-shadow);overflow:auto;overscroll-behavior:contain;color:var(--flow-muted);font-size:12px}
.devflow-flow-inspector[data-mode=drawer]{position:absolute;right:0;top:0;bottom:108px;z-index:12;width:min(320px,calc(100% - 24px));margin-left:0}
.devflow-flow-inspectorhead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--flow-line-soft)}
.devflow-flow-inspectorhead h3{margin:2px 0 0;color:var(--flow-ink);font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.devflow-flow-inspectorclose{flex:0 0 auto;padding:3px 8px;border:1px solid var(--flow-line);border-radius:10px;background:transparent;color:var(--flow-ink);font-size:12px;line-height:1.2}
.devflow-flow-inspectorclose:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-inspectorsection{margin:12px 0 5px;color:var(--flow-accent);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.devflow-flow-inspectortask{margin:0 0 6px;color:var(--flow-ink);font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.devflow-flow-mutedline{margin:0 0 6px;color:var(--flow-muted);font-size:11px;line-height:1.45}
.devflow-flow-inspectorlist{margin:0;padding:0;list-style:none}
.devflow-flow-inspectorlist li+li{margin-top:4px}
.devflow-flow-inspectorlist button{display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-accent-soft);color:var(--flow-ink);text-align:left}
.devflow-flow-inspectorlist button:hover{border-color:var(--flow-accent)}
.devflow-flow-inspectorlist button[data-highlight=true]{border-color:var(--flow-warn);background:var(--flow-accent-soft)}
.devflow-flow-inspectorlinetitle{flex:1 1 auto;min-width:0;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.devflow-flow-inspectorlist small{flex:0 0 auto;color:var(--flow-muted);font:10px var(--ds-font-family-code,ui-monospace,monospace)}
/* ===== 右上角概览浮层（第三步B，shell.overlay 停靠单元） =====
   这是 frame 级浮层里的一个单元，不在画布子树里（所以画布的 .devflow-flow 变量
   在这里读不到，颜色直接用语义变量 + 与皮肤一致的常量兜底）。
   §11.2：浮层默认静止，只用颜色区分状态；唯一的动效是"进行中"状态点的极弱呼吸，
   不叠加玻璃 × 动效的重采样代价。 */
.devflow-ov{position:absolute;top:10px;right:var(--devflow-ov-offset,80px);z-index:4;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(400px,calc(100vw - var(--devflow-ov-offset,80px) - 8px));font-size:12px;line-height:1.45;color:var(--dsw-alias-text-primary,#e8eef4)}
.devflow-ov-pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:999px;background:var(--dsw-alias-bg-elevated,rgba(16,18,23,.92));box-shadow:0 2px 8px rgba(0,0,0,.28);color:inherit;font-size:12px;line-height:1.3;cursor:pointer}
.devflow-ov-pill:hover{border-color:var(--dsw-alias-border-l2,#93a4b4)}
.devflow-ov-pill:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:2px}
.devflow-ov-pilltext{font-variant-numeric:tabular-nums}
.devflow-ov-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#6b7d8f}
.devflow-ov-dot[data-posture=active],.devflow-ov-dot[data-state=run]{background:var(--dsw-alias-text-accent,#54b8d3)}
.devflow-ov-dot[data-posture=review],.devflow-ov-dot[data-state=wait]{background:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-dot[data-posture=done],.devflow-ov-dot[data-state=done]{background:var(--dsw-alias-text-success,#6fcf97)}
.devflow-ov-dot[data-state=bad],.devflow-ov-dot[data-state=paused]{background:#ee817e}
.devflow-ov-dot[data-state=queue]{background:#93a4b4}
.devflow-ov-dot[data-state=lost]{background:#6b7d8f}
.devflow-ov-dot[data-state=closed]{background:#55636f}
.devflow-ov-dot[data-state=idle]{background:#6b7d8f}
.devflow-ov-dot[data-state=commander]{background:#d8b45a}
/* §11.2 允许的唯一动效：仅"进行中/返工"的浮标状态点做极弱呼吸（不涉及玻璃重采样）。 */
.devflow-ov[data-posture=active][data-paused=false] .devflow-ov-pill .devflow-ov-dot{animation:devflow-ov-pulse 3.2s ease-in-out infinite}
@keyframes devflow-ov-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.devflow-ov-pillconn{padding:1px 7px;border:1px solid currentColor;border-radius:999px;font-size:11px;opacity:.85}
.devflow-ov-pillconn[data-connection=polling]{color:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-pillconn[data-connection=connecting]{color:#93a4b4}
.devflow-ov-card{width:min(384px,calc(100vw - var(--devflow-ov-offset,80px) - 8px));max-height:min(64vh,560px);overflow:auto;overscroll-behavior:contain;padding:11px 12px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:14px;background:var(--dsw-alias-bg-elevated,rgba(16,18,23,.92));box-shadow:0 8px 22px rgba(0,0,0,.4)}
.devflow-ov-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-kicker{margin:0;color:var(--dsw-alias-text-accent,#d8b45a);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.devflow-ov-title{margin:2px 0 0;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.devflow-ov-headactions{display:flex;flex:0 0 auto;gap:5px}
.devflow-ov-icon{width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:8px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}
.devflow-ov-icon:hover{border-color:var(--dsw-alias-text-accent,#d8b45a)}
.devflow-ov-icon:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:2px}
.devflow-ov-meta{display:flex;flex-wrap:wrap;gap:5px;margin:9px 0 0}
.devflow-ov-chip{padding:1px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:999px;font-size:11px;color:var(--dsw-alias-text-secondary,#93a4b4)}
.devflow-ov-chip[data-state=bound]{color:var(--dsw-alias-text-success,#6fcf97);border-color:currentColor}
.devflow-ov-chip[data-state=unbound]{color:var(--dsw-alias-text-warning,#f1b86b);border-color:currentColor}
.devflow-ov-chip[data-state=paused]{color:#ee817e;border-color:currentColor}
.devflow-ov-chip[data-state=live]{color:var(--dsw-alias-text-success,#6fcf97);border-color:currentColor}
.devflow-ov-chip[data-state=poll]{color:var(--dsw-alias-text-warning,#f1b86b);border-color:currentColor}
.devflow-ov-segments{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:11px 0 0}
.devflow-ov-segment{display:flex;flex-direction:column;gap:4px;min-width:0}
.devflow-ov-segbar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-segment[data-tone=run] .devflow-ov-segbar{background:var(--dsw-alias-text-accent,#54b8d3)}
.devflow-ov-segment[data-tone=wait] .devflow-ov-segbar{background:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-segment[data-tone=done] .devflow-ov-segbar{background:var(--dsw-alias-text-success,#6fcf97)}
.devflow-ov-segment[data-tone=lost] .devflow-ov-segbar{background:#6b7d8f}
/* 收尾终态：比"未收尾"更沉的点线色，一眼能分开"收尾了"和"还悬着"。 */
.devflow-ov-segment[data-tone=closed] .devflow-ov-segbar{background:#55636f;opacity:.75}
.devflow-ov-seglabel{color:var(--dsw-alias-text-secondary,#93a4b4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.devflow-ov-segnum{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.devflow-ov-commander{display:flex;align-items:center;gap:7px;margin:11px 0 0;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-state{color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-members{margin:6px 0 0;padding:0;list-style:none}
.devflow-ov-members li+li{margin-top:3px}
.devflow-ov-member{display:grid;grid-template-columns:auto auto auto 1fr;align-items:center;gap:7px;width:100%;padding:5px 7px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.devflow-ov-member:hover{border-color:var(--dsw-alias-border-l3,rgba(177,201,219,.3))}
.devflow-ov-member:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:1px}
.devflow-ov-membername{font-size:12px;font-weight:500}
.devflow-ov-membertag{margin-left:6px;padding:0 5px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:7px;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:10px;font-weight:400;white-space:nowrap}
.devflow-ov-memberstate{color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px;white-space:nowrap}
.devflow-ov-memberstate[data-state=active]{color:var(--dsw-alias-text-accent,#54b8d3)}
.devflow-ov-memberstate[data-state=rework]{color:#ee817e}
.devflow-ov-memberstate[data-state=paused]{color:#ee817e}
.devflow-ov-memberstate[data-state=blocked]{color:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-memberstate[data-state=done]{color:var(--dsw-alias-text-success,#6fcf97)}
.devflow-ov-membertask{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-tally{margin:9px 0 0;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-muted{margin:6px 0 0;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-notice{margin:7px 0 0;padding:5px 8px;border:1px solid var(--dsw-alias-text-warning,#f1b86b);border-radius:9px;color:var(--dsw-alias-text-warning,#f1b86b);font-size:11px}
.devflow-ov-foot{display:flex;justify-content:flex-end;margin:10px 0 0;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-open{padding:5px 11px;border:1px solid var(--dsw-alias-text-accent,#d8b45a);border-radius:9px;background:transparent;color:var(--dsw-alias-text-accent,#d8b45a);font-size:12px;cursor:pointer}
.devflow-ov-open:hover{background:rgba(216,180,90,.14)}
.devflow-ov-open:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:2px}
@media (max-width:1040px){
  .devflow-ov{max-width:min(320px,calc(100vw - var(--devflow-ov-offset,80px) - 8px))}
  .devflow-ov-card{max-height:56vh}
}
/* 减少动效：浮层本来就只有"进行中"状态点一个极弱动效，这里也一并关掉。 */
@media (prefers-reduced-motion:reduce){
  .devflow-ov *{animation:none!important}
}
/* ===== 降级：不支持背景模糊、或用户要求减少透明时，一律退回实色。 ===== */
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){
  .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-card{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-inspector,.devflow-flow-bottomstack,.devflow-flow-legendpanel,.devflow-flow-ident,.devflow-flow-skin{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
}
@media (prefers-reduced-transparency:reduce){
  .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-card{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-inspector,.devflow-flow-bottomstack,.devflow-flow-legendpanel,.devflow-flow-ident,.devflow-flow-skin{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
}
@media (max-width:560px){
  .devflow-flow-info{max-width:calc(100% - 20px)}
  .devflow-flow-bottomrow{flex-wrap:wrap}
  .devflow-flow-toolbar{max-width:100%}
  /* The keyboard hint is the least load-bearing overlay: drop it in the narrow
     column so the toolbar keeps one row and the canvas keeps its height. */
  .devflow-flow-hint{display:none}
  .devflow-flow-xfer{top:auto;bottom:150px;max-height:40%}
  /* 窄栏：图例压小；详情栏走覆盖式抽屉，并让出底部栈高度。 */
  .devflow-flow-legend{gap:6px;font-size:10px}
  .devflow-flow-legendpanel{top:96px;max-height:46%}
  .devflow-flow-inspector[data-mode=drawer]{width:calc(100% - 16px);bottom:186px}
}
/* 减少动效：所有动画一律关掉，且动效层直接不出现（静态信息一分不少）。 */
@media (prefers-reduced-motion:reduce){
  .devflow-flow-edge,.devflow-flow-card,.devflow-flow-card::after{animation:none!important}
  .devflow-flow-flow,.devflow-flow-sweep{animation:none!important;visibility:hidden!important}
}
/* ===== §11.1 玻璃 × 动效的降级路径（性能兜底） =====
   实测（第三步C）：软件光栅器下"backdrop-filter 玻璃 + 正在动的画布"只有约 6fps，
   代价来自玻璃逐帧重采样正在动的背景；关掉动画或关掉玻璃任一即回到 60fps。
   策略：**动画运行期间**（画布上有真正在跑的流动层，或刚刚做过布局/滚动/缩放）把
   叠加在动背景上的玻璃层降级为实色，回到 B 轮已有的实色退化路径；动画停下来的
   1.2s 后自动恢复原先已验收的玻璃观感。降级只切换"背景 + 模糊"，不改动任何布局、
   语义色、动效本身（绝不用"关动效"换性能）。
   由 motion-budget.ts 在画布根节点上写 data-glass-budget=degrade|auto 与
   data-motion=idle|active|degraded。 */
.devflow-flow[data-glass-budget=degrade] .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
.devflow-flow[data-glass-budget=degrade] .devflow-flow-card{background:var(--flow-surface-solid);background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.devflow-flow[data-glass-budget=degrade] .devflow-flow-inspector,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-bottomstack,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-legendpanel,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-ident,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-skin{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
`
