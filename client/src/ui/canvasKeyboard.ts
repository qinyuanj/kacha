// 画板的键盘快捷键：应用内剪贴板，以及 Ctrl / ⌘ + Z / Shift+Z / Y 的撤销重做与 Ctrl / ⌘+C 复制。
// 粘贴不在 keydown 里做——在键盘事件里拦默认行为会把 paste 事件一起压掉（见 canvasPaste）；
// 判定只在这里（判据来自事件与上下文），监听与执行见 useBoardKeyboard。
import { PASTE_OFFSET, type Clip } from "../core/iterate";

/** 复制粘贴的剪贴板：应用内共享，可粘到另一个画板（只带节点之间的连线，不跨画板连线）。 */
let clipboard: Clip | null = null;

/** 当前剪贴板；null = 还没复制过东西。 */
export function readClipboard(): Clip | null {
  return clipboard;
}

/** 覆盖剪贴板（null = 清空）。 */
export function writeClipboard(clip: Clip | null): void {
  clipboard = clip;
}

/** 连续粘贴逐次错开：整份快照按 PASTE_OFFSET 再偏一格。 */
export function nextPasteClip(clip: Clip): Clip {
  return { ...clip, nodes: clip.nodes.map((n) => ({ ...n, pos: [n.pos[0] + PASTE_OFFSET, n.pos[1] + PASTE_OFFSET] as [number, number] })) };
}

/** 键盘事件的形状：判定只读这些字段；preventDefault 由判定按原时机调用（KeyboardEvent 原样传进来即可）。 */
interface ShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
}

/** 判定用的上下文：焦点在不在输入区、画布还挂在文档上、弹窗开着、选区大小。 */
interface ShortcutContext {
  editable: boolean;
  connected: boolean;
  dialogOpen: boolean;
  selectedCount: number;
}

/** 一条快捷键命令；null = 这个按键不归画板管。 */
export type ShortcutCommand = { kind: "undo" } | { kind: "redo" } | { kind: "copy" };

/** 画板快捷键一律要 Ctrl / ⌘ 且不带 Alt。 */
function modifierOnly(e: ShortcutInput): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey;
}

/**
 * 撤销 / 重做：Ctrl / ⌘+Z 撤销、+Shift+Z 与 +Y 重做。
 * +Shift+Y 两个都不是（原判定如此），交给 shortcutCommand 的 Shift 前置挡掉，不吞默认行为。
 */
function historyCommandOf(key: string, shiftKey: boolean): { kind: "undo" } | { kind: "redo" } | null {
  if (key === "z") return shiftKey ? { kind: "redo" } : { kind: "undo" };
  if (key === "y" && !shiftKey) return { kind: "redo" };
  return null;
}

/**
 * 复制：Ctrl / ⌘+C 且选区非空。
 * 这里不 preventDefault——只有真的复制到了节点才拦，由执行方拿到 clip 后决定（见 useBoardKeyboard）：
 * 空选区时浏览器的原生复制照旧，用户复制画布上的文字不受影响。
 */
function copyCommandOf(e: ShortcutInput, ctx: ShortcutContext): ShortcutCommand | null {
  return e.key.toLowerCase() === "c" && ctx.selectedCount > 0 ? { kind: "copy" } : null;
}

/**
 * 画板快捷键判定（顺序与 preventDefault 时机照旧）：
 * - 必须带 Ctrl / ⌘、不带 Alt，焦点不在输入区，画布还挂在文档上（换掉画板的那一刻不响应）；
 * - 撤销 / 重做一律吞掉原生撤销，弹窗开着也吞（只是不作用于背后的画板）；
 * - 之后带 Shift 的组合与弹窗开着的按键都不再处理；
 * - 复制见 copyCommandOf；Ctrl / ⌘+V 完全不归这里管（粘贴由页面级 paste 接管）。
 */
export function shortcutCommand(e: ShortcutInput, ctx: ShortcutContext): ShortcutCommand | null {
  if (!modifierOnly(e) || ctx.editable || !ctx.connected) return null;
  const history = historyCommandOf(e.key.toLowerCase(), e.shiftKey);
  if (history) {
    e.preventDefault();
    return ctx.dialogOpen ? null : history;
  }
  if (e.shiftKey || ctx.dialogOpen) return null;
  return copyCommandOf(e, ctx);
}
