// 画板工具栏的按钮文字与悬浮提示（#137）：从组件里抽出来的纯文案函数，
// 组件只留摆放与接线；每个函数一个意思，改文案只改这里。
import { TIDY_TEXT } from "./boardText";

/** 没有打开的画板：所有入口都说同一个原因。 */
export const NO_BOARD = "没有打开的画板";

/** 本切片还没做的能力：入口标「尚不可用」，不假装能点（#127）。 */
export const UNAVAILABLE_TEXT = "尚不可用";

/** 悬浮提示：没有画板时统一说「没有打开的画板」，否则给这个入口自己的说明。 */
export function toolbarHint(disabled: boolean, text: string): string {
  return disabled ? NO_BOARD : text;
}

/** 新建生成任务按钮的后缀：生成尚不可用时标出来，否则空。 */
export function newTaskSuffix(generationUnavailable: boolean): string {
  return generationUnavailable ? `（${UNAVAILABLE_TEXT}）` : "";
}

/** 新建生成任务按钮的悬浮提示。 */
export function newTaskHint(generationUnavailable: boolean): string {
  return generationUnavailable ? "生成尚不可用" : "用右侧模型在视口中央新建一个生成任务节点";
}

/** 运行按钮的后缀：选中了就只跑选中的；生成不可用时标出来。 */
export function runSuffix(selectedCount: number, generationUnavailable: boolean): string {
  const selected = selectedCount > 0 ? "选中" : "";
  return `${selected}${newTaskSuffix(generationUnavailable)}`;
}

/** 运行按钮的悬浮提示。 */
export function runHint(generationUnavailable: boolean): string {
  return generationUnavailable ? "生成尚不可用" : "有选中时只运行选中子图，否则运行整个画板中需要运行的任务";
}

/** 撤销按钮的悬浮提示：没有可撤销的操作时说明没有。 */
export function undoHint(undoLabel: string | null): string {
  return undoLabel ? `撤销 ${undoLabel}（Ctrl+Z）` : "没有可撤销的操作";
}

/** 重做按钮的悬浮提示：没有可重做的操作时说明没有。 */
export function redoHint(redoLabel: string | null): string {
  return redoLabel ? `重做 ${redoLabel}（Ctrl+Shift+Z）` : "没有可重做的操作";
}

/** 整理按钮的文字：入口名加上「尚不可用」标记。 */
export function tidyLabel(tidyUnavailable: boolean): string {
  return `${TIDY_TEXT.enter}${newTaskSuffix(tidyUnavailable)}`;
}

/** 整理按钮的悬浮提示：不可用、在整理模式、进入整理模式三种说法。 */
export function tidyHint(tidying: boolean, tidyUnavailable: boolean): string {
  if (tidyUnavailable) return "整理尚不可用";
  return tidying ? "退出整理模式" : "整理模式：看各阶段体量，收掉未定稿的结果";
}
