// 页面级粘贴的判定与落点（#137）：从 ui/canvasPaste.ts 拆出的纯逻辑，便于单测。
// 原生快照分派在 core/clipboardDispatch；这里组合界面状态与粘贴落点。
import { dispatchClipboardPaste, type ClipboardContent, type ClipboardPasteAction } from "../core/clipboardDispatch";
import type { PastePos } from "../core/pageInput";

/** 粘贴落点的来源：最后一次指针位置（已换算成画布坐标），没有则用视口中央。 */
export interface PastePlacement {
  /** 指针在画布内的位置（窗口坐标）；没有为 null。 */
  pointer: { x: number; y: number } | null;
  /** 视口中央（画布坐标）。 */
  center(): { x: number; y: number };
  /** 窗口坐标 → 画布坐标。 */
  toFlow(client: { x: number; y: number }): { x: number; y: number };
}

/** 落点（画布坐标，取整）：指针在画布内就用它，否则用视口中央。 */
export function pastePosition(placement: PastePlacement): PastePos {
  const at = placement.pointer ? placement.toFlow(placement.pointer) : placement.center();
  return [Math.round(at.x), Math.round(at.y)];
}

/** 分派要看的界面状态：与 core 的 PasteContext 同一份（board 恒为 true，见 canvasPaste 的说明）。 */
export interface PasteUiState {
  readOnly: boolean;
  modal: boolean;
  textFocus: boolean;
  hasNodeClip: boolean;
  at: PastePos;
}

/** 系统剪贴板快照的分派（#129）：桌面壳读到原生快照时用它，语义比事件那条更具体（空 / 超限 / 占用各有提示）。 */
export function decideClipboardPaste(content: ClipboardContent, context: PasteUiState): ClipboardPasteAction {
  return dispatchClipboardPaste(content, { board: true, ...context });
}
