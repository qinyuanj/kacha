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

function selectedRanges(selection: Selection | null): Range[] {
  return selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
}

function restoreSelection(selection: Selection, ranges: readonly Range[]): void {
  selection.removeAllRanges();
  ranges.forEach((range) => selection.addRange(range));
}

/**
 * 把临时图片选进页面选区并触发复制命令。
 * 同时在命令执行期间观察原生 copy 事件：命令返回成功而事件没来，按「未观察到事件」失败。
 */
function copySelectedImage(image: HTMLImageElement, selection: Selection): ImageCopyFailure | null {
  const range = document.createRange();
  range.selectNode(image);
  selection.removeAllRanges();
  selection.addRange(range);
  let sawCopyEvent = false;
  const onCopy = () => {
    sawCopyEvent = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    const ok = document.execCommand("copy");
    if (!ok) return { kind: "rejected" };
    return sawCopyEvent ? null : { kind: "noEvent" };
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

/**
 * 复制同源图片到系统剪贴板：不读字节、不用 Blob / canvas；让浏览器解码一个临时 img，再经选区与复制命令写剪贴板。
 * 无论成败都移除临时元素并恢复页面原有 DOM 选区；不改画板、不写节点标记、不动应用内节点剪贴板。
 * 返回 null = 成功（命令成功且观察到本次原生 copy 事件）；失败以原因返回，意外异常也收成失败而不是抛出。
 */
export async function copyImageToClipboard(src: string): Promise<ImageCopyFailure | null> {
  const image = document.createElement("img");
  image.style.position = "fixed";
  image.style.left = "-9999px";
  image.style.top = "0";
  image.style.pointerEvents = "none";
  const selection = document.getSelection();
  const previousRanges = selectedRanges(selection);
  document.body.append(image);
  image.src = src;
  try {
    try {
      await image.decode();
    } catch {
      return { kind: "decode" };
    }
    if (!selection) return { kind: "rejected" };
    return copySelectedImage(image, selection);
  } catch (error) {
    return { kind: "exception", detail: errorText(error) };
  } finally {
    image.remove();
    if (selection) restoreSelection(selection, previousRanges);
  }
}
