// 画布的键位与指针判定（纯逻辑，不碰 React）：方向键微移、视图缩放、Ctrl+J 原地复制、Esc 清选区、
// 触控板双指平移、Shift + 框选加选。useCanvasInteraction 只把这些判定接到监听器与 React Flow 上。
import { isTrackpadPan, nudgeDelta, type WheelLike } from "../core/selection";

/** 一次 keydown 里判定用到的字段（KeyboardEvent 结构上满足，测试可以直接造字面量）。 */
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/** 键位判定需要的画板状态：当前选中的节点，以及是否正在拖连线。 */
export interface KeyContext {
  selected: readonly string[];
  connectionInProgress: boolean;
}

/** 一条画布键位命令；null = 不处理（既不改画板也不 preventDefault）。 */
export type CanvasKeyCommand =
  | { kind: "nudge"; ids: string[]; delta: [number, number] }
  | { kind: "fitView" }
  | { kind: "actualSize" }
  | { kind: "zoomIn" }
  | { kind: "zoomOut" }
  | { kind: "duplicate" }
  | { kind: "clearSelection" }
  | null;

/** Ctrl / Cmd 且无 Alt / Shift 时的键：0 适应画布、1 实际大小、= / + 放大、- 缩小、J 原地复制。 */
const MOD_KEYS: Record<string, CanvasKeyCommand> = {
  "0": { kind: "fitView" },
  "1": { kind: "actualSize" },
  "=": { kind: "zoomIn" },
  "+": { kind: "zoomIn" },
  "-": { kind: "zoomOut" },
  j: { kind: "duplicate" },
};

/** 方向键微移：Shift 10px、否则 1px；按住 Ctrl / Cmd / Alt 时不微移，没有选中节点也不微移。 */
function arrowNudge(e: KeyInput, ctx: KeyContext, mod: boolean): CanvasKeyCommand {
  const delta = mod || e.altKey ? null : nudgeDelta(e.key, e.shiftKey);
  if (!delta || !ctx.selected.length) return null;
  return { kind: "nudge", ids: [...ctx.selected], delta };
}

/** Ctrl / Cmd 键位：查表，表里没有的键不处理（交回浏览器）。 */
function modKeyCommand(key: string): CanvasKeyCommand {
  return MOD_KEYS[key.toLowerCase()] ?? null;
}

/** Esc 清选区；连线拖动中不清（Esc 是取消这次连线）。 */
function escapeClears(e: KeyInput, ctx: KeyContext): CanvasKeyCommand {
  return e.key === "Escape" && !ctx.connectionInProgress ? { kind: "clearSelection" } : null;
}

/**
 * 一次 keydown 该做什么。判定顺序与拆分前逐条一致：
 * 1. Shift + 方向键微移（Shift 10px、否则 1px），按住 Ctrl / Cmd / Alt 不微移；
 * 2. defaultPrevented 之后一律不处理；
 * 3. Ctrl / Cmd 无 Alt / Shift：0 / 1 / = / + / - / J；
 * 4. 其余 Ctrl / Cmd / Alt 组合不处理；
 * 5. Esc 且没有连线在拖：清选区。
 * 可编辑焦点、弹窗开着、wrapper 已卸载这三道前置由调用方（useCanvasInteraction）先判，不在本函数内。
 */
export function canvasKeyCommand(e: KeyInput, ctx: KeyContext): CanvasKeyCommand {
  const mod = e.ctrlKey || e.metaKey;
  // 方向键微移先于 defaultPrevented 判断：页面级接管（shell/pageInput）已经把方向键吞掉，
  // 在这里早退会让「选中时微移」跟着失效。
  const nudge = arrowNudge(e, ctx, mod);
  if (nudge) return nudge;
  // 上下文菜单开着时它在捕获阶段吞掉 Esc（只关菜单），这里收不到。
  if (e.defaultPrevented) return null;
  if (mod && !e.altKey && !e.shiftKey) return modKeyCommand(e.key);
  if (mod || e.altKey) return null;
  return escapeClears(e, ctx);
}

/**
 * 滚轮事件是否当作触控板双指平移：`isTrackpadPan` 判设备特征，落在 .nowheel 区域（任务参数、
 * 提示词文本等自己处理滚轮的控件）里时让给它们。
 */
export function wheelPansCanvas(e: WheelLike, inNoWheel: boolean): boolean {
  return isTrackpadPan(e) && !inNoWheel;
}

/**
 * 按下时是否保留原选区：Shift + 在画布空白上按下 = Shift 框选加选。
 * React Flow 框选开始时会先清空选区，调用方据此记下原选区并忽略对它的取消选中。
 */
export function pointerKeepsSelection(shiftKey: boolean, onPane: boolean): boolean {
  return shiftKey && onPane;
}
