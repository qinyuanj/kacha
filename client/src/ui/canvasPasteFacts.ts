// 页面级粘贴的判定与落点（#137）：从 ui/canvasPaste.ts 拆出的纯逻辑，便于单测。
// 分派本身在 core/pageInput 的 dispatchPaste；这里把「这次粘贴读到了什么」与「落点在哪」折成判定要用的形状。
import { dispatchClipboardPaste, type ClipboardContent, type ClipboardPasteAction } from "../core/clipboardDispatch";
import { dispatchPaste, type PasteAction, type PasteFacts, type PastePos } from "../core/pageInput";

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

/** 这一批文件里哪些是能读出内容的图片：读不到内容的（只有名字）算不透明文件。 */
export function splitPastedFiles(files: readonly File[], isImage: (f: File) => boolean): { images: File[]; opaque: number } {
  const images = files.filter((f) => isImage(f) && f.size > 0);
  return { images, opaque: files.length - images.length };
}

/** 剪贴板快照里的文件与计数：桌面壳直接读系统剪贴板时用它，Web 读不到就用 paste 事件带的内容。 */
export function pastedFacts(snapshot: ClipboardContent | null, files: readonly File[], text: string | null, isImage: (f: File) => boolean): PasteFacts {
  const all = snapshot ? snapshot.images : files;
  const { images, opaque } = splitPastedFiles(all, isImage);
  return {
    text: snapshot ? snapshot.text : text,
    images: images.length,
    opaqueFiles: snapshot ? snapshot.readFailureCount : opaque,
  };
}

/** 分派要看的界面状态：与 core 的 PasteContext 同一份（board 恒为 true，见 canvasPaste 的说明）。 */
export interface PasteUiState {
  readOnly: boolean;
  modal: boolean;
  textFocus: boolean;
  hasNodeClip: boolean;
  at: PastePos;
}

/** 粘贴的分派：读到什么、现在是什么状态，落在哪条路上。 */
export function decidePaste(facts: PasteFacts, context: PasteUiState): PasteAction {
  return dispatchPaste(facts, { board: true, ...context });
}

/** 系统剪贴板快照的分派（#129）：桌面壳读到原生快照时用它，语义比事件那条更具体（空 / 超限 / 占用各有提示）。 */
export function decideClipboardPaste(content: ClipboardContent, context: PasteUiState): ClipboardPasteAction {
  return dispatchClipboardPaste(content, { board: true, ...context });
}
