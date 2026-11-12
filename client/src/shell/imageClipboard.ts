// 图片写入（#115）：同源临时图片元素 + DOM 选区 + legacy 复制命令。
// 成功要同时有两份证据：复制命令返回成功，且同一次操作里观察到对应的原生 copy 事件。
// 只看命令返回值不算成功——命令返回成功而没有原生事件，说明浏览器并没有真的走完复制链。
// 内网 HTTP 下没有 Clipboard API（见 ADR 0021）：不读字节、不用 Blob / canvas、不转码。
import { errorText } from "../core/errors";

/** 复制失败的四类原因：解码失败、复制命令被拒绝、未观察到原生 copy 事件、意外异常。 */
export type ImageCopyFailure =
  | { kind: "decode" }
  | { kind: "rejected" }
  | { kind: "noEvent" }
  | { kind: "exception"; detail: string };

/** 等原生 copy 事件的窗口：浏览器可能晚一点才派发事件（异步派发），这个窗口内观察到都算本次操作的证据。 */
const COPY_EVENT_WINDOW_MS = 200;

function selectedRanges(selection: Selection | null): Range[] {
  return selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
}

function restoreSelection(selection: Selection, ranges: readonly Range[]): void {
  selection.removeAllRanges();
  ranges.forEach((range) => selection.addRange(range));
}

/**
 * 这个 copy 事件是不是「本次复制」的证据：事件发生时页面选区仍罩着我们为这张图设的那一处。
 * 用户同时复制了别的东西（选区已变）或别的组件触发的复制都不算。
 */
function selectionCovers(selection: Selection, image: HTMLImageElement): boolean {
  if (selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  if (container === image.parentNode) return true;
  return container instanceof Node && container.contains(image);
}

/**
 * 把临时图片选进页面选区并触发复制命令。
 * 同时观察原生 copy 事件：命令返回成功而事件没来，按「未观察到事件」失败。
 * 判定绑定本次操作——只认选区仍罩着这张图的事件；事件晚到也在窗口内等它。
 */
async function copySelectedImage(image: HTMLImageElement, selection: Selection): Promise<ImageCopyFailure | null> {
  const range = document.createRange();
  range.selectNode(image);
  selection.removeAllRanges();
  selection.addRange(range);
  let sawCopyEvent = false;
  let resolveSeen: (() => void) | null = null;
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });
  const onCopy = () => {
    if (!selectionCovers(selection, image)) return;
    sawCopyEvent = true;
    resolveSeen?.();
  };
  document.addEventListener("copy", onCopy, true);
  try {
    const ok = document.execCommand("copy");
    if (!ok) return { kind: "rejected" };
    // 事件可能同步派发，也可能晚一步：等它或等窗口结束，别把迟到的证据当没发生。
    await Promise.race([seen, new Promise((resolve) => setTimeout(resolve, COPY_EVENT_WINDOW_MS))]);
    return sawCopyEvent ? null : { kind: "noEvent" };
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

/**
 * 复制同源图片到系统剪贴板：不读字节、不用 Blob / canvas；让浏览器解码一个临时 img，再经选区与复制命令写剪贴板。
 * 无论成败都移除临时元素并恢复页面原有 DOM 选区；不改画板、不写节点标记、不动应用内节点剪贴板。
 * 返回 null = 成功（命令成功且观察到本次原生 copy 事件）；失败以原因返回。
 * 这个函数不抛异常：意外异常也收成失败结果，调用方不必再兜一层。
 */
export async function copyImageToClipboard(src: string): Promise<ImageCopyFailure | null> {
  let image: HTMLImageElement | null = null;
  let selection: Selection | null = null;
  let previousRanges: Range[] = [];
  try {
    selection = document.getSelection();
    previousRanges = selectedRanges(selection);
    image = document.createElement("img");
    image.style.position = "fixed";
    image.style.left = "-9999px";
    image.style.top = "0";
    image.style.pointerEvents = "none";
    document.body.append(image);
    image.src = src;
    try {
      await image.decode();
    } catch {
      return { kind: "decode" };
    }
    if (!selection) return { kind: "rejected" };
    return await copySelectedImage(image, selection);
  } catch (error) {
    return { kind: "exception", detail: errorText(error) };
  } finally {
    image?.remove();
    if (selection) restoreSelection(selection, previousRanges);
  }
}
