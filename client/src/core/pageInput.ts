// 页面输入接管（#97）的默认行为判定：这里只有纯逻辑——输入是事件形状，输出是拦或放行；
// 监听本身只有一处挂载点，见 shell/pageInput。被拦清单与例外都在本文件里可枚举。

/** 页面级吞掉的 Ctrl / Cmd + 字母：保存网页、打印、页内查找、打开文件。 */
export const BLOCKED_MOD_KEYS: readonly string[] = ["s", "p", "f", "o"];

const ARROW_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/** 键盘事件的形状：KeyboardEvent 里用得上的字段，加上焦点是否在输入区。 */
export interface KeyShape {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** 焦点在输入框 / 文本域 / 内容可编辑里：方向键与编辑快捷键的原生行为留给它们。 */
  editable: boolean;
}

/**
 * 键盘是否吞掉浏览器默认行为：
 * - Alt + ← / →：吞，避免后退 / 前进丢掉当前画板；
 * - Ctrl / Cmd + S / P / F / O：一律吞，不看焦点（这些组合在文本编辑里没有原生意义）；
 * - 方向键：非输入区一律吞，页面不滚动、与「选中时微移」共存；输入区放行（移动光标）；
 * - 其余放行：Ctrl+G / U、编辑类组合，以及浏览器自己处理的 Ctrl+W / T / N（见 README 已知限制）。
 */
export function blocksKey(e: KeyShape): boolean {
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  const letter = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) return BLOCKED_MOD_KEYS.includes(letter);
  return !e.editable && ARROW_KEYS.includes(e.key);
}

/**
 * 拖放：只要拖拽里带着文件就拦——浏览器会直接打开那个文件、把应用顶掉（本票唯一现存缺陷级条目）。
 * 纯文本 / 链接的拖拽放行，输入框里拖字照旧。画布上的落图由 BoardCanvas 在捕获阶段先行处理。
 * transfer 为 null 是合成事件的情形，当作不带文件。
 */
export function blocksFileDrag(transfer: { types: readonly string[] } | null): boolean {
  return !!transfer?.types.includes("Files");
}

/** 鼠标事件的形状：按下还是松开，加键位。 */
export type MousePhase = "down" | "up";

/**
 * 鼠标是否吞掉默认行为：
 * - 中键按下会启动自动滚动，只在 down 上拦（画布的中键平移由画布自己处理，配置不变）；
 * - 侧键后退 / 前进：Chromium 会把侧键事件交给页面，默认动作在 up 事件之后才执行，
 *   所以只在 up 上拦有效——在 down 或 auxclick 上 preventDefault 拦不住（票 #97 实测）。
 *   鼠标厂商软件把侧键映射成系统 APPCOMMAND 时页面完全收不到事件，那种情况拦不住，见 README 已知限制。
 */
export function blocksMouseButton(phase: MousePhase, button: number): boolean {
  if (phase === "down") return button === 1;
  return button === 3 || button === 4;
}
